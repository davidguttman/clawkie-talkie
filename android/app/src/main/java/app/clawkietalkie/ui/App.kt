package app.clawkietalkie.ui

import android.Manifest
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import app.clawkietalkie.BuildConfig
import app.clawkietalkie.protocol.RecentSession
import app.clawkietalkie.rtc.HOSTED_DEFAULT_ICE_SERVERS
import app.clawkietalkie.rtc.IceServer
import app.clawkietalkie.rtc.RtcSession
import app.clawkietalkie.storage.Storage
import app.clawkietalkie.storage.latestAssistantText
import app.clawkietalkie.ui.driving.DrivingManualReplay
import app.clawkietalkie.ui.driving.DrivingScreen
import app.clawkietalkie.voice.DaemonTtsAudio
import app.clawkietalkie.voice.DrivingController
import app.clawkietalkie.voice.HandoffRoute
import app.clawkietalkie.voice.MicAudio
import app.clawkietalkie.voice.ReplayPlaybackHandle
import app.clawkietalkie.voice.ReplayRequest
import app.clawkietalkie.voice.ReplaySpeech
import app.clawkietalkie.voice.ReplayStartResult
import app.clawkietalkie.voice.canReplayAssistantReply
import app.clawkietalkie.voice.parseSttChunkMs
import app.clawkietalkie.voice.startBufferedReplyAudioPlayback
import app.clawkietalkie.voice.startReplayAssistantReply
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.webrtc.PeerConnectionFactory

// Root app composable. Mirror of the web client's app.tsx: route/screen
// dispatch, overlay modals (Settings, History), RTC provider wiring,
// manual replay, and the session-replaced gate.

fun defaultSignalServer(): String = BuildConfig.SIGNAL_SERVER

fun defaultIceServers(): List<IceServer> {
    val raw = BuildConfig.ICE_SERVERS_JSON.trim()
    if (raw.isEmpty()) return HOSTED_DEFAULT_ICE_SERVERS
    return runCatching {
        val parsed = kotlinx.serialization.json.Json.parseToJsonElement(raw) as? JsonArray
            ?: return HOSTED_DEFAULT_ICE_SERVERS
        parsed.mapNotNull { entry ->
            val source = entry as? JsonObject ?: return@mapNotNull null
            val urls = when (val urlsValue = source["urls"]) {
                is JsonPrimitive -> listOf(urlsValue.content)
                is JsonArray -> urlsValue.mapNotNull { (it as? JsonPrimitive)?.content }
                else -> return@mapNotNull null
            }
            if (urls.isEmpty()) return@mapNotNull null
            IceServer(
                urls = urls,
                username = (source["username"] as? JsonPrimitive)?.content,
                credential = (source["credential"] as? JsonPrimitive)?.content,
            )
        }.ifEmpty { HOSTED_DEFAULT_ICE_SERVERS }
    }.getOrDefault(HOSTED_DEFAULT_ICE_SERVERS)
}

private class ActiveManualReplay(
    val display: DrivingManualReplay,
    val handle: ReplayPlaybackHandle,
)

@Composable
fun ClawkieAppRoot(
    storage: Storage,
    factory: PeerConnectionFactory,
    initial: InitialLocation,
    onFinish: () -> Unit,
) {
    val context = LocalContext.current
    var screen by remember(initial) { mutableStateOf(initial.screen) }
    var activeHandoff by remember(initial) { mutableStateOf(initial.handoff) }
    var openSession by remember(initial) { mutableStateOf(initial.sessionId) }
    var settingsOpen by remember { mutableStateOf(false) }
    var historyOpen by remember { mutableStateOf(false) }
    var hostOverride by remember(initial) { mutableStateOf<String?>(null) }
    var hostEntryOpen by remember { mutableStateOf(false) }
    var settings by remember(initial) { mutableStateOf(storage.loadSettings(initial.hostPeerId)) }
    var replayTick by remember { mutableIntStateOf(0) }
    var manualReplay by remember { mutableStateOf<ActiveManualReplay?>(null) }
    var reloadGeneration by remember { mutableIntStateOf(0) }

    // Touch devices always get the narrow runtime shell (the web's
    // `(pointer: coarse)` rule); wide pointer-driven screens get the
    // desktop phone frame with default metrics inside.
    val compact = computeIsNarrow(context, LocalConfiguration.current.screenWidthDp)
    val activeHostPeerId = activeHandoff?.hostPeerId ?: hostOverride ?: initial.hostPeerId
    val drivingSessionId = activeHandoff?.sessionId ?: initial.sessionId
    val currentSessionId = if (screen == ScreenId.DRIVING) {
        drivingSessionId
    } else {
        openSession ?: activeHandoff?.sessionId ?: initial.sessionId
    }

    LaunchedEffect(settings) {
        storage.saveSettings(settings, activeHostPeerId)
    }

    DisposableEffect(Unit) {
        val unsubscribe = DaemonTtsAudio.subscribeReplayAvailability { replayTick += 1 }
        onDispose { unsubscribe() }
    }

    // --- RTC session (recreated when the handoff target or reload changes) ---
    val rendezvousKey = activeHandoff?.let { "${it.hostPeerId}:${it.sessionId}" }
    val rtcSession = remember(activeHostPeerId, rendezvousKey, reloadGeneration) {
        RtcSession(
            factory = factory,
            storage = storage,
            signalServer = defaultSignalServer(),
            iceServers = defaultIceServers(),
            hostPeerId = activeHostPeerId,
            rendezvous = activeHandoff?.let { handoffToRendezvous(it) },
            initialVoiceSettings = voiceSettingsForRtc(settings),
        )
    }
    DisposableEffect(rtcSession) {
        rtcSession.start()
        onDispose { rtcSession.close() }
    }
    LaunchedEffect(settings, rtcSession) {
        rtcSession.updateVoiceSettings(voiceSettingsForRtc(settings))
    }

    val rtcState by rtcSession.state.collectAsState()

    // --- Driving controller (kept mounted across dashboard navigation) ---
    val shouldMountDriving =
        (screen == ScreenId.DRIVING || screen == ScreenId.DASHBOARD) && drivingSessionId != null
    val drivingController = if (shouldMountDriving) {
        val controller = remember(rtcSession, drivingSessionId) {
            DrivingController(
                appContext = context.applicationContext,
                storage = storage,
                rtc = rtcSession,
                sessionId = drivingSessionId,
                threadId = initial.threadId,
                hostPeerId = activeHostPeerId,
                sttChunkConfig = parseSttChunkMs(initial.sttChunkMs),
                audioFixtureUrl = initial.audioFixtureUrl,
            )
        }
        DisposableEffect(controller) {
            controller.start()
            onDispose { controller.destroy() }
        }
        controller
    } else null

    // Mic permission: ask up-front when the voice surface mounts (the web
    // equivalent is the browser's getUserMedia prompt on first capture).
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }
    LaunchedEffect(screen) {
        if (screen == ScreenId.DRIVING && !MicAudio.hasPermission(context)) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // --- Manual replay of the last assistant reply ---
    val currentAssistantText = remember(currentSessionId, replayTick) {
        currentSessionId?.let { latestAssistantText(storage.loadTranscriptSession(it)) }
    }
    val canReplayLastReply = remember(currentAssistantText, replayTick) {
        canReplayAssistantReply(
            ReplayRequest(
                audio = DaemonTtsAudio.lastBufferedReplyAudio(),
                text = currentAssistantText,
                canSpeakText = ReplaySpeech.canSpeak(),
            ),
        )
    }

    fun stopManualReplay() {
        val active = manualReplay
        manualReplay = null
        active?.handle?.stop()
    }

    fun replayLastReply() {
        stopManualReplay()
        val result = startReplayAssistantReply(
            ReplayRequest(
                audio = DaemonTtsAudio.lastBufferedReplyAudio(),
                text = currentAssistantText,
                canSpeakText = ReplaySpeech.canSpeak(),
            ),
            startAudio = ::startBufferedReplyAudioPlayback,
            startText = ReplaySpeech::startSpeak,
        )
        if (result is ReplayStartResult.Started) {
            val active = ActiveManualReplay(
                display = DrivingManualReplay(
                    text = result.text,
                    mode = result.mode,
                    currentBands = { result.handle.currentBands() },
                    onSilence = { stopManualReplay() },
                ),
                handle = result.handle,
            )
            manualReplay = active
            result.handle.done.invokeOnCompletion {
                if (manualReplay === active) manualReplay = null
            }
        }
    }

    LaunchedEffect(currentSessionId) {
        stopManualReplay()
    }

    // Connect to a different daemon host. The web client does this through
    // the address bar (a new #host= URL); on Android the host entry screen
    // plus this switch is the equivalent. Persists as the last dashboard
    // host so the next launcher start recovers it.
    fun switchHost(host: String) {
        val trimmed = host.trim()
        if (trimmed.isEmpty()) return
        storage.saveLastDashboardHostPeerId(trimmed)
        activeHandoff = null
        openSession = null
        hostOverride = trimmed
        settings = storage.loadSettings(trimmed)
        settingsOpen = false
        historyOpen = false
        hostEntryOpen = false
        screen = ScreenId.DASHBOARD
    }

    fun selectRecentSession(session: RecentSession) {
        val next = selectHandoffFromRecentSession(activeHandoff ?: initial.handoff, session, activeHostPeerId)
            ?: return
        activeHandoff = next
        openSession = next.sessionId
        screen = ScreenId.DRIVING
    }

    // Android back: close overlays first, step back from transcript, then
    // exit (the web has no in-app back affordance beyond these).
    BackHandler(enabled = true) {
        when {
            hostEntryOpen -> hostEntryOpen = false
            settingsOpen -> settingsOpen = false
            historyOpen -> historyOpen = false
            screen == ScreenId.TRANSCRIPT -> screen = ScreenId.DRIVING
            screen == ScreenId.DRIVING && initial.screen == ScreenId.DASHBOARD -> screen = ScreenId.DASHBOARD
            else -> onFinish()
        }
    }

    // Session replaced gate: a newer phone took over this voice session.
    if (rtcState.detail == "session_replaced") {
        ResponsiveRuntime(compact = compact) {
            ErrorScreen(
                kind = ErrorKind.REPLACED,
                onDismiss = { reloadGeneration += 1 },
                onRetry = { reloadGeneration += 1 },
                onBack = { reloadGeneration += 1 },
            )
        }
        return
    }

    ResponsiveRuntime(compact = compact) {
        // Base screens
        if (shouldMountDriving && drivingController != null) {
            Box(
                modifier = Modifier.fillMaxSize(),
            ) {
                if (screen == ScreenId.DRIVING) {
                    DrivingScreen(
                        controller = drivingController,
                        rtc = rtcSession,
                        accent = "amber",
                        onReplay = if (currentSessionId != null) ::replayLastReply else null,
                        canReplay = canReplayLastReply,
                        manualReplay = manualReplay?.display,
                        restoredAssistantText = currentAssistantText,
                        onSessions = { screen = ScreenId.DASHBOARD },
                        onSettings = {
                            historyOpen = false
                            settingsOpen = true
                        },
                        compact = compact,
                        sessionId = drivingSessionId,
                        favoriteSession = favoriteSessionFromHandoff(activeHandoff),
                        debugMode = initial.debug,
                        sttChunkConfig = parseSttChunkMs(initial.sttChunkMs),
                    )
                }
            }
        }
        if (screen == ScreenId.DASHBOARD) {
            DashboardScreen(
                rtc = rtcSession,
                onSwitchHost = { hostEntryOpen = true },
                onSelectSession = ::selectRecentSession,
                onNewSessionCreated = ::selectRecentSession,
                onHistory = {
                    settingsOpen = false
                    historyOpen = true
                },
                onSettings = {
                    historyOpen = false
                    settingsOpen = true
                },
                compact = compact,
            )
        }
        if (screen == ScreenId.TRANSCRIPT) {
            if (currentSessionId != null) {
                TranscriptScreen(
                    storage = storage,
                    sessionId = currentSessionId,
                    onBack = { screen = ScreenId.DRIVING },
                    compact = compact,
                    settings = settings,
                )
            } else {
                ErrorScreen(
                    kind = ErrorKind.BAD_SESSION,
                    onDismiss = { screen = ScreenId.DRIVING },
                    onRetry = { screen = ScreenId.DRIVING },
                    onBack = { screen = ScreenId.DRIVING },
                )
            }
        }
        if (screen == ScreenId.ERROR) {
            // Dismissing a dead-link error with no host to fall back to must
            // land on host entry, not another dead screen.
            val dismissTarget: () -> Unit = {
                screen = if (activeHostPeerId != null) ScreenId.DRIVING else ScreenId.HOST_ENTRY
            }
            ErrorScreen(
                kind = initial.errorKind,
                onDismiss = dismissTarget,
                onRetry = dismissTarget,
                onBack = dismissTarget,
            )
        }
        if (screen == ScreenId.HOST_ENTRY) {
            HostEntryScreen(
                initialValue = storage.loadLastDashboardHostPeerId() ?: "",
                onConnect = ::switchHost,
            )
        }

        // Overlays (modal: scrim + full-bleed sheet, like the web overlays)
        if (historyOpen) {
            Box(modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.42f)))
            Box(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
                HistoryScreen(
                    storage = storage,
                    onBack = { historyOpen = false },
                    onOpenSession = { sessionId ->
                        historyOpen = false
                        openSession = sessionId
                        screen = ScreenId.TRANSCRIPT
                    },
                    compact = compact,
                )
            }
        }
        if (settingsOpen) {
            Box(modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.42f)))
            Box(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
                SettingsScreen(
                    onBack = { settingsOpen = false },
                    settings = settings,
                    setSettings = { settings = it },
                    hostPeerId = activeHostPeerId,
                    ttsCatalog = rtcState.ttsCatalog,
                    onRefreshTtsCatalog = rtcSession::requestTtsCatalog,
                    sttCatalog = rtcState.sttCatalog,
                    onRefreshSttCatalog = rtcSession::requestSttCatalog,
                    compact = compact,
                    onChangeHost = { hostEntryOpen = true },
                )
            }
        }
        if (hostEntryOpen) {
            Box(modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.42f)))
            Box(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
                HostEntryScreen(
                    initialValue = activeHostPeerId ?: storage.loadLastDashboardHostPeerId() ?: "",
                    onConnect = ::switchHost,
                    onBack = { hostEntryOpen = false },
                )
            }
        }
    }
}

/**
 * Narrow (touch/runtime) shell vs desktop phone frame. Mirror of the web
 * client's ResponsiveRuntime: the same content renders full-bleed on touch
 * devices and inside the HiFiPhone frame on wide pointer-driven screens.
 */
@Composable
private fun ResponsiveRuntime(compact: Boolean, content: @Composable () -> Unit) {
    if (compact) {
        Box(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
            content()
        }
    } else {
        DesktopPhoneShell(content)
    }
}
