package app.clawkietalkie.ui

import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Layout classification + desktop phone-frame shell. Mirrors the web
// client's `responsive.ts` (`computeIsNarrow`) and `components/Phone.tsx`
// (`HiFiPhone`): touch devices always get the narrow runtime shell —
// regardless of width — so rotating or resizing never remounts the active
// recording; wide pointer-driven screens (desktop-class Android) get the
// centered phone frame with default metrics inside.

const val NARROW_WIDTH_DP = 900

fun computeIsNarrow(context: Context, widthDp: Int): Boolean {
    // `(pointer: coarse)` equivalent: a touchscreen-first device.
    val touch = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
    if (touch) return true
    return widthDp < NARROW_WIDTH_DP
}

/** DesktopPhoneShell + HiFiPhone: centered 390×844 OLED frame. */
@Composable
fun DesktopPhoneShell(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Hifi.bg)
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        HiFiPhone(content)
    }
}

@Composable
private fun HiFiPhone(content: @Composable () -> Unit) {
    // Outer bezel: 390×844, radius 52, 9px frame, subtle ring shadow.
    Box(
        modifier = Modifier
            .size(width = 390.dp, height = 844.dp)
            .background(Color.Black, RoundedCornerShape(52.dp))
            .padding(9.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(44.dp))
                .background(Hifi.bg),
        ) {
            // App content, inset below the status bar and above the home
            // indicator (paddingTop 54 / paddingBottom 20).
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(top = 54.dp, bottom = 20.dp),
            ) {
                content()
            }
            // Status bar
            Row(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .height(54.dp)
                    .padding(start = 30.dp, end = 30.dp, top = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "9:41",
                    fontFamily = Hifi.mono,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Hifi.ink,
                    modifier = Modifier.weight(1f),
                )
                StatusBarIcons()
            }
            // Dynamic island
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 11.dp)
                    .size(width = 122.dp, height = 36.dp)
                    .background(Color.Black, RoundedCornerShape(22.dp)),
            )
            // Home indicator
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 8.dp)
                    .size(width = 134.dp, height = 5.dp)
                    .background(Color.White.copy(alpha = 0.85f), RoundedCornerShape(3.dp)),
            )
        }
    }
}

@Composable
private fun StatusBarIcons() {
    val color = Hifi.ink.copy(alpha = 0.85f)
    // Signal strength bars (16×11 viewBox: M1 10V8 M5 10V6 M9 10V4 M13 10V1).
    Canvas(modifier = Modifier.size(width = 16.dp, height = 11.dp)) {
        val unit = size.width / 16f
        val bars = listOf(1f to 8f, 5f to 6f, 9f to 4f, 13f to 1f)
        for ((x, topY) in bars) {
            drawLine(
                color = color,
                start = Offset(x * unit, 10f * size.height / 11f),
                end = Offset(x * unit, topY * size.height / 11f),
                strokeWidth = 1.5f * unit,
                cap = StrokeCap.Round,
            )
        }
    }
    Box(modifier = Modifier.size(6.dp))
    // Battery (22×11: outline rect 18×10 r2.5 + fill rect 15×7 r1.2).
    Canvas(modifier = Modifier.size(width = 22.dp, height = 11.dp)) {
        val unit = size.width / 22f
        drawRoundRect(
            color = color.copy(alpha = color.alpha * 0.5f),
            topLeft = Offset(0.5f * unit, 0.5f * unit),
            size = Size(18f * unit, 10f * unit),
            cornerRadius = CornerRadius(2.5f * unit, 2.5f * unit),
            style = Stroke(width = 1f * unit),
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(2f * unit, 2f * unit),
            size = Size(15f * unit, 7f * unit),
            cornerRadius = CornerRadius(1.2f * unit, 1.2f * unit),
        )
    }
}
