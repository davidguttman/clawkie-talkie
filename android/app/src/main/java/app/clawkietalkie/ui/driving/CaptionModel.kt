package app.clawkietalkie.ui.driving

import androidx.compose.ui.graphics.Color
import app.clawkietalkie.storage.TranscriptRole
import app.clawkietalkie.ui.Hifi
import app.clawkietalkie.voice.DrivingState
import app.clawkietalkie.voice.Turn

// Caption selection. Mirror of `pickCaption` in the web Driving.tsx.

const val LIVE_USER_CAPTION_LABEL = "YOU · LIVE"
const val AI_RESPONSE_CAPTION_LABEL = "AI · READING ALOUD"

data class CaptionData(
    val label: String,
    val color: Color,
    val text: String?,
    val live: Boolean,
)

fun pickCaption(
    state: DrivingState,
    stateColor: Color,
    liveText: String,
    isTranscribing: Boolean,
    lastTurn: Turn?,
    accentRec: Color,
): CaptionData = when {
    state == DrivingState.RECORDING -> CaptionData(
        label = LIVE_USER_CAPTION_LABEL,
        color = accentRec,
        text = liveText.ifEmpty { null },
        live = true,
    )
    state == DrivingState.AI -> CaptionData(
        label = AI_RESPONSE_CAPTION_LABEL,
        color = stateColor,
        text = liveText.ifEmpty { null },
        live = true,
    )
    state == DrivingState.THINKING -> CaptionData(
        label = if (isTranscribing) "TRANSCRIBING · OPENCLAW" else "THINKING",
        color = stateColor,
        text = liveText.ifEmpty { null },
        live = isTranscribing,
    )
    lastTurn != null -> CaptionData(
        label = if (lastTurn.who == TranscriptRole.USER) "YOU · LAST" else "AI · LAST",
        color = Hifi.ink3,
        text = lastTurn.text.ifEmpty { null },
        live = false,
    )
    else -> CaptionData(label = "READY", color = Hifi.ink3, text = null, live = false)
}
