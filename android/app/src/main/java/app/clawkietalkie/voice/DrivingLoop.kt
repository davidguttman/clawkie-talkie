package app.clawkietalkie.voice

import android.content.Context
import app.clawkietalkie.protocol.ControlMessage
import app.clawkietalkie.protocol.PhoneToDaemon
import app.clawkietalkie.rtc.RtcSession
import app.clawkietalkie.rtc.RtcStatus
import app.clawkietalkie.storage.Storage
import app.clawkietalkie.storage.TranscriptRole
import app.clawkietalkie.storage.TranscriptSessionInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Driving state machine — thin adapter that drives the pure reducer in
// DrivingReducer.kt from UI taps + daemon control messages, and translates
// the reducer's side-effect intents into DataChannel traffic and audio
// player control. Mirror of the web client's `src/voice/drivingLoop.ts`.

const val WAVE_BARS = 28
const val UNIQUE_WAVE_BANDS = WAVE_BARS / 2

private val IDLE_INTENSITIES = DoubleArray(WAVE_BARS) { 0.12 }
private val QUIET_INTENSITIES = DoubleArray(WAVE_BARS) { 0.08 }

data class Turn(val who: TranscriptRole, val text: String)

data class CurrentTurnTranscript(
    val active: Boolean = false,
    val sttDone: Boolean = false,
    val text: String = "",
)

data class DrivingUiState(
    val state: DrivingState = DrivingState.IDLE,
    val liveText: String = "",
    val isTranscribing: Boolean = false,
    val lastTurn: Turn? = null,
    val intensities: DoubleArray = IDLE_INTENSITIES.copyOf(),
    val error: String? = null,
    val daemonConnected: Boolean = false,
) {
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

class DrivingController(
    private val appContext: Context,
    private val storage: Storage,
    private val rtc: RtcSession,
    private val sessionId: String?,
    private val threadId: String?,
    private val hostPeerId: String?,
    private val sttChunkConfig: SttChunkConfig? = null,
    private val audioFixtureUrl: String? = null,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private var ctx = initialDrivingContext
    private var currentTurnTranscript = CurrentTurnTranscript()
    private val accumulated = mutableListOf<String>()

    private var sttHandle: SttHandle? = null
    private var pendingSttStart: PendingSttStart? = null
    private var localSttStopInFlight = false
    private var ttsHandle: TtsHandle? = null
    private var holdMusic: HoldMusicController? = null
    private var micBands = QUIET_INTENSITIES.copyOf()
    private var renderedBands = IDLE_INTENSITIES.copyOf()
    private var visualizerJob: Job? = null
    private var detachControl: (() -> Unit)? = null
    private var rtcStateJob: Job? = null

    private val _state = MutableStateFlow(DrivingUiState())
    val state: StateFlow<DrivingUiState> = _state.asStateFlow()

    fun start() {
        detachControl = rtc.addControlListener { msg ->
            scope.launch { handleControlMessage(msg) }
        }
        rtcStateJob = scope.launch {
            rtc.state.collect { publish() }
        }
        publish()
    }

    fun destroy() {
        detachControl?.invoke()
        detachControl = null
        sttHandle?.cancel()
        sttHandle = null
        pendingSttStart?.cancelLateHandle()
        pendingSttStart = null
        localSttStopInFlight = false
        // Unmount teardown cancels the remote reply (web parity: the unmount
        // effect calls handle.stop() with cancelRemote defaulted to true).
        ttsHandle?.stop(cancelRemote = true)
        ttsHandle = null
        holdMusic?.stop()
        visualizerJob?.cancel()
        rtcStateJob?.cancel()
        scope.cancel()
    }

    // ------------------------------------------------------------------
    // Public UI inputs
    // ------------------------------------------------------------------

    fun tap() {
        if (ctx.state == DrivingState.IDLE) {
            if (!rtc.state.value.hasClient || rtc.currentStatus != RtcStatus.OPEN) {
                // Surface a connection-error without spinning up a turn.
                dispatch(DrivingEvent.SttError("daemon_not_connected"))
                return
            }
            accumulated.clear()
            micBands = QUIET_INTENSITIES.copyOf()
            setTranscript(CurrentTurnTranscript(active = true, sttDone = false, text = ""))
        }
        if (holdMusic == null) holdMusic = HoldMusicController()
        holdMusic?.unlock()
        dispatch(
            DrivingEvent.Tap(
                currentTurnTranscribing = isCurrentTurnTranscribing(ctx.state, currentTurnTranscript),
            ),
        )
    }

    fun silence() {
        dispatch(DrivingEvent.Silence)
    }

    // ------------------------------------------------------------------
    // Reducer dispatch + side effects
    // ------------------------------------------------------------------

    private fun dispatch(event: DrivingEvent) {
        val reduction = reduce(ctx, event)
        ctx = reduction.next
        for (effect in reduction.side) {
            when (effect) {
                DrivingSideEffect.START_MIC -> runStartMic()
                DrivingSideEffect.STOP_MIC -> runStopMic()
                DrivingSideEffect.CANCEL_MIC -> runCancelMic()
                DrivingSideEffect.ARM_TTS -> runArmTts(null)
                DrivingSideEffect.STOP_TTS -> runStopTts()
                DrivingSideEffect.CANCEL_REPLY -> runCancelReply()
            }
        }
        syncHoldMusicForState()
        syncVisualizer()
        publish()
    }

    private var lastHoldMusicSyncState: DrivingState? = null

    private fun syncHoldMusicForState() {
        // Only react to state *changes* (the web effect depends on ctx.state);
        // re-running start() on every dispatch would restart the track.
        if (lastHoldMusicSyncState == ctx.state) return
        lastHoldMusicSyncState = ctx.state
        if (ctx.state == DrivingState.THINKING && holdMusic == null) {
            holdMusic = HoldMusicController()
        }
        val controller = holdMusic ?: return
        when (ctx.state) {
            DrivingState.THINKING -> controller.start()
            DrivingState.IDLE, DrivingState.RECORDING -> controller.stop()
            else -> {}
        }
    }

    // ------------------------------------------------------------------
    // Control messages from the daemon
    // ------------------------------------------------------------------

    private fun handleControlMessage(msg: ControlMessage) {
        when (msg.t) {
            "session.snapshot" -> handleSessionSnapshot(msg)
            "stt.partial" -> {
                val text = msg.string("text") ?: ""
                // Some STT providers emit empty partials (and even empty
                // finals) during silence tails. Either form would wipe the
                // live caption — only commit non-empty text on screen.
                if (text.isBlank()) return
                val isFinal = msg.boolean("is_final") ?: false
                if (isFinal) {
                    accumulated.add(text.trim())
                    setTranscript(
                        CurrentTurnTranscript(
                            active = true,
                            sttDone = false,
                            text = accumulated.joinToString(" ").trim(),
                        ),
                    )
                } else {
                    setTranscript(
                        CurrentTurnTranscript(
                            active = true,
                            sttDone = false,
                            text = composeTranscript(accumulated, text),
                        ),
                    )
                }
                publish()
            }
            "stt.done" -> {
                localSttStopInFlight = false
                val result = resolveSttDone(msg.string("text"))
                accumulated.clear()
                setTranscript(result.transcript)
                result.saveText?.let { saveTranscriptTurn(TranscriptRole.USER, it) }
                dispatch(result.event)
            }
            "stt.error" -> {
                localSttStopInFlight = false
                val reason = msg.string("message") ?: "stt_error"
                setTranscript(CurrentTurnTranscript())
                dispatch(DrivingEvent.SttError(reason))
            }
            "reply.done" -> {
                val text = msg.string("text") ?: ""
                saveTranscriptTurn(TranscriptRole.ASSISTANT, text)
                dispatch(DrivingEvent.ReplyDone(text))
            }
            "reply.error" -> {
                val reason = msg.string("message") ?: "reply_error"
                saveTranscriptTurn(TranscriptRole.ASSISTANT, "", reason)
                stopHoldMusicForControlMessage(msg.t)
                dispatch(DrivingEvent.ReplyError(reason))
            }
            "tts.start" -> {
                stopHoldMusicForControlMessage(msg.t)
                if (msg.boolean("buffered") == true && ttsHandle == null) {
                    runArmTts(msg)
                }
                val text = msg.string("text")?.trim()?.takeIf { it.isNotEmpty() }
                dispatch(DrivingEvent.TtsStart(text))
            }
            "tts.done" -> {
                stopHoldMusicForControlMessage(msg.t)
                // Wire tts.done only means the daemon finished sending the TTS
                // turn. UI completion comes from the local TtsHandle after
                // playback has drained; with no handle active, close reducer
                // state directly (snapshots / stale control streams).
                if (ttsHandle == null) dispatch(DrivingEvent.TtsDone)
            }
            "tts.error" -> {
                val reason = msg.string("message") ?: "tts_error"
                stopHoldMusicForControlMessage(msg.t)
                // Errors surface immediately; clearing the handle prevents its
                // completion callback from dispatching a duplicate event.
                ttsHandle = null
                dispatch(DrivingEvent.TtsError(reason))
            }
        }
    }

    private fun handleSessionSnapshot(msg: ControlMessage) {
        val replayControls = sessionSnapshotControlEvents(msg)
        val activeTts = ttsHandle
        val canForwardActiveTts = activeTts != null
        val deferTtsDone = canForwardActiveTts && replayControls.any { it.t == "tts.done" }
        val deferTtsError = canForwardActiveTts && replayControls.any { it.t == "tts.error" }
        if (canForwardActiveTts && (deferTtsDone || deferTtsError)) {
            for (event in replayControls) {
                if (event.t == "tts.done" || event.t == "tts.error") {
                    activeTts.handleControlMessage(event)
                }
            }
        }
        val plan = sessionSnapshotReplayPlanFromControlMessage(
            msg,
            SessionSnapshotReplayOptions(deferTtsDone, deferTtsError),
        ) ?: return

        if (replayControls.any { it.t == "stt.done" || it.t == "stt.error" }) {
            localSttStopInFlight = false
        }
        if (hasActiveLocalSttLifecycle() && shouldPreserveActiveLocalSttSnapshot(msg, plan)) {
            // Same-device reconnects can replay the daemon's in-progress STT
            // snapshot while we still own the live mic handle. Keep the local
            // recording lifecycle authoritative.
            return
        }
        if (hasActiveLocalSttLifecycle() && shouldDiscardLocalSttForSnapshotReplay(plan)) {
            runCancelMic()
        }
        for (event in replayControls) applyReplayControlSideEffects(event)
        plan.transcript?.let {
            accumulated.clear()
            setTranscript(it)
        }
        dispatch(plan.event)
    }

    private fun applyReplayControlSideEffects(msg: ControlMessage) {
        when (msg.t) {
            "stt.done" -> {
                val result = resolveSttDone(msg.string("text"))
                result.saveText?.let { saveTranscriptTurn(TranscriptRole.USER, it) }
            }
            "reply.done" -> saveTranscriptTurn(TranscriptRole.ASSISTANT, msg.string("text") ?: "")
            "reply.error" -> {
                val reason = msg.string("message") ?: "reply_error"
                saveTranscriptTurn(TranscriptRole.ASSISTANT, "", reason)
                stopHoldMusicForControlMessage(msg.t)
            }
            "tts.start", "tts.done", "tts.error" -> stopHoldMusicForControlMessage(msg.t)
        }
    }

    private fun stopHoldMusicForControlMessage(t: String) {
        if (t == "reply.error" || t == "tts.start" || t == "tts.done" || t == "tts.error") {
            holdMusic?.stop()
        }
    }

    // ------------------------------------------------------------------
    // Side-effect runners
    // ------------------------------------------------------------------

    private inner class PendingSttStart {
        var action: String = "active" // active | stop | cancel

        fun stopLateHandle() {
            action = "stop"
        }

        fun cancelLateHandle() {
            action = "cancel"
        }

        fun shouldPreserveSnapshot(): Boolean = action != "cancel"
    }

    private fun hasActiveLocalSttLifecycle(): Boolean =
        sttHandle != null ||
            (pendingSttStart?.shouldPreserveSnapshot() == true) ||
            localSttStopInFlight

    private fun runStartMic() {
        val pending = PendingSttStart()
        pendingSttStart = pending
        localSttStopInFlight = false
        micBands = QUIET_INTENSITIES.copyOf()
        // Lifecycle tracking for stale-error suppression (mirror of the web
        // client's shouldAcceptSttStartError): a daemon stt.error after a
        // local cancel or handle replacement must not surface.
        var sttLifecycle = "pending" // pending | active | stopping | cancelled
        var acceptedHandle: SttHandle? = null
        scope.launch {
            try {
                val handle = startDaemonStt(
                    SttStartOptions(
                        sendControl = { rtc.sendControl(it) },
                        sendBinary = { rtc.sendBinary(it) },
                        addControlListener = { listener -> rtc.addControlListener(listener) },
                        isConnected = { rtc.currentStatus == RtcStatus.OPEN },
                        onError = { reason ->
                            scope.launch {
                                val acceptedPendingError = pendingSttStart === pending
                                val accept = when {
                                    acceptedPendingError -> pending.action != "cancel"
                                    sttLifecycle == "active" ->
                                        acceptedHandle != null && sttHandle === acceptedHandle
                                    sttLifecycle == "stopping" -> localSttStopInFlight
                                    else -> false
                                }
                                if (!accept) return@launch
                                if (acceptedPendingError) {
                                    pendingSttStart = null
                                    pending.action = "cancel"
                                    sttLifecycle = "cancelled"
                                }
                                localSttStopInFlight = false
                                dispatch(DrivingEvent.SttError(reason))
                            }
                        },
                        onAudioFrame = { pcm ->
                            val bands = mirrorCenterOutBands(
                                pcm16ToBandIntensities(pcm, UNIQUE_WAVE_BANDS),
                            )
                            micBands = bands
                            MicAudio.publishMicBands(bands)
                        },
                        audioSource = audioFixtureUrl?.let { FixtureAudioSource(it) }
                            ?: MicAudioSource(appContext),
                        chunkConfig = sttChunkConfig,
                    ),
                )
                if (pendingSttStart !== pending) {
                    sttLifecycle = "cancelled"
                    handle.cancel()
                    return@launch
                }
                pendingSttStart = null
                when (pending.action) {
                    "stop" -> {
                        sttLifecycle = "stopping"
                        localSttStopInFlight = true
                        scope.launch {
                            runCatching { handle.stop() }
                        }
                    }
                    "cancel" -> {
                        sttLifecycle = "cancelled"
                        localSttStopInFlight = false
                        handle.cancel()
                    }
                    else -> {
                        val guardedHandle = object : SttHandle {
                            override suspend fun stop(): String {
                                sttLifecycle = "stopping"
                                return handle.stop()
                            }

                            override fun cancel() {
                                sttLifecycle = "cancelled"
                                handle.cancel()
                            }
                        }
                        acceptedHandle = guardedHandle
                        sttLifecycle = "active"
                        localSttStopInFlight = false
                        sttHandle = guardedHandle
                    }
                }
            } catch (err: Exception) {
                if (pendingSttStart !== pending) return@launch
                pendingSttStart = null
                val reason = when {
                    err is DaemonNotConnectedError -> "daemon_not_connected"
                    err is MicPermissionError -> "mic_denied"
                    err.message != null -> err.message!!
                    else -> "stt_start_failed"
                }
                if (pending.action == "cancel") {
                    localSttStopInFlight = false
                    return@launch
                }
                localSttStopInFlight = false
                dispatch(DrivingEvent.SttError(reason))
            }
        }
    }

    private fun runStopMic() {
        val handle = sttHandle
        sttHandle = null
        if (handle == null) {
            pendingSttStart?.let {
                localSttStopInFlight = true
                it.stopLateHandle()
            }
            return
        }
        localSttStopInFlight = true
        // stop() resolves with the final transcript. We don't need the value
        // here — the daemon emits `stt.done` on the control channel, and the
        // listener above turns that into a reducer event.
        scope.launch {
            runCatching { handle.stop() }
        }
    }

    private fun runCancelMic() {
        val handle = sttHandle
        sttHandle = null
        localSttStopInFlight = false
        pendingSttStart?.cancelLateHandle()
        handle?.cancel()
    }

    private fun runArmTts(initialControlMessage: ControlMessage?) {
        val activeTts = ttsHandle
        if (activeTts != null) {
            // Reconnect snapshots can hydrate `speaking` while the original
            // local playback handle is still draining. Keep the single
            // canonical playback lifecycle instead of overwriting it.
            if (initialControlMessage != null) {
                activeTts.handleControlMessage(initialControlMessage)
            }
            return
        }

        val tts = playDaemonTts(
            TtsPlayerOptions(
                addControlListener = { listener -> rtc.addControlListener(listener) },
                addBinaryListener = { listener -> rtc.addBinaryListener(listener) },
                sendControl = { rtc.sendControl(it) },
                initialControlMessage = initialControlMessage,
            ),
        )
        ttsHandle = tts
        scope.launch {
            tts.done.await()
            if (ttsHandle !== tts) return@launch
            ttsHandle = null
            val error = tts.error
            if (error != null) dispatch(DrivingEvent.TtsError(error))
            else dispatch(DrivingEvent.TtsDone)
        }
    }

    private fun runStopTts() {
        val tts = ttsHandle
        ttsHandle = null
        tts?.stop(cancelRemote = false)
    }

    private fun runCancelReply() {
        runCatching { rtc.sendControl(PhoneToDaemon.replyCancel()) }
        val tts = ttsHandle
        ttsHandle = null
        tts?.stop(cancelRemote = false)
    }

    private fun saveTranscriptTurn(role: TranscriptRole, text: String, error: String? = null) {
        val id = sessionId ?: return
        storage.appendTranscriptTurn(
            TranscriptSessionInput(sessionId = id, threadId = threadId, hostPeerId = hostPeerId),
            role,
            text,
            error,
        )
        if (role == TranscriptRole.ASSISTANT && text.isNotBlank()) {
            DaemonTtsAudio.notifyReplayAvailabilityChanged()
        }
    }

    // ------------------------------------------------------------------
    // Visualization loop (~60 fps while active)
    // ------------------------------------------------------------------

    private fun syncVisualizer() {
        if (ctx.state == DrivingState.IDLE) {
            visualizerJob?.cancel()
            visualizerJob = null
            renderedBands = IDLE_INTENSITIES.copyOf()
            return
        }
        if (visualizerJob?.isActive == true) return
        visualizerJob = scope.launch {
            while (isActive) {
                val target = readTargetBands()
                renderedBands = smoothBandIntensities(renderedBands, target, LIGHT_SMOOTHING)
                publish()
                delay(16)
            }
        }
    }

    private fun readTargetBands(): DoubleArray {
        when (ctx.state) {
            DrivingState.RECORDING -> {
                return MicAudio.activeMicBands() ?: micBands
            }
            DrivingState.THINKING, DrivingState.AI -> {
                val sources = mutableListOf<DoubleArray>()
                DaemonTtsAudio.activeOutputBands()?.let { sources.add(it) }
                ttsHandle?.currentBands()?.let { sources.add(it) }
                if (ctx.state == DrivingState.THINKING) {
                    HoldMusic.activeHoldMusicBands()?.let { sources.add(it) }
                }
                if (sources.isEmpty()) return QUIET_INTENSITIES
                if (ctx.state == DrivingState.THINKING && sources.size == 1 && HoldMusic.getMuted()) {
                    return QUIET_INTENSITIES
                }
                return mergeBandIntensities(sources, WAVE_BARS)
            }
            else -> return QUIET_INTENSITIES
        }
    }

    // ------------------------------------------------------------------
    // Derived UI state
    // ------------------------------------------------------------------

    private fun setTranscript(value: CurrentTurnTranscript) {
        currentTurnTranscript = value
    }

    private fun publish() {
        val lastTurn: Turn? = when {
            ctx.state == DrivingState.IDLE && ctx.lastReplyText.isNotEmpty() ->
                Turn(TranscriptRole.ASSISTANT, ctx.lastReplyText)
            ctx.state == DrivingState.IDLE && ctx.lastUserText.isNotEmpty() ->
                Turn(TranscriptRole.USER, ctx.lastUserText)
            else -> null
        }
        _state.value = DrivingUiState(
            state = ctx.state,
            liveText = displayedCaptionText(ctx, currentTurnTranscript.text),
            isTranscribing = isCurrentTurnTranscribing(ctx.state, currentTurnTranscript),
            lastTurn = lastTurn,
            intensities = renderedBands.copyOf(),
            error = ctx.error,
            daemonConnected = rtc.state.value.hasClient && rtc.currentStatus == RtcStatus.OPEN,
        )
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests; mirror of drivingLoop.ts exports)
// ---------------------------------------------------------------------------

class SttDoneResolution(
    val transcript: CurrentTurnTranscript,
    val event: DrivingEvent,
    val saveText: String? = null,
)

fun resolveSttDone(msgText: String?): SttDoneResolution {
    val finalText = msgText?.trim() ?: ""
    if (finalText.isEmpty()) {
        return SttDoneResolution(
            transcript = CurrentTurnTranscript(),
            event = DrivingEvent.SttError("empty_transcript"),
        )
    }
    return SttDoneResolution(
        transcript = CurrentTurnTranscript(active = true, sttDone = true, text = finalText),
        event = DrivingEvent.SttDone(finalText),
        saveText = finalText,
    )
}

fun displayedCaptionText(ctx: DrivingContext, liveText: String): String =
    if (ctx.state == DrivingState.AI) ctx.liveReplyText else liveText

fun isCurrentTurnTranscribing(state: DrivingState, transcript: CurrentTurnTranscript): Boolean =
    state == DrivingState.THINKING && transcript.active && !transcript.sttDone

fun composeTranscript(finals: List<String>, current: String): String =
    (finals + current.trim()).filter { it.isNotEmpty() }.joinToString(" ").trim()

// ---------------------------------------------------------------------------
// Session snapshot replay planning (mirror of drivingLoop.ts)
// ---------------------------------------------------------------------------

data class SessionSnapshotReplayOptions(
    val deferTtsDone: Boolean = false,
    val deferTtsError: Boolean = false,
)

class SessionSnapshotReplayPlan(
    val event: DrivingEvent.SessionReplay,
    val transcript: CurrentTurnTranscript?,
)

fun sessionSnapshotControlEvents(msg: ControlMessage): List<ControlMessage> {
    val events = msg.array("events") ?: return emptyList()
    return events.mapNotNull { entry ->
        val record = entry as? JsonObject ?: return@mapNotNull null
        val t = (record["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (t != null) return@mapNotNull ControlMessage(record)
        val nested = record["msg"] as? JsonObject ?: return@mapNotNull null
        val nestedT = (nested["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (nestedT != null) ControlMessage(nested) else null
    }
}

fun drivingReplayEventFromControlMessage(msg: ControlMessage): DrivingReplayEvent? = when (msg.t) {
    "stt.done" -> resolveSttDone(msg.string("text")).event as DrivingReplayEvent
    "stt.error" -> DrivingEvent.SttError(msg.string("message") ?: "stt_error")
    "reply.done" -> DrivingEvent.ReplyDone(msg.string("text") ?: "")
    "reply.error" -> DrivingEvent.ReplyError(msg.string("message") ?: "reply_error")
    "tts.start" -> DrivingEvent.TtsStart(msg.string("text")?.trim()?.takeIf { it.isNotEmpty() })
    "tts.done" -> DrivingEvent.TtsDone
    "tts.error" -> DrivingEvent.TtsError(msg.string("message") ?: "tts_error")
    else -> null
}

private fun isTerminalReplayEvent(event: DrivingReplayEvent): Boolean =
    event is DrivingEvent.TtsDone ||
        event is DrivingEvent.TtsError ||
        event is DrivingEvent.ReplyError ||
        event is DrivingEvent.SttError

fun sessionSnapshotReplayPlanFromControlMessage(
    msg: ControlMessage,
    options: SessionSnapshotReplayOptions = SessionSnapshotReplayOptions(),
): SessionSnapshotReplayPlan? {
    if (msg.t != "session.snapshot") return null
    val controlEvents = sessionSnapshotControlEvents(msg)
    val events = controlEvents
        .filter { !(options.deferTtsDone && it.t == "tts.done") }
        .filter { !(options.deferTtsError && it.t == "tts.error") }
        .mapNotNull { drivingReplayEventFromControlMessage(it) }
    val snapshot = sessionSnapshotRecord(msg)
    val hydrated = snapshot?.let { snapshotHydrationPlan(it, options, events) }
    if (hydrated == null && events.isEmpty()) return null
    val terminalReplayWins = hydrated != null &&
        hydrated.hydration.context.state != DrivingState.IDLE &&
        events.any { isTerminalReplayEvent(it) }
    return SessionSnapshotReplayPlan(
        event = DrivingEvent.SessionReplay(events, hydrated?.hydration),
        transcript = if (terminalReplayWins) CurrentTurnTranscript() else hydrated?.transcript,
    )
}

fun shouldPreserveActiveLocalSttSnapshot(
    msg: ControlMessage,
    plan: SessionSnapshotReplayPlan,
): Boolean {
    if (msg.t != "session.snapshot") return false
    if (plan.event.events.isNotEmpty()) return false
    if (plan.event.hydration?.context?.state != DrivingState.IDLE) return false
    val snapshot = sessionSnapshotRecord(msg) ?: return false
    return normalizeSnapshotPhase(
        firstString(snapshot, listOf("phase", "turnPhase", "status", "state")),
        snapshot,
    ) == "recording"
}

fun shouldDiscardLocalSttForSnapshotReplay(plan: SessionSnapshotReplayPlan): Boolean =
    plan.event.events.isNotEmpty() || plan.event.hydration != null

private class SnapshotHydrationPlan(
    val hydration: DrivingHydration,
    val transcript: CurrentTurnTranscript,
)

private fun sessionSnapshotRecord(msg: ControlMessage): Map<String, kotlinx.serialization.json.JsonElement>? {
    val message = msg.fields
    val nestedSnapshot = message["snapshot"] as? JsonObject
    val nestedTurn = (nestedSnapshot?.get("turn") as? JsonObject) ?: (message["turn"] as? JsonObject)
    val merged = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
    merged.putAll(message)
    nestedSnapshot?.let { merged.putAll(it) }
    nestedTurn?.let { merged.putAll(it) }
    return if (merged.isNotEmpty()) merged else null
}

private fun snapshotHydrationPlan(
    source: Map<String, kotlinx.serialization.json.JsonElement>,
    options: SessionSnapshotReplayOptions,
    replayEvents: List<DrivingReplayEvent>,
): SnapshotHydrationPlan? {
    val phase = normalizeSnapshotPhase(
        firstString(source, listOf("phase", "turnPhase", "status", "state")),
        source,
    )
    val lastUserText = firstString(
        source,
        listOf("lastUserText", "userText", "transcript", "finalTranscript", "promptText"),
    )
    val replyText = firstString(
        source,
        listOf("lastReplyText", "replyText", "assistantText", "responseText", "pendingReplyText"),
    )
    val pendingReplyText = firstString(
        source,
        listOf("pendingReplyText", "pendingReply", "replyText", "assistantText", "responseText"),
    )
    val error = firstString(source, listOf("error", "reason", "message")).takeIf { it.isNotEmpty() }
    if (phase == null) return null

    fun hasReplay(check: (DrivingReplayEvent) -> Boolean): Boolean = replayEvents.any(check)

    return when (phase) {
        "completed" -> {
            val deferTtsTerminal = options.deferTtsDone || options.deferTtsError
            SnapshotHydrationPlan(
                DrivingHydration(
                    context = initialDrivingContext.copy(
                        state = if (deferTtsTerminal) DrivingState.AI else DrivingState.IDLE,
                        lastUserText = lastUserText,
                        lastReplyText = replyText,
                        liveReplyText = if (deferTtsTerminal) replyText else "",
                    ),
                    armTts = false,
                ),
                CurrentTurnTranscript(),
            )
        }
        "reply-ready" -> {
            if (!hasReplay { it is DrivingEvent.ReplyDone }) return null
            SnapshotHydrationPlan(
                DrivingHydration(
                    context = initialDrivingContext.copy(
                        state = DrivingState.THINKING,
                        lastUserText = lastUserText,
                        pendingReplyText = pendingReplyText,
                    ),
                    armTts = pendingReplyText.isNotEmpty(),
                ),
                CurrentTurnTranscript(active = lastUserText.isNotEmpty(), sttDone = true, text = lastUserText),
            )
        }
        "speaking" -> {
            if (!hasReplay { it is DrivingEvent.TtsStart }) return null
            SnapshotHydrationPlan(
                DrivingHydration(
                    context = initialDrivingContext.copy(
                        state = DrivingState.AI,
                        lastUserText = lastUserText,
                        lastReplyText = replyText,
                        liveReplyText = replyText,
                    ),
                    armTts = replyText.isNotEmpty(),
                ),
                CurrentTurnTranscript(active = lastUserText.isNotEmpty(), sttDone = true, text = lastUserText),
            )
        }
        "error" -> SnapshotHydrationPlan(
            DrivingHydration(
                context = initialDrivingContext.copy(
                    state = if (options.deferTtsError) DrivingState.AI else DrivingState.IDLE,
                    lastUserText = lastUserText,
                    lastReplyText = replyText,
                    liveReplyText = if (options.deferTtsError) replyText else "",
                    error = if (options.deferTtsError) null else error,
                ),
                armTts = false,
            ),
            CurrentTurnTranscript(),
        )
        "thinking" -> {
            if (!hasReplay { it is DrivingEvent.SttDone }) return null
            SnapshotHydrationPlan(
                DrivingHydration(
                    context = initialDrivingContext.copy(
                        state = DrivingState.THINKING,
                        lastUserText = lastUserText,
                    ),
                    armTts = false,
                ),
                CurrentTurnTranscript(active = lastUserText.isNotEmpty(), sttDone = true, text = lastUserText),
            )
        }
        "recording" ->
            // A reconnect/launch snapshot can report an in-progress mic phase,
            // but hydration has no proof this device still owns a live local
            // handle. Treat it as a safe idle state.
            SnapshotHydrationPlan(
                DrivingHydration(
                    context = initialDrivingContext.copy(state = DrivingState.IDLE, lastUserText = ""),
                    armTts = false,
                ),
                CurrentTurnTranscript(),
            )
        else -> SnapshotHydrationPlan(
            DrivingHydration(
                context = initialDrivingContext.copy(
                    state = DrivingState.IDLE,
                    lastUserText = lastUserText,
                    lastReplyText = replyText,
                ),
                armTts = false,
            ),
            CurrentTurnTranscript(),
        )
    }
}

private fun normalizeSnapshotPhase(
    raw: String,
    source: Map<String, kotlinx.serialization.json.JsonElement>,
): String? {
    val value = raw.trim().lowercase().replace(Regex("[ _]+"), "-")
    if (value == "completed" || value == "complete" || value == "done") return "completed"
    if (value == "reply-ready" || value == "replyready" || value == "reply-done") return "reply-ready"
    if (value == "speaking" || value == "ai" || value == "tts" || value == "tts-started") return "speaking"
    if (value == "error" || value == "failed") return "error"
    if (value == "thinking" || value == "replying" || value == "generating") return "thinking"
    if (value == "recording" || value == "listening" || value == "stt") return "recording"
    if (value == "idle") {
        return if (
            firstString(source, listOf("lastReplyText", "replyText", "assistantText", "responseText")).isNotEmpty()
        ) "completed" else "idle"
    }
    if (isTruthy(source["error"]) || isTruthy(source["reason"])) return "error"
    if (firstString(source, listOf("lastReplyText", "replyText", "assistantText", "responseText")).isNotEmpty()) {
        return "completed"
    }
    if (firstString(source, listOf("lastUserText", "userText", "transcript", "finalTranscript")).isNotEmpty()) {
        return "thinking"
    }
    return null
}

// JS truthiness for snapshot fallback fields: "", null, false and 0 are
// falsy; everything else (objects, arrays, non-empty strings) is truthy.
private fun isTruthy(value: kotlinx.serialization.json.JsonElement?): Boolean = when (value) {
    null, kotlinx.serialization.json.JsonNull -> false
    is JsonPrimitive -> when {
        value.isString -> value.content.isNotEmpty()
        else -> value.content != "false" && value.content != "0" && value.content.isNotEmpty()
    }
    else -> true
}

private fun firstString(
    source: Map<String, kotlinx.serialization.json.JsonElement>,
    keys: List<String>,
): String {
    for (key in keys) {
        val value = source[key] as? JsonPrimitive ?: continue
        if (!value.isString) continue
        val trimmed = value.content.trim()
        if (trimmed.isNotEmpty()) return trimmed
    }
    return ""
}
