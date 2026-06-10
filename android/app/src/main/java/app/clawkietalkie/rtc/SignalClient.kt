package app.clawkietalkie.rtc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.random.Random

// Signaling client — talks to a rambly-style server via SSE (subscribe) and
// HTTP POST (send signal). Mirror of the web client's `src/rtc/signal.ts`.

data class SignalEvent(val from: String, val to: String, val data: JsonObject)

interface SignalListener {
    fun onOpen() {}
    fun onAnnounce(peerId: String) {}
    fun onSignal(event: SignalEvent) {}
    fun onError(error: Throwable) {}
    fun onClose() {}
}

class SignalClient(
    signalServer: String,
    val peerId: String,
    private val roomName: String,
    private val listener: SignalListener,
    private val baseReconnectDelayMs: Long = 1_000,
    private val maxReconnectDelayMs: Long = 30_000,
    client: OkHttpClient? = null,
) {
    private val signalServer = signalServer.trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true }

    private val http: OkHttpClient = (client ?: OkHttpClient())
        .newBuilder()
        // SSE stream stays open indefinitely; the server pings every ~30s.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val closed = AtomicBoolean(false)
    @Volatile private var reconnectAttempt = 0
    @Volatile private var activeCall: Call? = null
    @Volatile private var reconnectThread: Thread? = null

    fun subscribe() {
        if (closed.get()) return
        connect()
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        reconnectThread?.interrupt()
        reconnectThread = null
        activeCall?.cancel()
        activeCall = null
        listener.onClose()
    }

    /** POST a WebRTC signal payload to a peer in the room. Throws on failure. */
    @Throws(IOException::class)
    fun sendSignal(to: String, data: JsonObject) {
        val url = "$signalServer/signal?room=${urlEncode(roomName)}"
        val body = buildJsonObject {
            put("from", peerId)
            put("to", to)
            put("data", data)
        }
        val request = Request.Builder()
            .url(url)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) {
                throw IOException("sendSignal failed: ${res.code} ${res.message}")
            }
        }
    }

    private fun connect() {
        if (closed.get()) return
        val url = "$signalServer/subscribe?id=${urlEncode(peerId)}&room=${urlEncode(roomName)}"
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .build()
        val call = http.newCall(request)
        activeCall = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (closed.get() || call.isCanceled()) return
                listener.onError(e)
                scheduleReconnect()
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { res ->
                    if (!res.isSuccessful) {
                        if (!closed.get()) {
                            listener.onError(IOException("SSE subscribe failed: ${res.code} ${res.message}"))
                            scheduleReconnect()
                        }
                        return
                    }
                    val body = res.body ?: run {
                        if (!closed.get()) {
                            listener.onError(IOException("SSE response has no body"))
                            scheduleReconnect()
                        }
                        return
                    }
                    reconnectAttempt = 0
                    listener.onOpen()
                    try {
                        parseSseStream(body.source()) { event, data ->
                            if (closed.get()) return@parseSseStream false
                            handleSseMessage(event, data)
                            true
                        }
                    } catch (err: IOException) {
                        if (closed.get() || call.isCanceled()) return
                        listener.onError(err)
                        scheduleReconnect()
                        return
                    }
                    if (!closed.get()) scheduleReconnect()
                }
            }
        })
    }

    private fun handleSseMessage(event: String, data: String) {
        try {
            when (event) {
                "announce" -> {
                    val announced = data.trim()
                    if (announced.isNotEmpty() && announced != peerId) listener.onAnnounce(announced)
                }
                "signal" -> {
                    val payload = json.parseToJsonElement(data) as? JsonObject ?: return
                    val from = (payload["from"] as? JsonPrimitive)?.content ?: return
                    val to = (payload["to"] as? JsonPrimitive)?.content ?: return
                    val signal = payload["data"] as? JsonObject ?: return
                    if (to == peerId) listener.onSignal(SignalEvent(from, to, signal))
                }
            }
        } catch (_: Exception) {
            // Malformed payload — skip
        }
    }

    private fun scheduleReconnect() {
        if (closed.get()) return
        val delay = min(
            baseReconnectDelayMs * (1L shl min(reconnectAttempt, 20)),
            maxReconnectDelayMs,
        )
        val jitter = (delay * (0.75 + Random.nextDouble() * 0.5)).toLong()
        reconnectAttempt++
        val thread = Thread {
            try {
                Thread.sleep(jitter)
            } catch (_: InterruptedException) {
                return@Thread
            }
            if (!closed.get()) connect()
        }
        thread.isDaemon = true
        reconnectThread = thread
        thread.start()
    }

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

    companion object {
        /**
         * Minimal SSE line-protocol parser; mirrors the web client's
         * `parseSseStream`. Calls [onEvent] per complete event; returning
         * false stops parsing.
         */
        fun parseSseStream(
            source: okio.BufferedSource,
            onEvent: (event: String, data: String) -> Boolean,
        ) {
            var currentEvent = "message"
            val currentData = mutableListOf<String>()
            while (true) {
                val line = source.readUtf8Line() ?: break
                if (line.isEmpty()) {
                    if (currentData.isNotEmpty()) {
                        if (!onEvent(currentEvent, currentData.joinToString("\n"))) return
                    }
                    currentEvent = "message"
                    currentData.clear()
                } else if (line.startsWith("event:")) {
                    currentEvent = line.substring(6).trim()
                } else if (line.startsWith("data:")) {
                    currentData.add(line.substring(5).trimStart())
                }
            }
            if (currentData.isNotEmpty()) onEvent(currentEvent, currentData.joinToString("\n"))
        }
    }
}
