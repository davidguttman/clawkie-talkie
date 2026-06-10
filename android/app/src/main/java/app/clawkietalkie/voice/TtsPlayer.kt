package app.clawkietalkie.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import app.clawkietalkie.protocol.ControlMessage
import app.clawkietalkie.protocol.PhoneToDaemon
import kotlinx.coroutines.CompletableDeferred
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// Daemon-backed TTS playback. Mirror of the web client's `src/voice/tts.ts`.
//
// Two paths, in priority order:
//
//   1) Outbound WebRTC media track. The daemon attaches an audio
//      MediaStreamTrack to the peer connection and pushes 48 kHz / 10 ms
//      frames during TTS. On Android the remote track plays automatically
//      through the WebRTC audio device; we hang an AudioTrackSink off it for
//      the waveform visualizer and reply-replay buffering, and "suppress" it
//      (tap-to-silence) by zeroing the track volume.
//
//   2) Data-channel PCM fallback: PCM16LE frames between `tts.start` and
//      `tts.done`, stitched together through an android.media.AudioTrack.
//
// The phone never touches a provider API key either way.

private const val DEFAULT_SAMPLE_RATE = 24000
private const val OUTPUT_BAND_COUNT = 14

data class BufferedReplyAudio(
    val sampleRate: Int,
    val chunks: List<ByteArray>,
    val byteLength: Int,
    val createdAt: Long,
)

object DaemonTtsAudio {
    private val remoteTrackRef = AtomicReference<org.webrtc.AudioTrack?>(null)
    @Volatile private var suppressed = false
    private val outputBands = AtomicReference<DoubleArray?>(null)
    @Volatile private var lastBuffered: BufferedReplyAudio? = null
    private val replayAvailabilityListeners = CopyOnWriteArrayList<() -> Unit>()
    @Volatile private var remoteSink: Any? = null
    @Volatile private var remoteRecorder: RemoteReplyRecorder? = null
    @Volatile private var remoteFramesLive = false
    @Volatile private var lastRemoteFrameAtMs = 0L

    fun attachRemoteTrack(track: org.webrtc.AudioTrack) {
        detachRemoteTrack()
        remoteTrackRef.set(track)
        applySuppression()
        try {
            val sink = object : org.webrtc.AudioTrackSink {
                override fun onData(
                    audioData: ByteBuffer,
                    bitsPerSample: Int,
                    sampleRate: Int,
                    numberOfChannels: Int,
                    numberOfFrames: Int,
                    absoluteCaptureTimestampMs: Long,
                ) {
                    if (bitsPerSample != 16) return
                    val bytes = ByteArray(audioData.remaining())
                    audioData.duplicate().get(bytes)
                    lastRemoteFrameAtMs = System.currentTimeMillis()
                    remoteFramesLive = true
                    remoteRecorder?.append(bytes, sampleRate)
                    publishRemoteBands(bytes, sampleRate)
                }
            }
            track.addSink(sink)
            remoteSink = sink
        } catch (_: Throwable) {
            // AudioTrackSink unavailable in this libwebrtc build — the track
            // still plays; visualizer/replay degrade gracefully.
            remoteSink = null
        }
    }

    fun detachRemoteTrack() {
        val track = remoteTrackRef.getAndSet(null) ?: return
        val sink = remoteSink
        remoteSink = null
        remoteFramesLive = false
        outputBands.set(null)
        if (sink is org.webrtc.AudioTrackSink) {
            runCatching { track.removeSink(sink) }
        }
    }

    /**
     * True once a daemon audio track is attached. The data-channel PCM
     * fallback consults this to know when to stay out of the way.
     */
    fun isRemoteAudioActive(): Boolean = remoteTrackRef.get() != null

    fun setSuppressed(value: Boolean) {
        suppressed = value
        applySuppression()
    }

    private fun applySuppression() {
        val track = remoteTrackRef.get() ?: return
        runCatching { track.setVolume(if (suppressed) 0.0 else 1.0) }
        runCatching { track.setEnabled(!suppressed) }
    }

    private val remoteBandAccumulator = ByteArrayAccumulator(48_000 / 1000 * 64 * 2)

    private fun publishRemoteBands(bytes: ByteArray, sampleRate: Int) {
        // Aggregate ~64 ms of audio before computing bands so the FFT has
        // enough samples (10 ms WebRTC frames are too short on their own).
        val window = remoteBandAccumulator.push(bytes) ?: return
        outputBands.set(
            mirrorCenterOutBands(
                pcm16ToBandIntensities(window, OUTPUT_BAND_COUNT, sampleRate),
            ),
        )
    }

    /** Analyser equivalent for the active output (remote track) path. */
    fun activeOutputBands(): DoubleArray? {
        if (!remoteFramesLive) return null
        if (System.currentTimeMillis() - lastRemoteFrameAtMs > 250) return null
        return outputBands.get()
    }

    data class RemoteTtsDebugSnapshot(
        val present: Boolean,
        val suppressed: Boolean,
        val sinkAttached: Boolean,
        val framesLive: Boolean,
        val lastFrameAgeMs: Long?,
        val trackState: String?,
    )

    /** Debug-panel equivalent of the web's getRemoteTtsAudioDebugSnapshot. */
    fun debugSnapshot(): RemoteTtsDebugSnapshot {
        val track = remoteTrackRef.get()
        return RemoteTtsDebugSnapshot(
            present = track != null,
            suppressed = suppressed,
            sinkAttached = remoteSink != null,
            framesLive = remoteFramesLive,
            lastFrameAgeMs = if (lastRemoteFrameAtMs > 0) {
                System.currentTimeMillis() - lastRemoteFrameAtMs
            } else null,
            trackState = track?.let { runCatching { it.state().name }.getOrNull() },
        )
    }

    // -- replay buffering ------------------------------------------------

    fun lastBufferedReplyAudio(): BufferedReplyAudio? = lastBuffered

    fun setLastBufferedReplyAudio(audio: BufferedReplyAudio) {
        lastBuffered = audio
        notifyReplayAvailabilityChanged()
    }

    fun startRemoteReplyRecorder(): RemoteReplyRecorder? {
        if (remoteTrackRef.get() == null || remoteSink == null) return null
        val recorder = RemoteReplyRecorder()
        remoteRecorder = recorder
        return recorder
    }

    fun clearRemoteRecorder(recorder: RemoteReplyRecorder) {
        if (remoteRecorder === recorder) remoteRecorder = null
    }

    fun subscribeReplayAvailability(listener: () -> Unit): () -> Unit {
        replayAvailabilityListeners.add(listener)
        return { replayAvailabilityListeners.remove(listener) }
    }

    fun notifyReplayAvailabilityChanged() {
        for (listener in replayAvailabilityListeners) {
            runCatching { listener() }
        }
    }
}

/** Buffers remote-track PCM for the post-turn replay feature. */
class RemoteReplyRecorder {
    private val chunks = mutableListOf<ByteArray>()
    @Volatile private var sampleRate = 48000
    @Volatile private var stopped = false
    private var byteLength = 0

    internal fun append(bytes: ByteArray, rate: Int) {
        if (stopped) return
        synchronized(chunks) {
            sampleRate = rate
            chunks.add(bytes)
            byteLength += bytes.size
        }
    }

    fun stop(): BufferedReplyAudio? {
        stopped = true
        DaemonTtsAudio.clearRemoteRecorder(this)
        synchronized(chunks) {
            if (byteLength <= 0) return null
            return BufferedReplyAudio(
                sampleRate = sampleRate,
                chunks = chunks.toList(),
                byteLength = byteLength,
                createdAt = System.currentTimeMillis(),
            )
        }
    }

    fun cancel() {
        stopped = true
        DaemonTtsAudio.clearRemoteRecorder(this)
        synchronized(chunks) { chunks.clear() }
    }
}

private class ByteArrayAccumulator(private val windowBytes: Int) {
    private var pending = ByteArray(0)

    @Synchronized
    fun push(bytes: ByteArray): ByteArray? {
        pending += bytes
        if (pending.size < windowBytes) return null
        val window = pending.copyOfRange(pending.size - windowBytes, pending.size)
        pending = ByteArray(0)
        return window
    }
}

// ---------------------------------------------------------------------------
// TTS turn playback
// ---------------------------------------------------------------------------

interface TtsHandle {
    val done: CompletableDeferred<Unit>
    val error: String?

    /** Current playback band intensities for the fallback PCM path. */
    fun currentBands(): DoubleArray?

    /** Feed replayed daemon control messages into the same lifecycle. */
    fun handleControlMessage(msg: ControlMessage)
    fun stop(cancelRemote: Boolean = true)
}

class TtsPlayerOptions(
    val addControlListener: ((ControlMessage) -> Unit) -> () -> Unit,
    val addBinaryListener: ((ByteArray) -> Unit) -> () -> Unit,
    val sendControl: (ControlMessage) -> Unit,
    val initialControlMessage: ControlMessage? = null,
)

private val drainScheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "tts-drain").apply { isDaemon = true }
}

/**
 * Start listening for a single TTS turn from the daemon. The returned
 * handle's `done` completes when local playback has finished: PCM waits for
 * the buffered audio drain, while WebRTC remote-track playback approximates
 * the turn end from daemon `tts.done` plus recorder cleanup.
 */
fun playDaemonTts(opts: TtsPlayerOptions): TtsHandle {
    val done = CompletableDeferred<Unit>()

    val state = object {
        var finished = false
        var stopped = false
        var error: String? = null
        var audioTrack: AudioTrack? = null
        var sampleRate = DEFAULT_SAMPLE_RATE
        var started = false
        var totalFramesWritten = 0L
        var writer: java.util.concurrent.ExecutorService? = null
        var drainTimer: ScheduledFuture<*>? = null
        var remoteRecorder: RemoteReplyRecorder? = null
        val replayChunks = mutableListOf<ByteArray>()
        var replayBytes = 0
        var forcePcmPlayback = false
        var latestBands: DoubleArray? = null
        var lastBandsAt = 0L
    }
    val lock = Any()

    var detachControl: () -> Unit = {}
    var detachBinary: () -> Unit = {}

    fun detachListeners() {
        val control = detachControl
        val binary = detachBinary
        detachControl = {}
        detachBinary = {}
        control()
        binary()
    }

    fun finishCleanup() {
        state.drainTimer?.cancel(false)
        state.drainTimer = null
        state.writer?.shutdownNow()
        state.writer = null
        state.audioTrack?.let { track ->
            runCatching { track.pause() }
            runCatching { track.flush() }
            runCatching { track.release() }
        }
        state.audioTrack = null
        state.latestBands = null
        detachListeners()
        done.complete(Unit)
    }

    fun finish(err: String? = null) {
        synchronized(lock) {
            if (state.finished) return
            state.finished = true
            if (err != null && state.error == null) state.error = err
            val remoteRecorder = state.remoteRecorder
            state.remoteRecorder = null
            if (remoteRecorder != null && (err != null || state.stopped)) {
                remoteRecorder.cancel()
            }
            if (err == null && !state.stopped && remoteRecorder != null) {
                remoteRecorder.stop()?.let { DaemonTtsAudio.setLastBufferedReplyAudio(it) }
                finishCleanup()
                return
            }
            if (err == null && !state.stopped && state.replayChunks.isNotEmpty()) {
                DaemonTtsAudio.setLastBufferedReplyAudio(
                    BufferedReplyAudio(
                        sampleRate = state.sampleRate,
                        chunks = state.replayChunks.map { it.copyOf() },
                        byteLength = state.replayBytes,
                        createdAt = System.currentTimeMillis(),
                    ),
                )
            }
            finishCleanup()
        }
    }

    // Poll playback head until everything written has been rendered, then
    // finish (the analogue of the web client's scheduled buffer-drain wait).
    fun scheduleDrainFinish() {
        synchronized(lock) {
            if (state.finished) return
            val track = state.audioTrack
            val writer = state.writer
            if (track == null || writer == null) {
                finish()
                return
            }
            state.drainTimer?.cancel(false)
            // Wait for queued writer work first, then for the head position.
            writer.execute {
                val poll = object : Runnable {
                    override fun run() {
                        synchronized(lock) {
                            if (state.finished || state.stopped) return
                            val active = state.audioTrack ?: run {
                                finish()
                                return
                            }
                            val head = runCatching { active.playbackHeadPosition.toLong() }
                                .getOrDefault(Long.MAX_VALUE)
                            if (head >= state.totalFramesWritten) {
                                finish()
                            } else {
                                state.drainTimer = drainScheduler.schedule(this, 50, TimeUnit.MILLISECONDS)
                            }
                        }
                    }
                }
                synchronized(lock) {
                    if (!state.finished && !state.stopped) {
                        state.drainTimer = drainScheduler.schedule(poll, 50, TimeUnit.MILLISECONDS)
                    }
                }
            }
        }
    }

    fun initAudio(sampleRate: Int) {
        synchronized(lock) {
            state.sampleRate = sampleRate
            if (state.audioTrack != null) return
            val track = buildPcmAudioTrack(sampleRate) ?: run {
                finish("audio_unsupported")
                return
            }
            state.audioTrack = track
            state.totalFramesWritten = 0L
            state.writer = Executors.newSingleThreadExecutor { runnable ->
                Thread(runnable, "tts-pcm-writer").apply { isDaemon = true }
            }
            runCatching { track.play() }
        }
    }

    fun handleControl(msg: ControlMessage) {
        synchronized(lock) {
            if (state.finished || state.stopped) return
            when (msg.t) {
                "tts.start" -> {
                    state.started = true
                    state.drainTimer?.cancel(false)
                    state.drainTimer = null
                    DaemonTtsAudio.setSuppressed(false)
                    state.replayChunks.clear()
                    state.replayBytes = 0
                    state.forcePcmPlayback = msg.boolean("buffered") == true
                    state.remoteRecorder?.cancel()
                    state.remoteRecorder =
                        if (state.forcePcmPlayback) null else DaemonTtsAudio.startRemoteReplyRecorder()
                    val sr = msg.int("sample_rate") ?: DEFAULT_SAMPLE_RATE
                    initAudio(sr)
                }
                "tts.done" -> scheduleDrainFinish()
                "tts.error" -> {
                    val message = msg.string("message") ?: "openclaw_infer_tts_failed"
                    finish(message)
                }
            }
        }
    }

    detachControl = opts.addControlListener { msg -> handleControl(msg) }

    detachBinary = opts.addBinaryListener { bytes ->
        synchronized(lock) {
            if (state.finished || state.stopped) return@addBinaryListener
            // When the daemon's WebRTC audio track is attached, the remote
            // playback is the source of truth. Ignore PCM frames so we don't
            // double-play with subtle drift.
            if (DaemonTtsAudio.isRemoteAudioActive() && !state.forcePcmPlayback) return@addBinaryListener
            if (state.audioTrack == null) initAudio(state.sampleRate)
            val track = state.audioTrack ?: return@addBinaryListener
            val writer = state.writer ?: return@addBinaryListener
            state.replayChunks.add(bytes.copyOf())
            state.replayBytes += bytes.size
            // Blocking writes off the data-channel thread; non-blocking writes
            // silently drop the remainder once the track buffer fills, which
            // truncates buffered turns delivered faster than real time.
            val chunk = bytes.copyOf()
            runCatching {
                writer.execute {
                    var offset = 0
                    while (offset < chunk.size) {
                        val stopNow = synchronized(lock) { state.finished || state.stopped }
                        if (stopNow) return@execute
                        val written = runCatching {
                            track.write(chunk, offset, chunk.size - offset, AudioTrack.WRITE_BLOCKING)
                        }.getOrDefault(-1)
                        if (written <= 0) return@execute
                        offset += written
                        synchronized(lock) { state.totalFramesWritten += written / 2 }
                    }
                }
            }
            state.latestBands = mirrorCenterOutBands(
                pcm16ToBandIntensities(bytes, OUTPUT_BAND_COUNT, state.sampleRate),
            )
            state.lastBandsAt = System.currentTimeMillis()
        }
    }

    opts.initialControlMessage?.let { handleControl(it) }

    return object : TtsHandle {
        override val done: CompletableDeferred<Unit> = done
        override val error: String?
            get() = state.error

        override fun currentBands(): DoubleArray? {
            val bands = state.latestBands ?: return null
            if (System.currentTimeMillis() - state.lastBandsAt > 250) return null
            return bands
        }

        override fun handleControlMessage(msg: ControlMessage) {
            handleControl(msg)
        }

        override fun stop(cancelRemote: Boolean) {
            synchronized(lock) {
                if (state.stopped) return
                state.stopped = true
            }
            DaemonTtsAudio.setSuppressed(true)
            if (cancelRemote) {
                runCatching { opts.sendControl(PhoneToDaemon.replyCancel()) }
            }
            finish()
        }
    }
}

private fun buildPcmAudioTrack(sampleRate: Int): AudioTrack? = runCatching {
    val minBuffer = AudioTrack.getMinBufferSize(
        sampleRate,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
    )
    AudioTrack.Builder()
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setAudioFormat(
            AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
        )
        .setBufferSizeInBytes(max(minBuffer, sampleRate * 2))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
}.getOrNull()

// ---------------------------------------------------------------------------
// PTT press tone — audible confirmation that the audio path works.
// ---------------------------------------------------------------------------

fun playPttPressTone() {
    Thread {
        runCatching {
            val sampleRate = 48000
            val durationMs = 180
            val samples = sampleRate * durationMs / 1000
            val pcm = ShortArray(samples)
            for (i in 0 until samples) {
                val t = i.toDouble() / sampleRate
                // Envelope: fast exponential attack to 0.22 by 12 ms, decay to
                // ~0 at 160 ms (mirrors the WebAudio gain ramps).
                val attack = min(1.0, t / 0.012)
                val decay = if (t <= 0.012) 1.0 else Math.exp(-(t - 0.012) / 0.045)
                val amplitude = 0.22 * attack * decay
                pcm[i] = (sin(2 * Math.PI * 880.0 * t) * amplitude * 32767).toInt().toShort()
            }
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(pcm.size * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            val buffer = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            buffer.asShortBuffer().put(pcm)
            track.write(buffer.array(), 0, buffer.array().size)
            track.play()
            Thread.sleep(durationMs + 60L)
            runCatching { track.release() }
        }
    }.apply {
        isDaemon = true
        start()
    }
}
