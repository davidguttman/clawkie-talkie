package app.clawkietalkie.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

// Audio-source boundary for daemon STT. Mirror of the web client's
// `src/voice/audioSource.ts`: PCM16LE mono 16 kHz frames of 1024 samples
// (~64 ms). The underlying recorder is acquired once and reused across PTT
// turns (the web client keeps the MediaStream alive between turns so the
// browser doesn't re-prompt; here it avoids repeated AudioRecord startup
// latency and keeps the analyser warm). Only the per-turn reader is created
// and torn down on each start/stop.

const val SAMPLE_RATE = 16000
const val MIC_BUFFER_SIZE = 1024
const val MIC_FRAME_DURATION_MS = MIC_BUFFER_SIZE * 1000.0 / SAMPLE_RATE

class MicPermissionError(cause: Throwable? = null) : Exception("mic_denied", cause)

interface AudioSource {
    val kind: String
    @Throws(Exception::class)
    fun start(onFrame: (ByteArray) -> Unit)
    fun resume() {}
    fun stop()
}

object MicAudio {
    private var cachedRecord: AudioRecord? = null
    private val latestMicBands = java.util.concurrent.atomic.AtomicReference<DoubleArray?>(null)
    @Volatile private var capturing = false
    // Capture ownership generation: a stale turn's deferred stop() must not
    // halt a newer turn's recording on the shared recorder.
    private var captureGeneration = 0L

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    @Synchronized
    @Throws(MicPermissionError::class)
    fun acquire(context: Context): AudioRecord {
        val existing = cachedRecord
        if (existing != null && existing.state == AudioRecord.STATE_INITIALIZED) return existing
        if (!hasPermission(context)) throw MicPermissionError()
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                max(minBuffer, MIC_BUFFER_SIZE * 2 * 4),
            )
        } catch (err: SecurityException) {
            throw MicPermissionError(err)
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw MicPermissionError()
        }
        cachedRecord = record
        return record
    }

    /** Begin a capture turn; returns the ownership token for [stopCapture]. */
    @Synchronized
    fun beginCapture(): Long = ++captureGeneration

    /** Stop the shared recorder only if [token] still owns the capture. */
    @Synchronized
    fun stopCapture(token: Long) {
        if (token != captureGeneration) return
        cachedRecord?.let { runCatching { it.stop() } }
    }

    /** Latest mic band intensities for the visualizer (analyser equivalent). */
    fun activeMicBands(): DoubleArray? = if (capturing) latestMicBands.get() else null

    internal fun publishMicBands(bands: DoubleArray?) {
        latestMicBands.set(bands)
    }

    internal fun setCapturing(value: Boolean) {
        capturing = value
        if (!value) latestMicBands.set(null)
    }

    /**
     * Deliberate teardown for app shutdown / cancel. Releases the underlying
     * recorder, which is what clears the OS mic-in-use indicator.
     */
    @Synchronized
    fun release() {
        val record = cachedRecord
        cachedRecord = null
        capturing = false
        latestMicBands.set(null)
        if (record != null) {
            runCatching { record.stop() }
            runCatching { record.release() }
        }
    }
}

/**
 * Deterministic fixture source backed by a fetchable PCM/WAV asset, selected
 * by the `audio-fixture` query param on a handoff link. Fetches and decodes
 * on start but defers emission to resume() so the audio is paced in real
 * time from stt.ready (mirror of `createFixtureAudioSource`).
 */
class FixtureAudioSource(private val url: String) : AudioSource {
    override val kind = "fixture"

    private val fixtureFrameMs = 100L
    private val fixtureFrameBytes = (fixtureFrameMs * SAMPLE_RATE * 2 / 1000).toInt()

    @Volatile private var pcm: ByteArray? = null
    @Volatile private var stopped = false
    @Volatile private var onFrame: ((ByteArray) -> Unit)? = null
    private var thread: Thread? = null

    override fun start(onFrame: (ByteArray) -> Unit) {
        this.onFrame = onFrame
        val client = okhttp3.OkHttpClient()
        val request = okhttp3.Request.Builder().url(url).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw Exception("fixture_fetch_${response.code}")
            pcm = parseFixture(response.body?.bytes() ?: ByteArray(0))
        }
    }

    override fun resume() {
        val data = pcm ?: return
        val callback = onFrame ?: return
        if (stopped) return
        val runner = Thread {
            var offset = 0
            while (!stopped && offset < data.size) {
                val end = minOf(offset + fixtureFrameBytes, data.size)
                callback(data.copyOfRange(offset, end))
                offset = end
                // Fixture exhausted → stop emitting; do NOT loop or pad with
                // silence (silence tails can finalize empty transcripts).
                if (offset >= data.size) break
                try {
                    Thread.sleep(fixtureFrameMs)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
        thread = runner.also {
            it.isDaemon = true
            it.start()
        }
    }

    override fun stop() {
        stopped = true
        thread?.interrupt()
        thread = null
        onFrame = null
    }

    companion object {
        /**
         * WAV parser: return the contents of the `data` chunk as raw bytes.
         * Inputs that don't start with RIFF are treated as raw PCM16LE.
         * Chunk sizes are unsigned 32-bit and may be the streaming-WAV
         * sentinel 0x7FFFFFFF / 0xFFFFFFFF — use Long math and clamp to the
         * buffer (the web's ArrayBuffer.slice clamps the same way).
         */
        fun parseFixture(buffer: ByteArray): ByteArray {
            if (buffer.size < 12) return buffer
            val isRiff = buffer[0] == 'R'.code.toByte() && buffer[1] == 'I'.code.toByte() &&
                buffer[2] == 'F'.code.toByte() && buffer[3] == 'F'.code.toByte() &&
                buffer[8] == 'W'.code.toByte() && buffer[9] == 'A'.code.toByte() &&
                buffer[10] == 'V'.code.toByte() && buffer[11] == 'E'.code.toByte()
            if (!isRiff) return buffer
            var offset = 12L
            while (offset + 8 <= buffer.size) {
                val base = offset.toInt()
                val chunkId = String(buffer, base, 4, Charsets.US_ASCII)
                val chunkSize = (((buffer[base + 4].toLong() and 0xff)) or
                    ((buffer[base + 5].toLong() and 0xff) shl 8) or
                    ((buffer[base + 6].toLong() and 0xff) shl 16) or
                    ((buffer[base + 7].toLong() and 0xff) shl 24))
                if (chunkId == "data") {
                    val start = offset + 8
                    val end = minOf(start + chunkSize, buffer.size.toLong())
                    if (end <= start) return ByteArray(0)
                    return buffer.copyOfRange(start.toInt(), end.toInt())
                }
                offset += 8 + chunkSize
            }
            throw Exception("no_data_chunk_in_wav")
        }
    }
}

class MicAudioSource(private val context: Context) : AudioSource {
    override val kind = "mic"

    private val stopped = AtomicBoolean(false)
    private var thread: Thread? = null
    private var captureToken = 0L

    @Throws(MicPermissionError::class)
    override fun start(onFrame: (ByteArray) -> Unit) {
        val record = MicAudio.acquire(context)
        captureToken = MicAudio.beginCapture()
        try {
            record.startRecording()
        } catch (err: IllegalStateException) {
            throw MicPermissionError(err)
        }
        MicAudio.setCapturing(true)
        val reader = Runnable {
            val frame = ByteArray(MIC_BUFFER_SIZE * 2)
            while (!stopped.get()) {
                var offset = 0
                while (offset < frame.size && !stopped.get()) {
                    val read = record.read(frame, offset, frame.size - offset)
                    if (read <= 0) {
                        if (stopped.get()) return@Runnable
                        // Transient failure; avoid a hot spin.
                        try {
                            Thread.sleep(10)
                        } catch (_: InterruptedException) {
                            return@Runnable
                        }
                        continue
                    }
                    offset += read
                }
                if (stopped.get()) return@Runnable
                onFrame(frame.copyOf())
            }
        }
        thread = Thread(reader, "mic-frames").also {
            it.isDaemon = true
            it.start()
        }
    }

    override fun stop() {
        // Stop only the per-turn reader. Leave the cached recorder alive so
        // the next PTT starts instantly (mirrors the web client keeping the
        // mic stream warm between turns). The ownership token ensures a
        // stale deferred stop can't halt a newer turn's recording.
        if (!stopped.compareAndSet(false, true)) return
        MicAudio.setCapturing(false)
        thread?.interrupt()
        thread = null
        MicAudio.stopCapture(captureToken)
    }
}
