package app.clawkietalkie.ui.driving

import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.protocol.RecentSession
import app.clawkietalkie.rtc.RtcSession
import app.clawkietalkie.storage.RecentSessionFavoriteState
import app.clawkietalkie.ui.Hifi
import app.clawkietalkie.ui.LiveWave
import app.clawkietalkie.ui.a
import app.clawkietalkie.voice.DrivingController
import app.clawkietalkie.voice.DrivingState
import app.clawkietalkie.voice.HoldMusic
import app.clawkietalkie.voice.HoldMusicCatalog
import app.clawkietalkie.voice.PttMediaSession
import app.clawkietalkie.voice.playPttPressTone
import kotlin.math.min

// Runtime driving surface driven by the daemon-owned state machine.
// Mirror of the web client's `src/screens/Driving.tsx`.

data class DrivingManualReplay(
    val text: String,
    val mode: String,
    val currentBands: () -> DoubleArray?,
    val onSilence: () -> Unit,
)

private val REPLAY_FALLBACK_INTENSITIES = doubleArrayOf(
    0.18, 0.28, 0.44, 0.62, 0.5, 0.34, 0.24,
    0.2, 0.3, 0.48, 0.66, 0.52, 0.36, 0.26,
    0.26, 0.36, 0.52, 0.66, 0.48, 0.3, 0.2,
    0.24, 0.34, 0.5, 0.62, 0.44, 0.28, 0.18,
)

@Composable
fun DrivingScreen(
    controller: DrivingController,
    rtc: RtcSession,
    accent: String = "amber",
    onReplay: (() -> Unit)? = null,
    canReplay: Boolean = false,
    manualReplay: DrivingManualReplay? = null,
    restoredAssistantText: String? = null,
    onSessions: () -> Unit,
    onSettings: () -> Unit,
    compact: Boolean,
    sessionId: String?,
    favoriteSession: RecentSession? = null,
    debugMode: Boolean = false,
    sttChunkConfig: app.clawkietalkie.voice.SttChunkConfig? = null,
) {
    val accentCfg = Hifi.accents[accent] ?: Hifi.accents.getValue("amber")
    val loop by controller.state.collectAsState()
    val rtcState by rtc.state.collectAsState()
    val context = LocalContext.current

    var holdMusicMuted by remember { mutableStateOf(HoldMusic.getMuted()) }
    var holdMusicTrack by remember { mutableStateOf(HoldMusic.getCurrentTrack()) }
    DisposableEffect(Unit) {
        val unsubMute = HoldMusic.subscribeMuted { holdMusicMuted = it }
        val unsubTrack = HoldMusic.subscribeCurrentTrack { holdMusicTrack = it }
        onDispose {
            unsubMute()
            unsubTrack()
        }
    }

    val replayActive = manualReplay != null
    val displayState = if (replayActive) DrivingState.AI else loop.state
    val displayTap: () -> Unit = if (replayActive) manualReplay!!.onSilence else controller::tap

    val recentSessions = rtcState.recentSessions
    val activeSession: RecentSessionFavoriteState? = recentSessions.firstOrNull {
        it.session.sessionId == sessionId || it.session.sessionKey == sessionId
    }
    val favoriteSessionTarget = activeSession?.session ?: favoriteSession
    val activeSessionFavorite = activeSession?.favorite == true
    val headerLabel = buildHeaderLabel(activeSession?.session)
    val restoredAssistantPreview = restoredAssistantText?.trim()?.takeIf { it.isNotEmpty() }
        ?: activeSession?.session?.lastAssistantPreview?.trim()?.takeIf { it.isNotEmpty() }
        ?: favoriteSession?.lastAssistantPreview?.trim()?.takeIf { it.isNotEmpty() }
    val restoredLastTurn = if (loop.state == DrivingState.IDLE && restoredAssistantPreview != null) {
        app.clawkietalkie.voice.Turn(app.clawkietalkie.storage.TranscriptRole.ASSISTANT, restoredAssistantPreview)
    } else null

    val displayIntensities = if (replayActive) {
        manualReplay!!.currentBands() ?: REPLAY_FALLBACK_INTENSITIES
    } else loop.intensities

    val isRec = displayState == DrivingState.RECORDING
    val isAi = displayState == DrivingState.AI
    val isThink = displayState == DrivingState.THINKING

    val stateColor = when {
        isRec -> accentCfg.rec
        isAi -> Hifi.ai
        isThink -> Hifi.think
        else -> Hifi.ink3
    }
    val stateGlow = when {
        isRec -> accentCfg.recGlow
        isAi -> Hifi.aiGlow
        isThink -> Hifi.thinkGlow
        else -> Color.Transparent
    }

    // Compact uses the shorter "REPLY" label — the full "READING REPLY"
    // wouldn't fit alongside the CLWK label and gear button on narrow phones.
    val statePill = when {
        isRec -> "REC"
        isAi -> if (compact) "REPLY" else "READING REPLY"
        isThink -> "THINKING"
        else -> "READY"
    }
    val btnLabel = when {
        isRec -> "TAP TO STOP"
        isAi -> "TAP TO SILENCE"
        isThink -> "THINKING…"
        else -> "TAP TO TALK"
    }

    val caption = pickCaption(
        state = displayState,
        stateColor = stateColor,
        liveText = manualReplay?.text ?: loop.liveText,
        isTranscribing = if (replayActive) false else loop.isTranscribing,
        lastTurn = if (replayActive) null else (loop.lastTurn ?: restoredLastTurn),
        accentRec = accentCfg.rec,
    )

    val showHoldMusicTrack = displayState == DrivingState.THINKING && holdMusicTrack != null
    val trackLabel = holdMusicTrack?.let { HoldMusicCatalog.trackLabel(it) }

    val rowGap = if (compact) 8.dp else 10.dp
    // Compact gutter raised from 2 → 8 so the status pill + gear always sit
    // well inside the viewport on narrow phones.
    val sidePad = if (compact) 8.dp else 22.dp
    val replayEnabled = onReplay != null && canReplay

    val pressFeedback: () -> Unit = {
        playPttPressTone()
        runCatching {
            val vibrator = context.getSystemService(Vibrator::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(18, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(18)
            }
        }
    }

    // Single PTT press action shared by the on-screen button and the
    // Bluetooth headset media button — identical semantics in every state
    // (thinking presses toggle hold-music mute, like the on-screen button).
    val pttPress: () -> Unit = {
        if (displayState == DrivingState.THINKING) {
            HoldMusic.setMuted(!HoldMusic.getMuted())
        } else {
            displayTap()
        }
    }

    // Headset / AirPods stem play-pause acts as a PTT press while this
    // screen is up. The session is scoped to the screen's composition so
    // media buttons return to the previous owner when leaving.
    val headsetPress by rememberUpdatedState<() -> Unit> {
        if (displayState != DrivingState.THINKING) pressFeedback()
        pttPress()
    }
    DisposableEffect(Unit) {
        val mediaSession = PttMediaSession(context) { headsetPress() }
        mediaSession.activate()
        onDispose { mediaSession.release() }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val pttButtonSize = pttButtonSize(compact, maxWidth.value, maxHeight.value).dp

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = sidePad,
                    end = sidePad,
                    top = if (compact) 8.dp else 12.dp,
                    bottom = if (compact) 10.dp else 14.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(rowGap),
        ) {
            DrivingHeader(
                statePill = statePill,
                stateColor = stateColor,
                pulsing = isRec || isAi || isThink,
                headerLabel = headerLabel,
                compact = compact,
                onSettings = onSettings,
            )

            // Caption — bounded (weight 1) so live text scrolls instead of
            // moving controls; bottom border frames the transcript.
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .drawBehind {
                        drawLine(
                            color = Hifi.stroke,
                            start = androidx.compose.ui.geometry.Offset(0f, size.height),
                            end = androidx.compose.ui.geometry.Offset(size.width, size.height),
                            strokeWidth = 1.dp.toPx(),
                        )
                    }
                    .padding(bottom = if (compact) 8.dp else 10.dp),
            ) {
                DrivingCaption(
                    caption = caption,
                    error = loop.error,
                    daemonConnected = loop.daemonConnected,
                    hasRtcClient = rtcState.hasClient,
                    rtcStatus = rtcState.status,
                    canRetryConnection = rtcState.canRetryConnection,
                    onRetryConnection = rtc::retryConnection,
                    compact = compact,
                )
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(if (compact) 50.dp else 54.dp),
            ) {
                LiveWave(
                    intensities = displayIntensities,
                    color = stateColor,
                    height = if (compact) 30.dp else 34.dp,
                )
                if (showHoldMusicTrack && trackLabel != null) {
                    Text(
                        text = "♪ $trackLabel ♪",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.8.sp,
                        fontFamily = Hifi.mono,
                        color = stateColor,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp)
                            .alpha(0.8f),
                    )
                }
            }

            // BIG BUTTON — centered inside a flexible row (weight 1.2 like
            // the web grid) so breathing room stays balanced.
            Box(
                modifier = Modifier
                    .weight(1.2f)
                    .fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                PttButton(
                    onPress = pttPress,
                    holdMusicMuted = holdMusicMuted,
                    state = displayState,
                    stateColor = stateColor,
                    stateGlow = stateGlow,
                    label = btnLabel,
                    size = pttButtonSize,
                    onPressFeedback = pressFeedback,
                )
            }

            if (debugMode) {
                AudioDebugPanel(
                    compact = compact,
                    state = displayState,
                    rtcStatus = rtcState.status,
                    sttChunkConfig = sttChunkConfig,
                )
            }

            // Footer — compact action strip.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FooterButton(
                    icon = "↺",
                    label = "REPLAY",
                    onClick = if (replayEnabled) onReplay else null,
                    compact = compact,
                    modifier = Modifier.weight(1f),
                )
                FooterButton(
                    icon = if (activeSessionFavorite) "★" else "☆",
                    label = "FAVORITE",
                    selected = activeSessionFavorite && favoriteSessionTarget != null,
                    onClick = favoriteSessionTarget?.let { target ->
                        { rtc.toggleRecentSessionFavorite(target) }
                    },
                    compact = compact,
                    modifier = Modifier.weight(1f),
                )
                FooterButton(
                    icon = "▦",
                    label = "SESSIONS",
                    onClick = onSessions,
                    compact = compact,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** clamp(164px, min(52vw, 29dvh), 208px) compact / clamp(188px, min(42vw, 30dvh), 208px). */
private fun pttButtonSize(compact: Boolean, vwDp: Float, vhDp: Float): Float {
    return if (compact) {
        min(208f, kotlin.math.max(164f, min(0.52f * vwDp, 0.29f * vhDp)))
    } else {
        min(208f, kotlin.math.max(188f, min(0.42f * vwDp, 0.30f * vhDp)))
    }
}

private fun buildHeaderLabel(activeSession: RecentSession?): String {
    val displayLabel = activeSession?.displayLabel?.trim()?.takeIf { it.isNotEmpty() }
    val agent = activeSession?.agent?.trim()?.takeIf { it.isNotEmpty() }
    return when {
        displayLabel != null && agent != null -> "$agent - $displayLabel"
        displayLabel != null -> displayLabel
        agent != null -> agent
        else -> "VOICE SESSION"
    }
}

@Composable
private fun DrivingHeader(
    statePill: String,
    stateColor: Color,
    pulsing: Boolean,
    headerLabel: String,
    compact: Boolean,
    onSettings: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
    ) {
        // Centered session label behind the pill/gear (ellipsized).
        Text(
            text = headerLabel,
            fontFamily = Hifi.mono,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 1.2.sp,
            color = Hifi.ink2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .align(Alignment.Center)
                .padding(horizontal = if (compact) 98.dp else 140.dp),
        )
        // Status pill (left).
        Row(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .widthIn(max = if (compact) 96.dp else 140.dp)
                .border(1.dp, stateColor.a(0x55), RoundedCornerShape(20.dp))
                .background(stateColor.a(0x11), RoundedCornerShape(20.dp))
                .padding(horizontal = 9.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PulseDot(color = stateColor, pulsing = pulsing)
            Text(
                text = statePill,
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                color = stateColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // Settings gear (right).
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .size(48.dp)
                .border(1.dp, Hifi.stroke, RoundedCornerShape(15.dp))
                .clickable { onSettings() },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "⚙",
                fontSize = 26.sp,
                lineHeight = 26.sp,
                color = Hifi.ink2,
            )
        }
    }
}

@Composable
fun PulseDot(color: Color, pulsing: Boolean, size: androidx.compose.ui.unit.Dp = 6.dp) {
    // `pulseDot 1.2s ease-in-out infinite`: opacity 1→0.45, scale 1→1.3.
    if (!pulsing) {
        Box(modifier = Modifier.size(size).background(color, CircleShape))
        return
    }
    val transition = rememberInfiniteTransition(label = "pulseDot")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "pulseDotPhase",
    )
    val opacity = 1f - 0.55f * phase
    val scale = 1f + 0.3f * phase
    Box(
        modifier = Modifier
            .size(size)
            .scale(scale)
            .alpha(opacity)
            .background(color, CircleShape),
    )
}

@Composable
private fun FooterButton(
    icon: String,
    label: String,
    onClick: (() -> Unit)?,
    compact: Boolean,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
) {
    val disabled = onClick == null
    val borderColor = if (selected) Hifi.ai.a(0xAA) else Hifi.stroke
    val background = if (selected) Hifi.ai.a(0x18) else Hifi.surface
    val contentColor = when {
        disabled -> Hifi.ink4
        selected -> Hifi.ai
        else -> Hifi.ink
    }
    Row(
        modifier = modifier
            .height(if (compact) 50.dp else 60.dp)
            .border(1.dp, borderColor, RoundedCornerShape(14.dp))
            .background(background, RoundedCornerShape(14.dp))
            .alpha(if (disabled) 0.55f else 1f)
            .let { if (onClick != null) it.clickable { onClick() } else it },
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = icon,
            fontSize = if (compact) 15.sp else 18.sp,
            fontFamily = Hifi.sans,
            color = contentColor,
        )
        Text(
            text = label,
            fontFamily = Hifi.mono,
            fontSize = if (compact) 9.sp else 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = if (compact) 1.sp else 1.4.sp,
            color = contentColor,
            modifier = Modifier.padding(start = if (compact) 6.dp else 12.dp),
        )
    }
}
