package app.clawkietalkie.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.StartOffset
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.max

// Shared visual components. Mirror of the web client's `Phone.tsx`
// LiveWave + ButtonAura (auraBreathe / auraPulse keyframes).

@Composable
fun LiveWave(
    intensities: DoubleArray,
    color: Color,
    height: Dp,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(height),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (value in intensities) {
            Box(modifier = Modifier.weight(1f).fillMaxSize(), contentAlignment = Alignment.Center) {
                Canvas(modifier = Modifier.fillMaxSize()) {
                    val barHeight = max(0.06f, value.toFloat()) * size.height
                    val top = (size.height - barHeight) / 2f
                    // Soft glow behind the bar (`box-shadow: 0 0 8px color66`).
                    drawRoundRect(
                        brush = Brush.verticalGradient(
                            colors = listOf(color.a(0x33), color.a(0x66), color.a(0x33)),
                            startY = max(0f, top - 6f),
                            endY = top + barHeight + 6f,
                        ),
                        topLeft = Offset(-1.5f, max(0f, top - 4f)),
                        size = Size(size.width + 3f, barHeight + 8f),
                        cornerRadius = CornerRadius(4f, 4f),
                    )
                    drawRoundRect(
                        color = color,
                        topLeft = Offset(0f, top),
                        size = Size(size.width, barHeight),
                        cornerRadius = CornerRadius(2f, 2f),
                    )
                }
            }
        }
    }
}

/**
 * Pulsing aura behind the PTT button while recording / speaking.
 * auraBreathe: 1.6 s ease-in-out blur halo; auraPulse: 1.8 s expanding rings
 * (second ring delayed 0.4 s).
 */
@Composable
fun ButtonAura(active: Boolean, color: Color, buttonSize: Dp) {
    if (!active) return
    val transition = rememberInfiniteTransition(label = "aura")

    val breatheScale by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(
            tween(800, easing = FastOutSlowInEasing),
            RepeatMode.Reverse,
        ),
        label = "breatheScale",
    )
    val breatheOpacity by transition.animateFloat(
        initialValue = 0.55f,
        targetValue = 0.75f,
        animationSpec = infiniteRepeatable(
            tween(800, easing = FastOutSlowInEasing),
            RepeatMode.Reverse,
        ),
        label = "breatheOpacity",
    )
    val pulseProgress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(1800, easing = LinearEasing),
            RepeatMode.Restart,
        ),
        label = "pulse1",
    )
    val pulseProgress2 by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(1800, easing = LinearEasing),
            RepeatMode.Restart,
            initialStartOffset = StartOffset(400),
        ),
        label = "pulse2",
    )

    Canvas(modifier = Modifier.fillMaxSize()) {
        val center = Offset(size.width / 2f, size.height / 2f)
        val buttonRadiusPx = buttonSize.toPx() / 2f

        // auraBreathe — radial glow extending 28px beyond the button, blurred.
        val breatheRadius = (buttonRadiusPx + 28.dp.toPx()) * breatheScale
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    color.copy(alpha = breatheOpacity),
                    color.copy(alpha = breatheOpacity * 0.45f),
                    Color.Transparent,
                ),
                center = center,
                radius = breatheRadius,
            ),
            radius = breatheRadius,
            center = center,
        )

        // auraPulse ring 1 — inset -56px, scale 0.92 → 1.22, opacity 0.5·0.3 → 0.
        run {
            val baseRadius = buttonRadiusPx + 56.dp.toPx()
            val scale = 0.92f + 0.30f * pulseProgress
            val alpha = (0.5f * (1f - pulseProgress)) * 0.3f
            drawCircle(
                color = color.copy(alpha = alpha),
                radius = baseRadius * scale,
                center = center,
                style = Stroke(width = 1.5.dp.toPx()),
            )
        }

        // auraPulse ring 2 — inset -84px, delayed 0.4s, opacity factor 0.15.
        run {
            val baseRadius = buttonRadiusPx + 84.dp.toPx()
            val scale = 0.92f + 0.30f * pulseProgress2
            val alpha = (0.5f * (1f - pulseProgress2)) * 0.15f
            drawCircle(
                color = color.copy(alpha = alpha),
                radius = baseRadius * scale,
                center = center,
                style = Stroke(width = 1.dp.toPx()),
            )
        }
    }
}
