@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.clawkietalkie.voice

import android.content.Context
import android.media.audiofx.Visualizer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import app.clawkietalkie.BuildConfig
import app.clawkietalkie.storage.MusicSettings
import app.clawkietalkie.storage.MusicVolumeLevel
import app.clawkietalkie.storage.Storage
import java.io.File
import java.net.URLEncoder
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

// Hold music during the "thinking" state. Mirror of the web client's
// `src/voice/holdMusic.ts` + `holdMusicCatalog.ts`.
//
// The web client plays pre-processed MP3s (AM-radio effects, hiss and
// crackle baked in) from its hosting origin in three discrete loudness
// levels, with matching unprocessed "original" variants. The Android port
// streams the same baked files from the hosted origin through a disk cache.
// Both the processed and original elements play in sync; the `effects`
// setting just flips which one is audible, so toggling is instant.

object HoldMusicCatalog {
    val TRACKS: List<String> = listOf(
        "Dial Tone Reverie.mp3",
        "Dockside Hold.mp3",
        "Looped Hold Tone.mp3",
        "Maré de Espera.mp3",
        "Muted Waiting Room.mp3",
        "Palm Reader Queue.mp3",
        "Paper Cup Loop.mp3",
        "Pehli Dastak.mp3",
        "Pixel Queue.mp3",
        "Poolside Hold.mp3",
        "Rotary Hush.mp3",
        "Shelf Cue Drift.mp3",
        "Soft Hold Tone.mp3",
    )

    fun trackLabel(track: String): String = track.replace(Regex("\\.[^.]+$"), "")

    fun processedUrl(track: String, volumeLevel: MusicVolumeLevel = MusicVolumeLevel.MEDIUM): String =
        "${BuildConfig.WEB_ORIGIN}/music${volumeSuffix(volumeLevel)}/${encodePath(track)}"

    fun originalUrl(track: String, volumeLevel: MusicVolumeLevel = MusicVolumeLevel.MEDIUM): String =
        "${BuildConfig.WEB_ORIGIN}/music-original${volumeSuffix(volumeLevel)}/${encodePath(track)}"

    private fun volumeSuffix(volumeLevel: MusicVolumeLevel): String = when (volumeLevel) {
        MusicVolumeLevel.LOW -> "-low"
        MusicVolumeLevel.HIGH -> "-high"
        MusicVolumeLevel.MEDIUM -> ""
    }

    private fun encodePath(value: String): String =
        URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}

fun pickRandomStartTimeMs(durationMs: Long, random: Random = Random.Default): Long {
    if (durationMs <= 0) return 1
    val fraction = 0.15 + random.nextDouble() * 0.35
    return max(1L, min(durationMs - 1, (durationMs * fraction).toLong()))
}

object HoldMusic {
    private const val HOLD_MUSIC_BAND_COUNT = 14
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var appContext: Context
    private lateinit var storage: Storage
    private var cache: SimpleCache? = null

    @Volatile private var currentTrack: String? = null
    private val currentTrackListeners = CopyOnWriteArraySet<(String?) -> Unit>()

    @Volatile private var mutedState: Boolean? = null
    private val muteListeners = CopyOnWriteArraySet<(Boolean) -> Unit>()

    internal val desiredControllers = CopyOnWriteArraySet<HoldMusicController>()
    internal val activeSessions = CopyOnWriteArraySet<HoldMusicSession>()

    private var shuffledDeck = mutableListOf<String>()
    private var lastTrack: String? = null
    internal var preloaded: PreloadedHoldMusicTrack? = null

    private val activeBands = AtomicReference<DoubleArray?>(null)
    @Volatile private var bandsLive = false

    fun init(context: Context, storage: Storage) {
        appContext = context.applicationContext
        this.storage = storage
        runCatching {
            cache = SimpleCache(
                File(appContext.cacheDir, "hold-music"),
                LeastRecentlyUsedCacheEvictor(256L * 1024 * 1024),
                StandaloneDatabaseProvider(appContext),
            )
        }
        mainHandler.post { preloadNextTrack() }
    }

    internal fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    internal fun buildPlayer(url: String): ExoPlayer {
        val httpFactory = DefaultHttpDataSource.Factory().setUserAgent("clawkie-talkie-android")
        val upstream = DefaultDataSource.Factory(appContext, httpFactory)
        val dataSourceFactory = cache?.let {
            CacheDataSource.Factory()
                .setCache(it)
                .setUpstreamDataSourceFactory(upstream)
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        } ?: upstream
        val player = ExoPlayer.Builder(appContext)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .build()
        player.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            false,
        )
        player.repeatMode = Player.REPEAT_MODE_ONE
        player.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
        player.prepare()
        return player
    }

    // ------------------------------------------------------------------
    // Current track + visualizer state
    // ------------------------------------------------------------------

    fun getCurrentTrack(): String? = currentTrack

    fun subscribeCurrentTrack(listener: (String?) -> Unit): () -> Unit {
        currentTrackListeners.add(listener)
        return { currentTrackListeners.remove(listener) }
    }

    internal fun publishCurrentTrack(track: String?) {
        currentTrack = track
        for (listener in currentTrackListeners) {
            runCatching { listener(track) }
        }
    }

    /** Analyser equivalent: latest band intensities from the audible player. */
    fun activeHoldMusicBands(): DoubleArray? = if (bandsLive) activeBands.get() else null

    internal fun publishBands(bands: DoubleArray?) {
        activeBands.set(bands)
        bandsLive = bands != null
    }

    internal fun bandsFromWaveform(waveform: ByteArray, samplingRateMilliHz: Int): DoubleArray {
        // Visualizer waveform bytes are unsigned 8-bit; widen to PCM16LE and
        // reuse the shared band math.
        val pcm = ByteArray(waveform.size * 2)
        for (i in waveform.indices) {
            val sample = (((waveform[i].toInt() and 0xff) - 128) shl 8)
            pcm[i * 2] = (sample and 0xff).toByte()
            pcm[i * 2 + 1] = ((sample shr 8) and 0xff).toByte()
        }
        val sampleRate = max(8000, samplingRateMilliHz / 1000)
        return mirrorCenterOutBands(
            pcm16ToBandIntensities(pcm, HOLD_MUSIC_BAND_COUNT, sampleRate),
        )
    }

    // ------------------------------------------------------------------
    // Mute state (shared across controllers; persisted)
    // ------------------------------------------------------------------

    fun getMuted(): Boolean {
        val current = mutedState
        if (current != null) return current
        val loaded = storage.loadMusicSettings().muted
        mutedState = loaded
        return loaded
    }

    fun setMuted(muted: Boolean) {
        if (getMuted() == muted) return
        storage.saveMusicSettings(storage.loadMusicSettings().copy(muted = muted))
        publishMuted(muted)
    }

    fun subscribeMuted(listener: (Boolean) -> Unit): () -> Unit {
        muteListeners.add(listener)
        return { muteListeners.remove(listener) }
    }

    internal fun publishMuted(muted: Boolean) {
        if (mutedState == muted) return
        mutedState = muted
        onMain {
            for (session in activeSessions) session.applyMute(muted)
        }
        for (listener in muteListeners) {
            runCatching { listener(muted) }
        }
    }

    /** Apply a whole MusicSettings change (mirrors setHoldMusicSettings). */
    fun setSettings(settings: MusicSettings) {
        val before = storage.loadMusicSettings()
        storage.saveMusicSettings(settings)
        val after = storage.loadMusicSettings()
        publishMuted(after.muted)

        val effectsChanged = before.effects != after.effects
        val volumeLevelChanged = before.volumeLevel != after.volumeLevel
        val disabledTracksChanged = before.disabledTracks.toSet() != after.disabledTracks.toSet()
        if (effectsChanged || volumeLevelChanged || disabledTracksChanged) {
            onMain {
                resetPreloadedIfNeeded(after)
                for (controller in desiredControllers.toList()) {
                    controller.applySettingsChange(
                        after,
                        effectsChanged = effectsChanged,
                        volumeLevelChanged = volumeLevelChanged,
                        disabledTracksChanged = disabledTracksChanged,
                    )
                }
            }
        }
    }

    fun loadMusicSettings(): MusicSettings = storage.loadMusicSettings()

    // ------------------------------------------------------------------
    // Track deck + preloading (mirrors the shuffled-deck behavior)
    // ------------------------------------------------------------------

    internal fun enabledTracks(settings: MusicSettings): List<String> {
        val disabled = settings.disabledTracks.toSet()
        return HoldMusicCatalog.TRACKS.filter { it !in disabled }
    }

    internal fun takeNextTrack(settings: MusicSettings): String? {
        val tracks = enabledTracks(settings)
        if (tracks.isEmpty()) return null
        if (shuffledDeck.isEmpty() || shuffledDeck.any { it !in tracks }) {
            shuffledDeck = createShuffledDeck(tracks).toMutableList()
        }
        val track = shuffledDeck.removeFirstOrNull()
        if (track != null) lastTrack = track
        return track
    }

    private fun createShuffledDeck(tracks: List<String>): List<String> {
        val deck = tracks.toMutableList()
        for (i in deck.indices.reversed()) {
            if (i == 0) break
            val j = Random.nextInt(i + 1)
            val tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp
        }
        if (deck.size > 1 && deck[0] == lastTrack) {
            val swapIndex = deck.indices.firstOrNull { it > 0 && deck[it] != lastTrack } ?: -1
            if (swapIndex > 0) {
                val tmp = deck[0]; deck[0] = deck[swapIndex]; deck[swapIndex] = tmp
            }
        }
        return deck
    }

    internal fun consumePreloadedTrack(): PreloadedHoldMusicTrack? {
        val settings = storage.loadMusicSettings()
        resetPreloadedIfNeeded(settings)
        preloadNextTrack(settings)
        val result = preloaded
        preloaded = null
        return result
    }

    internal fun preloadNextTrack(settings: MusicSettings = storage.loadMusicSettings()) {
        if (preloaded != null) return
        val track = takeNextTrack(settings) ?: return
        runCatching {
            preloaded = PreloadedHoldMusicTrack(
                processed = buildPlayer(HoldMusicCatalog.processedUrl(track, settings.volumeLevel)),
                original = buildPlayer(HoldMusicCatalog.originalUrl(track, settings.volumeLevel)),
                track = track,
                volumeLevel = settings.volumeLevel,
            )
        }
    }

    internal fun resetPreloadedIfNeeded(settings: MusicSettings) {
        val current = preloaded ?: return
        val enabled = current.track !in settings.disabledTracks
        if (enabled && current.volumeLevel == settings.volumeLevel) return
        runCatching { current.processed.release() }
        runCatching { current.original.release() }
        preloaded = null
    }
}

internal class PreloadedHoldMusicTrack(
    val processed: ExoPlayer,
    val original: ExoPlayer,
    val track: String,
    val volumeLevel: MusicVolumeLevel,
)

internal class HoldMusicSession(
    val track: String,
    val processed: ExoPlayer,
    val original: ExoPlayer,
) {
    var stopped = false
    var started = false
    var processedAudible = true
    private var visualizer: Visualizer? = null

    fun applySettingsVolumes(settings: MusicSettings) {
        processedAudible = settings.effects
        applyMute(HoldMusic.getMuted())
    }

    fun applyMute(muted: Boolean) {
        processed.volume = if (muted || !processedAudible) 0f else 1f
        original.volume = if (muted || processedAudible) 0f else 1f
    }

    fun startVisualizer() {
        if (visualizer != null) return
        val audible = if (processedAudible) processed else original
        val sessionId = runCatching { audible.audioSessionId }.getOrDefault(C.AUDIO_SESSION_ID_UNSET)
        if (sessionId == C.AUDIO_SESSION_ID_UNSET) return
        visualizer = runCatching {
            Visualizer(sessionId).apply {
                captureSize = Visualizer.getCaptureSizeRange()[1]
                setDataCaptureListener(
                    object : Visualizer.OnDataCaptureListener {
                        override fun onWaveFormDataCapture(
                            visualizer: Visualizer,
                            waveform: ByteArray,
                            samplingRate: Int,
                        ) {
                            if (stopped) return
                            HoldMusic.publishBands(HoldMusic.bandsFromWaveform(waveform, samplingRate))
                        }

                        override fun onFftDataCapture(
                            visualizer: Visualizer,
                            fft: ByteArray,
                            samplingRate: Int,
                        ) {
                        }
                    },
                    Visualizer.getMaxCaptureRate(),
                    true,
                    false,
                )
                enabled = true
            }
        }.getOrNull()
    }

    fun restartVisualizer() {
        stopVisualizer()
        startVisualizer()
    }

    private fun stopVisualizer() {
        visualizer?.let {
            runCatching { it.enabled = false }
            runCatching { it.release() }
        }
        visualizer = null
    }

    fun release() {
        stopped = true
        stopVisualizer()
        HoldMusic.publishBands(null)
        runCatching { processed.release() }
        runCatching { original.release() }
    }
}

class HoldMusicController {
    private var session: HoldMusicSession? = null
    private var wantsPlayback = false

    /** Audio-unlock parity hook; Android playback needs no gesture unlock. */
    fun unlock() {}

    fun start() {
        HoldMusic.onMain {
            stopActiveSessionInternal()
            startInternal()
        }
    }

    fun stop() {
        HoldMusic.onMain {
            wantsPlayback = false
            HoldMusic.desiredControllers.remove(this)
            stopActiveSession()
        }
    }

    private fun restartForSettingsChange() {
        if (!wantsPlayback) return
        stopActiveSessionInternal()
        startInternal()
    }

    internal fun applySettingsChange(
        settings: MusicSettings,
        effectsChanged: Boolean,
        volumeLevelChanged: Boolean,
        disabledTracksChanged: Boolean,
    ) {
        if (!wantsPlayback) return

        if (disabledTracksChanged) {
            val current = session
            if (current == null || current.track in settings.disabledTracks) {
                restartForSettingsChange()
                return
            }
        }

        if (volumeLevelChanged) {
            restartForSettingsChange()
            return
        }

        if (effectsChanged) {
            session?.let { active ->
                active.applySettingsVolumes(settings)
                if (active.started && !HoldMusic.getMuted()) active.restartVisualizer()
            }
        }
    }

    private fun startInternal() {
        wantsPlayback = true
        HoldMusic.desiredControllers.add(this)
        val preloaded = HoldMusic.consumePreloadedTrack() ?: return
        val settings = HoldMusic.loadMusicSettings()
        val session = HoldMusicSession(preloaded.track, preloaded.processed, preloaded.original)
        session.applySettingsVolumes(settings)
        this.session = session
        HoldMusic.activeSessions.add(session)
        HoldMusic.publishCurrentTrack(preloaded.track)
        beginWhenDurationKnown(session)
    }

    private fun stopActiveSession() {
        stopActiveSessionInternal()
    }

    private fun stopActiveSessionInternal() {
        val active = session
        session = null
        if (active == null) {
            HoldMusic.preloadNextTrack()
            return
        }
        active.stopped = true
        HoldMusic.activeSessions.remove(active)
        HoldMusic.publishCurrentTrack(null)
        active.release()
        HoldMusic.preloadNextTrack()
    }

    private fun beginWhenDurationKnown(session: HoldMusicSession) {
        val durations = listOf(session.processed.duration, session.original.duration)
        if (durations.all { it != C.TIME_UNSET && it > 0 }) {
            beginSession(session)
            return
        }
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (session.stopped || session.started) return
                val known = listOf(session.processed.duration, session.original.duration)
                if (known.all { it != C.TIME_UNSET && it > 0 }) {
                    session.processed.removeListener(this)
                    session.original.removeListener(this)
                    beginSession(session)
                }
            }
        }
        session.processed.addListener(listener)
        session.original.addListener(listener)
    }

    private fun beginSession(session: HoldMusicSession) {
        if (this.session !== session || session.stopped || session.started) return
        val duration = minOf(session.processed.duration, session.original.duration)
        if (duration == C.TIME_UNSET || duration <= 0) return

        session.started = true
        val startTime = pickRandomStartTimeMs(duration)
        runCatching { session.processed.seekTo(startTime) }
        runCatching { session.original.seekTo(startTime) }

        session.processed.play()
        session.original.play()

        if (!HoldMusic.getMuted()) session.startVisualizer()
    }
}
