package app.clawkietalkie.voice

// Pure state reducer for the Driving screen. Mirror of the web client's
// `src/voice/drivingReducer.ts` — exposed independently of any UI framework
// so it can be unit-tested.
//
// States:
//   IDLE       → waiting for the user to tap start
//   RECORDING  → mic is open; daemon is recording audio for OpenClaw infer STT
//   THINKING   → mic closed; daemon running chat on the transcript
//   AI         → daemon running OpenClaw infer TTS; phone is playing audio

enum class DrivingState { IDLE, RECORDING, THINKING, AI }

data class DrivingContext(
    val state: DrivingState = DrivingState.IDLE,
    val lastUserText: String = "",
    val lastReplyText: String = "",
    // Reply text received before audio starts. Kept hidden until tts.start.
    val pendingReplyText: String = "",
    // Render label source for the AI caption.
    val liveReplyText: String = "",
    val error: String? = null,
)

val initialDrivingContext = DrivingContext()

sealed interface DrivingReplayEvent

sealed interface DrivingEvent {
    data class Tap(val currentTurnTranscribing: Boolean = false) : DrivingEvent, DrivingReplayEvent
    data object Silence : DrivingEvent, DrivingReplayEvent
    data class SttDone(val text: String) : DrivingEvent, DrivingReplayEvent
    data class SttError(val reason: String) : DrivingEvent, DrivingReplayEvent
    data class ReplyDone(val text: String) : DrivingEvent, DrivingReplayEvent
    data class ReplyError(val reason: String) : DrivingEvent, DrivingReplayEvent
    data class TtsStart(val text: String? = null) : DrivingEvent, DrivingReplayEvent
    data object TtsDone : DrivingEvent, DrivingReplayEvent
    data class TtsError(val reason: String) : DrivingEvent, DrivingReplayEvent
    data class SessionReplay(
        val events: List<DrivingReplayEvent>,
        val hydration: DrivingHydration? = null,
    ) : DrivingEvent

    data object SessionReset : DrivingEvent
}

data class DrivingHydration(
    val context: DrivingContext,
    val armTts: Boolean = false,
)

enum class DrivingSideEffect { START_MIC, STOP_MIC, CANCEL_MIC, ARM_TTS, STOP_TTS, CANCEL_REPLY }

data class Reduction(val next: DrivingContext, val side: List<DrivingSideEffect>)

fun reduce(ctx: DrivingContext, event: DrivingEvent): Reduction {
    if (event is DrivingEvent.SessionReplay) return reduceSessionReplay(ctx, event)
    if (event is DrivingEvent.SessionReset) return Reduction(initialDrivingContext, emptyList())

    return when (ctx.state) {
        DrivingState.IDLE -> when (event) {
            is DrivingEvent.Tap -> Reduction(
                ctx.copy(
                    state = DrivingState.RECORDING,
                    error = null,
                    pendingReplyText = "",
                    liveReplyText = "",
                ),
                listOf(DrivingSideEffect.START_MIC),
            )
            is DrivingEvent.TtsStart -> Reduction(
                if (!event.text.isNullOrEmpty()) {
                    ctx.copy(
                        state = DrivingState.AI,
                        lastReplyText = event.text,
                        liveReplyText = event.text,
                        error = null,
                    )
                } else {
                    ctx.copy(state = DrivingState.AI, error = null)
                },
                emptyList(),
            )
            else -> Reduction(ctx, emptyList())
        }

        DrivingState.RECORDING -> when (event) {
            is DrivingEvent.Tap -> Reduction(
                ctx.copy(state = DrivingState.THINKING),
                listOf(DrivingSideEffect.STOP_MIC),
            )
            is DrivingEvent.SttError -> Reduction(
                ctx.copy(state = DrivingState.IDLE, error = event.reason),
                listOf(DrivingSideEffect.CANCEL_MIC),
            )
            else -> Reduction(ctx, emptyList())
        }

        DrivingState.THINKING -> when (event) {
            is DrivingEvent.SttDone ->
                // Final transcript arrives while already in `thinking`. Don't
                // start anything new — daemon pipelines chat automatically.
                Reduction(ctx.copy(lastUserText = event.text), emptyList())
            is DrivingEvent.ReplyDone -> Reduction(
                ctx.copy(pendingReplyText = event.text, liveReplyText = ""),
                listOf(DrivingSideEffect.ARM_TTS),
            )
            is DrivingEvent.TtsStart -> {
                val replyText = ctx.pendingReplyText.ifEmpty { event.text ?: "" }
                if (replyText.isEmpty()) Reduction(ctx, emptyList())
                else Reduction(
                    ctx.copy(
                        state = DrivingState.AI,
                        lastReplyText = replyText,
                        liveReplyText = replyText,
                        pendingReplyText = "",
                    ),
                    emptyList(),
                )
            }
            is DrivingEvent.ReplyError -> Reduction(
                ctx.copy(
                    state = DrivingState.IDLE,
                    error = event.reason,
                    pendingReplyText = "",
                    liveReplyText = "",
                ),
                emptyList(),
            )
            is DrivingEvent.SttError -> Reduction(
                ctx.copy(
                    state = DrivingState.IDLE,
                    error = event.reason,
                    pendingReplyText = "",
                    liveReplyText = "",
                ),
                emptyList(),
            )
            is DrivingEvent.TtsDone -> Reduction(
                ctx.copy(state = DrivingState.IDLE, pendingReplyText = "", liveReplyText = ""),
                emptyList(),
            )
            is DrivingEvent.TtsError ->
                // Audio synthesis is non-fatal once the reply itself was
                // generated: promote the pending reply into the visible
                // "last AI turn" and surface a soft audio error.
                Reduction(
                    ctx.copy(
                        state = DrivingState.IDLE,
                        error = event.reason,
                        lastReplyText = ctx.pendingReplyText.ifEmpty { ctx.lastReplyText },
                        pendingReplyText = "",
                        liveReplyText = "",
                    ),
                    emptyList(),
                )
            is DrivingEvent.Tap -> {
                if (event.currentTurnTranscribing) Reduction(ctx, emptyList())
                else Reduction(
                    // Double-tap from thinking bails out of the turn after
                    // the authoritative STT final has arrived.
                    ctx.copy(state = DrivingState.IDLE, pendingReplyText = "", liveReplyText = ""),
                    listOf(DrivingSideEffect.CANCEL_REPLY),
                )
            }
            else -> Reduction(ctx, emptyList())
        }

        DrivingState.AI -> when (event) {
            is DrivingEvent.Tap, DrivingEvent.Silence -> Reduction(
                ctx.copy(state = DrivingState.IDLE),
                listOf(DrivingSideEffect.STOP_TTS),
            )
            DrivingEvent.TtsDone -> Reduction(ctx.copy(state = DrivingState.IDLE), emptyList())
            is DrivingEvent.TtsError -> Reduction(
                ctx.copy(state = DrivingState.IDLE, error = event.reason, liveReplyText = ""),
                emptyList(),
            )
            else -> Reduction(ctx, emptyList())
        }
    }
}

private fun isTerminalReplayEvent(event: DrivingReplayEvent): Boolean =
    event is DrivingEvent.TtsDone
        || event is DrivingEvent.TtsError
        || event is DrivingEvent.ReplyError
        || event is DrivingEvent.SttError

private fun reduceSessionReplay(ctx: DrivingContext, event: DrivingEvent.SessionReplay): Reduction {
    var next = ctx
    var side = mutableListOf<DrivingSideEffect>()
    val hasTerminalReplayEvent = event.events.any { isTerminalReplayEvent(it) }
    for (replayEvent in event.events) {
        val reduced = reduce(next, replayEvent as DrivingEvent)
        next = reduced.next
        side.addAll(reduced.side)
    }
    val hydration = event.hydration
    if (hydration != null) {
        val terminalReplayWins = hasTerminalReplayEvent &&
            next.state == DrivingState.IDLE &&
            hydration.context.state != DrivingState.IDLE
        if (terminalReplayWins) {
            next = next.copy(pendingReplyText = "", liveReplyText = "")
        } else {
            next = hydration.context
            if (hydration.armTts && DrivingSideEffect.ARM_TTS !in side) {
                side.add(DrivingSideEffect.ARM_TTS)
            }
        }
        if ((!hydration.armTts || terminalReplayWins) &&
            next.state == DrivingState.IDLE &&
            next.pendingReplyText.isEmpty()
        ) {
            side = side.filter { it != DrivingSideEffect.ARM_TTS }.toMutableList()
        }
    }
    return Reduction(next, side)
}
