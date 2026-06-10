package app.clawkietalkie.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

// Replay of the last assistant reply. Mirror of the web client's
// `src/replay.ts` + the buffered playback paths in `src/voice/tts.ts`:
// prefer the buffered reply audio (recorded from the daemon TTS turn), fall
// back to on-device speech synthesis of the saved reply text.

sealed interface ReplaySelection {
    data class Audio(val audio: BufferedReplyAudio) : ReplaySelection
    data class Text(val text: String) : ReplaySelection
    data class None(val reason: String) : ReplaySelection
}

data class ReplayRequest(
    val audio: BufferedReplyAudio?,
    val text: String?,
    val canSpeakText: Boolean,
)

fun selectReplaySource(request: ReplayRequest): ReplaySelection {
    val audio = request.audio
    if (audio != null && audio.byteLength > 0 && audio.chunks.isNotEmpty()) {
        return ReplaySelection.Audio(audio)
    }
    val text = request.text?.trim()
    if (text.isNullOrEmpty()) return ReplaySelection.None("no_audio_or_text")
    if (request.canSpeakText) return ReplaySelection.Text(text)
    return ReplaySelection.None("text_playback_unavailable")
}

fun canReplayAssistantReply(request: ReplayRequest): Boolean =
    selectReplaySource(request) !is ReplaySelection.None

interface ReplayPlaybackHandle {
    val done: CompletableDeferred<Unit>
    fun currentBands(): DoubleArray?
    fun stop()
}

sealed interface ReplayStartResult {
    data class Started(
        val mode: String, // "audio" | "text"
        val text: String,
        val handle: ReplayPlaybackHandle,
    ) : ReplayStartResult

    data class Failed(val reason: String) : ReplayStartResult
}

fun startReplayAssistantReply(
    request: ReplayRequest,
    startAudio: (BufferedReplyAudio) -> ReplayPlaybackHandle,
    startText: (String) -> ReplayPlaybackHandle,
): ReplayStartResult = when (val selection = selectReplaySource(request)) {
    is ReplaySelection.Audio -> ReplayStartResult.Started(
        mode = "audio",
        text = request.text?.trim() ?: "",
        handle = startAudio(selection.audio),
    )
    is ReplaySelection.Text -> ReplayStartResult.Started(
        mode = "text",
        text = selection.text,
        handle = startText(selection.text),
    )
    is ReplaySelection.None -> ReplayStartResult.Failed(selection.reason)
}

// ---------------------------------------------------------------------------
// Buffered PCM replay playback
// ---------------------------------------------------------------------------

private const val REPLAY_BAND_COUNT = 14

fun startBufferedReplyAudioPlayback(audio: BufferedReplyAudio): ReplayPlaybackHandle {
    val done = CompletableDeferred<Unit>()
    val stopped = AtomicBoolean(false)
    val latestBands = java.util.concurrent.atomic.AtomicReference<DoubleArray?>(null)
    val track = java.util.concurrent.atomic.AtomicReference<AudioTrack?>(null)

    val thread = Thread {
        val playback = runCatching {
            val minBuffer = AudioTrack.getMinBufferSize(
                audio.sampleRate,
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
                        .setSampleRate(audio.sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(max(minBuffer, audio.sampleRate / 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        }.getOrNull()
        if (playback == null) {
            done.completeExceptionally(Exception("audio_unsupported"))
            return@Thread
        }
        track.set(playback)
        runCatching { playback.play() }
        for (chunk in audio.chunks) {
            if (stopped.get()) break
            latestBands.set(mirrorCenterOutBands(
                pcm16ToBandIntensities(chunk, REPLAY_BAND_COUNT, audio.sampleRate),
            ))
            var offset = 0
            while (offset < chunk.size && !stopped.get()) {
                val written = playback.write(chunk, offset, chunk.size - offset)
                if (written <= 0) break
                offset += written
            }
        }
        if (!stopped.get()) {
            // Drain what's buffered before declaring done.
            runCatching { playback.stop() }
            while (!stopped.get() && playback.playState == AudioTrack.PLAYSTATE_PLAYING) {
                try {
                    Thread.sleep(20)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
        runCatching { playback.release() }
        latestBands.set(null)
        done.complete(Unit)
    }
    thread.isDaemon = true
    thread.start()

    return object : ReplayPlaybackHandle {
        override val done: CompletableDeferred<Unit> = done
        override fun currentBands(): DoubleArray? = latestBands.get()
        override fun stop() {
            if (!stopped.compareAndSet(false, true)) return
            track.get()?.let {
                runCatching { it.pause() }
                runCatching { it.flush() }
            }
            thread.interrupt()
            done.complete(Unit)
        }
    }
}

// ---------------------------------------------------------------------------
// On-device speech synthesis fallback (speechSynthesis equivalent)
// ---------------------------------------------------------------------------

object ReplaySpeech {
    @Volatile private var tts: TextToSpeech? = null
    @Volatile private var ready = false

    fun init(context: Context) {
        if (tts != null) return
        synchronized(this) {
            if (tts != null) return
            tts = TextToSpeech(context.applicationContext) { status ->
                ready = status == TextToSpeech.SUCCESS
            }
        }
    }

    fun canSpeak(): Boolean = ready

    fun startSpeak(text: String): ReplayPlaybackHandle {
        val done = CompletableDeferred<Unit>()
        val engine = tts
        if (engine == null || !ready) {
            done.complete(Unit)
            return object : ReplayPlaybackHandle {
                override val done: CompletableDeferred<Unit> = done
                override fun currentBands(): DoubleArray? = null
                override fun stop() {}
            }
        }
        val utteranceId = "clawkie-replay-${System.nanoTime()}"
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) {
                if (id == utteranceId) done.complete(Unit)
            }

            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) {
                if (id == utteranceId) done.complete(Unit)
            }

            override fun onError(id: String?, errorCode: Int) {
                if (id == utteranceId) done.complete(Unit)
            }
        })
        engine.stop()
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        return object : ReplayPlaybackHandle {
            override val done: CompletableDeferred<Unit> = done
            override fun currentBands(): DoubleArray? = null
            override fun stop() {
                runCatching { engine.stop() }
                done.complete(Unit)
            }
        }
    }

    fun shutdown() {
        synchronized(this) {
            tts?.let { runCatching { it.shutdown() } }
            tts = null
            ready = false
        }
    }
}
