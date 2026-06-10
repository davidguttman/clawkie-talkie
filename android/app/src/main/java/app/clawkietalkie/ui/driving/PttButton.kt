package app.clawkietalkie.ui.driving

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.ui.ButtonAura
import app.clawkietalkie.ui.Hifi
import app.clawkietalkie.ui.a
import app.clawkietalkie.voice.DrivingState

// The big tap-to-talk button. Mirror of `PTTButton` in the web Driving.tsx:
// idle dark radial gradient, state-colored gradient + glow when active,
// press scale 0.94 (fast in / springy out), aura while recording or
// speaking, thinking-state music mute toggle.

@Composable
fun PttButton(
    onPress: () -> Unit,
    holdMusicMuted: Boolean,
    state: DrivingState,
    stateColor: Color,
    stateGlow: Color,
    label: String,
    size: Dp,
    onPressFeedback: () -> Unit,
) {
    val isIdle = state == DrivingState.IDLE
    val isRec = state == DrivingState.RECORDING
    val isAi = state == DrivingState.AI
    val isThink = state == DrivingState.THINKING

    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()

    LaunchedEffect(pressed) {
        if (pressed && !isThink) onPressFeedback()
    }

    val pressScale by animateFloatAsState(
        targetValue = if (pressed) 0.94f else if (isRec) 1.02f else 1f,
        animationSpec = if (pressed) tween(60) else tween(240),
        label = "pttScale",
    )

    Box(contentAlignment = Alignment.Center) {
        Box(modifier = Modifier.size(size + 168.dp)) {
            ButtonAura(active = isRec || isAi, color = stateColor, buttonSize = size)
        }
        Box(
            modifier = Modifier
                .size(size)
                .scale(pressScale),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val radius = this.size.minDimension / 2f
                val center = Offset(this.size.width / 2f, this.size.height / 2f)
                if (isIdle) {
                    // Drop shadow under the idle puck.
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent),
                            center = center.copy(y = center.y + (if (pressed) 8f else 18f)),
                            radius = radius * 1.12f,
                        ),
                        radius = radius * 1.12f,
                        center = center.copy(y = center.y + (if (pressed) 8f else 18f)),
                    )
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                if (pressed) Color(0xFF2A2A2E) else Color(0xFF1A1A1D),
                                Color(0xFF0A0A0B),
                            ),
                            center = Offset(this.size.width * 0.30f, this.size.height * 0.28f),
                            radius = radius * 1.7f,
                        ),
                        radius = radius,
                        center = center,
                    )
                    drawCircle(
                        color = Hifi.strokeStrong,
                        radius = radius,
                        center = center,
                        style = Stroke(width = 1.dp.toPx()),
                    )
                } else {
                    // Outer glow (`0 0 44px glow`, brighter when pressed).
                    val glowRadius = radius + (if (pressed) 60.dp else 44.dp).toPx() * 0.55f
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(stateGlow, Color.Transparent),
                            center = center,
                            radius = glowRadius,
                        ),
                        radius = glowRadius,
                        center = center,
                    )
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(stateColor, stateColor.a(0x88)),
                            center = Offset(this.size.width * 0.30f, this.size.height * 0.28f),
                            radius = radius * 1.7f,
                        ),
                        radius = radius,
                        center = center,
                    )
                    drawCircle(
                        color = stateColor.a(0x66),
                        radius = radius,
                        center = center,
                        style = Stroke(width = 1.dp.toPx()),
                    )
                }
            }
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(androidx.compose.foundation.shape.CircleShape)
                    .clickable(
                        interactionSource = interactionSource,
                        indication = null,
                    ) {
                        onPress()
                    },
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = pttGlyph(state, holdMusicMuted),
                        fontSize = 48.sp,
                        lineHeight = 48.sp,
                        fontWeight = FontWeight.Medium,
                        fontFamily = Hifi.mono,
                        color = if (isIdle) Hifi.ink else Color.Black,
                    )
                    Text(
                        text = if (isThink) {
                            if (holdMusicMuted) "TAP FOR MUSIC" else "TAP TO MUTE"
                        } else label,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.8.sp,
                        fontFamily = Hifi.mono,
                        color = if (isIdle) Hifi.ink else Color.Black,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
        }
    }
}

private fun pttGlyph(state: DrivingState, holdMusicMuted: Boolean): String = when (state) {
    DrivingState.RECORDING -> "■" // filled square
    DrivingState.AI -> "◉" // fisheye circle
    DrivingState.THINKING -> if (holdMusicMuted) "⊘" else "◐" // slashed / half circle
    DrivingState.IDLE -> "●" // filled circle
}
