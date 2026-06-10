package app.clawkietalkie.voice

import app.clawkietalkie.protocol.ControlMessage
import app.clawkietalkie.protocol.PhoneToDaemon
import kotlinx.coroutines.CompletableDeferred
import kotlin.math.ceil

// Daemon-backed STT. Mirror of the web client's `src/voice/sttDaemon.ts`.
//
// PCM16LE mono 16 kHz frames captured on the phone are sent as binary frames
// on the DataChannel. The daemon records a turn, transcribes it through
// OpenClaw infer, and relays transcript events back as JSON control frames.
// No provider key ever lives on the phone on this path.

class DaemonNotConnectedError : Exception("daemon_not_connected")

interface SttHandle {
    /** Stops the mic, finalizes the turn, resolves with the final transcript. */
    suspend fun stop(): String
    fun cancel()
}

data class SttChunkConfig(val chunkMs: Int, val chunkBytes: Int)

/** Parses the `sttChunkMs` debug param (carried on handoff links). */
fun parseSttChunkMs(raw: String?): SttChunkConfig? {
    if (raw == null || !raw.matches(Regex("^\\d+$"))) return null
    val ms = raw.toIntOrNull() ?: return null
    val chunkBytes = Math.round(ms.toDouble() * SAMPLE_RATE * 2 / 1000).toInt()
    return SttChunkConfig(ms, chunkBytes)
}

class SttStartOptions(
    val sendControl: (ControlMessage) -> Unit,
    val sendBinary: (ByteArray) -> Unit,
    val addControlListener: ((ControlMessage) -> Unit) -> () -> Unit,
    val isConnected: () -> Boolean,
    val onPartial: ((text: String, isFinal: Boolean) -> Unit)? = null,
    val onError: ((reason: String) -> Unit)? = null,
    val onAudioFrame: ((pcm: ByteArray) -> Unit)? = null,
    val audioSource: AudioSource,
    // Debug-only batching of PCM frames before forwarding. When null, each
    // PCM frame is sent individually (the production default).
    val chunkConfig: SttChunkConfig? = null,
)

// Rolling cap on pre-ready frames — bounded memory, enough to preserve the
// first ~1 s of mic audio captured while the daemon STT session gets ready.
val PRE_READY_CAP_FRAMES = ceil(1000.0 / MIC_FRAME_DURATION_MS).toInt()

suspend fun startDaemonStt(opts: SttStartOptions): SttHandle {
    if (!opts.isConnected()) throw DaemonNotConnectedError()

    val audioSource = opts.audioSource

    val ready = CompletableDeferred<Unit>()
    val finalTranscript = CompletableDeferred<String>()

    var serverReady = false

    val detach = opts.addControlListener { msg ->
        when (msg.t) {
            "stt.ready" -> {
                if (!serverReady) {
                    serverReady = true
                    ready.complete(Unit)
                }
            }
            "stt.partial" -> {
                val text = msg.string("text") ?: ""
                val isFinal = msg.boolean("is_final") ?: false
                opts.onPartial?.invoke(text, isFinal)
            }
            "stt.done" -> {
                finalTranscript.complete((msg.string("text") ?: "").trim())
            }
            "stt.error" -> {
                val reason = msg.string("message") ?: "stt_error"
                opts.onError?.invoke(reason)
                if (!serverReady) ready.completeExceptionally(Exception(reason))
                finalTranscript.completeExceptionally(Exception(reason))
            }
            "stt.closed" -> {
                if (!serverReady) ready.completeExceptionally(Exception("stt_closed_before_ready"))
                finalTranscript.completeExceptionally(Exception("stt_closed_before_done"))
            }
        }
    }

    val batcher = opts.chunkConfig?.let { ChunkBatcher(it.chunkBytes, opts.sendBinary) }
    val sendOne: (ByteArray) -> Unit = { pcm ->
        if (batcher != null) batcher.push(pcm) else opts.sendBinary(pcm)
    }

    var forwarding = false
    val preReady = ArrayDeque<ByteArray>()
    val frameLock = Any()
    val onFrame: (ByteArray) -> Unit = { pcm ->
        opts.onAudioFrame?.invoke(pcm)
        synchronized(frameLock) {
            if (!forwarding) {
                preReady.addLast(pcm)
                while (preReady.size > PRE_READY_CAP_FRAMES) preReady.removeFirst()
            } else {
                sendOne(pcm)
            }
        }
    }

    try {
        // Source start may block (AudioRecord init, fixture fetch) — keep it
        // off the main thread.
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            audioSource.start(onFrame)
        }
    } catch (err: Exception) {
        detach()
        throw err
    }

    opts.sendControl(PhoneToDaemon.sttStart())

    try {
        ready.await()
    } catch (err: Exception) {
        audioSource.stop()
        detach()
        opts.sendControl(PhoneToDaemon.sttCancel())
        throw err
    }

    // Flush any frames captured between mic-arm and stt.ready, then switch to
    // live forwarding.
    synchronized(frameLock) {
        for (frame in preReady) sendOne(frame)
        preReady.clear()
        forwarding = true
    }
    audioSource.resume()

    val teardown = {
        audioSource.stop()
        detach()
    }

    return object : SttHandle {
        override suspend fun stop(): String {
            batcher?.flush()
            opts.sendControl(PhoneToDaemon.sttAudioDone())
            try {
                return finalTranscript.await()
            } finally {
                teardown()
            }
        }

        override fun cancel() {
            batcher?.discard()
            finalTranscript.completeExceptionally(Exception("stt_cancelled"))
            opts.sendControl(PhoneToDaemon.sttCancel())
            teardown()
        }
    }
}

internal class ChunkBatcher(
    private val chunkBytes: Int,
    private val sendBinary: (ByteArray) -> Unit,
) {
    private val pending = mutableListOf<ByteArray>()
    private var pendingBytes = 0

    @Synchronized
    fun push(pcm: ByteArray) {
        pending.add(pcm)
        pendingBytes += pcm.size
        if (pendingBytes >= chunkBytes) flushLocked()
    }

    @Synchronized
    fun flush() {
        flushLocked()
    }

    @Synchronized
    fun discard() {
        pending.clear()
        pendingBytes = 0
    }

    private fun flushLocked() {
        if (pendingBytes == 0) {
            pending.clear()
            return
        }
        val out = ByteArray(pendingBytes)
        var offset = 0
        for (part in pending) {
            part.copyInto(out, offset)
            offset += part.size
        }
        pending.clear()
        pendingBytes = 0
        sendBinary(out)
    }
}
