package app.clawkietalkie.ui.driving

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.rtc.RtcStatus
import app.clawkietalkie.ui.Hifi
import app.clawkietalkie.ui.a
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.min

// Caption area of the Driving screen: bounded scrollable live transcript with
// blinking caret, AI-response reading autoscroll, and the connection/error
// banner with RECONNECT pill. Mirror of `Caption` in the web Driving.tsx.

private const val AI_AUTOSCROLL_START_WORDS = 18
private const val AI_AUTOSCROLL_INTERVAL_MS = 250L
private const val PROGRAMMATIC_SCROLL_GRACE_MS = 120L

@Composable
fun DrivingCaption(
    caption: CaptionData,
    error: String?,
    daemonConnected: Boolean,
    hasRtcClient: Boolean,
    rtcStatus: RtcStatus,
    canRetryConnection: Boolean,
    onRetryConnection: () -> Unit,
    compact: Boolean,
) {
    // Everything (STT, chat, TTS) terminates on the daemon. Surface the
    // daemon connection state first, then whatever runtime error the loop
    // reports.
    val isDaemonBlocker = !daemonConnected &&
        (error == "daemon_not_connected" || !hasRtcClient || rtcStatus != RtcStatus.OPEN)
    val errorMessage = when {
        isDaemonBlocker && hasRtcClient -> "CONNECTING TO DAEMON · ${rtcStatus.name}"
        isDaemonBlocker -> "NO DAEMON — OPEN A DAEMON JOIN URL TO ENABLE TRANSCRIPTION"
        error != null -> errorLabelFor(error)
        else -> null
    }

    val fontSize = if (compact) 22.sp else 16.sp
    val lineHeight = if (compact) (22 * 1.35).sp else (16 * 1.5).sp
    val scrollState = rememberScrollState()
    val scope = rememberCoroutineScope()

    val isAiResponse = caption.label == AI_RESPONSE_CAPTION_LABEL
    val isLiveUser = caption.label == LIVE_USER_CAPTION_LABEL
    var autoScrollDisabled by remember(caption.label, caption.live) { mutableStateOf(false) }
    var programmaticScrollUntil by remember { mutableStateOf(0L) }

    fun programmaticScrollTo(target: Int) {
        programmaticScrollUntil = System.currentTimeMillis() + PROGRAMMATIC_SCROLL_GRACE_MS
        scope.launch { scrollState.scrollTo(target) }
    }

    // Manual scroll/touch opts out of autoscroll for the current capture.
    LaunchedEffect(scrollState.isScrollInProgress, caption.live) {
        if (!caption.live) return@LaunchedEffect
        if (scrollState.isScrollInProgress && System.currentTimeMillis() > programmaticScrollUntil) {
            autoScrollDisabled = true
        }
    }

    // New AI response: reset opt-out and jump to top.
    var lastAiText by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(isAiResponse, caption.text) {
        if (!isAiResponse) {
            lastAiText = null
            return@LaunchedEffect
        }
        val responseText = caption.text ?: ""
        if (lastAiText == responseText) return@LaunchedEffect
        lastAiText = responseText
        autoScrollDisabled = false
        programmaticScrollTo(0)
    }

    // Live user text: keep the bottom in view while transcribing.
    LaunchedEffect(isLiveUser, caption.live, caption.text) {
        if (!isLiveUser || !caption.live) return@LaunchedEffect
        if (caption.text == null || autoScrollDisabled) return@LaunchedEffect
        if (scrollState.maxValue > 0) programmaticScrollTo(scrollState.maxValue)
    }

    // AI response reading autoscroll: estimate reading position from elapsed
    // time at the configured words-per-minute and ease toward it.
    LaunchedEffect(isAiResponse, caption.live, caption.text) {
        if (!isAiResponse || !caption.live || caption.text == null) return@LaunchedEffect
        val totalWords = caption.text.trim().split(Regex("\\s+")).count { it.isNotEmpty() }
        if (totalWords <= AI_AUTOSCROLL_START_WORDS) return@LaunchedEffect
        val wpm = if (compact) 135.0 else 175.0
        val viewportAnchor = if (compact) 0.5 else 0.38
        val easing = if (compact) 0.22 else 0.3
        val startedAt = System.currentTimeMillis()
        while (true) {
            delay(AI_AUTOSCROLL_INTERVAL_MS)
            if (autoScrollDisabled) return@LaunchedEffect
            val maxScroll = scrollState.maxValue
            if (maxScroll <= 0) continue
            val elapsedMs = System.currentTimeMillis() - startedAt
            val estimatedWordsSpoken = elapsedMs / 60000.0 * wpm
            if (estimatedWordsSpoken < AI_AUTOSCROLL_START_WORDS) continue
            val contentHeight = maxScroll + scrollState.viewportSize
            val readingProgress = min(estimatedWordsSpoken / totalWords, 1.0)
            val approximateReadingY = readingProgress * contentHeight
            val target = (approximateReadingY - scrollState.viewportSize * viewportAnchor)
                .coerceIn(0.0, maxScroll.toDouble())
            if (target <= scrollState.value) continue
            val eased = scrollState.value + (target - scrollState.value) * easing
            programmaticScrollTo(min(target, eased).toInt())
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState),
            ) {
                Text(
                    text = caption.text ?: "",
                    color = Hifi.ink,
                    fontSize = fontSize,
                    lineHeight = lineHeight,
                    fontWeight = FontWeight.Normal,
                    fontFamily = Hifi.mono,
                    modifier = Modifier.weight(1f),
                )
                if (caption.live && caption.text != null) {
                    BlinkingCaret(color = caption.color, height = fontSize.value.dp)
                }
                Spacer(modifier = Modifier.width(10.dp))
            }
            // Right border framing the transcript (`border-right` in CSS).
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .width(1.dp)
                    .fillMaxSize()
                    .background(Hifi.stroke),
            )
        }
        if (errorMessage != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = errorMessage,
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    letterSpacing = 1.sp,
                    color = Hifi.errorRed,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(max = if (compact) 32.dp else 36.dp),
                )
                if (canRetryConnection) {
                    val red = Hifi.accents.getValue("red").rec
                    Text(
                        text = "RECONNECT",
                        fontFamily = Hifi.mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp,
                        color = red,
                        modifier = Modifier
                            .padding(start = 8.dp)
                            .border(1.dp, red.a(0x66), RoundedCornerShape(999.dp))
                            .background(red.a(0x14), RoundedCornerShape(999.dp))
                            .clickable { onRetryConnection() }
                            .padding(
                                horizontal = if (compact) 8.dp else 10.dp,
                                vertical = if (compact) 6.dp else 7.dp,
                            ),
                    )
                }
            }
        }
    }
}

@Composable
private fun BlinkingCaret(color: Color, height: androidx.compose.ui.unit.Dp) {
    // `caret 0.9s step-end infinite` — hard on/off blink, no fade.
    val transition = rememberInfiniteTransition(label = "caret")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
        label = "caretPhase",
    )
    val visible = phase < 0.5f
    Box(
        modifier = Modifier
            .padding(start = 2.dp)
            .width(8.dp)
            .height(height)
            .background(if (visible) color else Color.Transparent),
    )
}
