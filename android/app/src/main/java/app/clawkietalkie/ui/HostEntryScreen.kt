package app.clawkietalkie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Host ID entry. The web client receives the host through the page URL —
// the browser's address bar is its host-entry mechanism. Android has no
// address bar, so this screen is the platform translation: it appears on a
// fresh launch with no saved host, and backs the "switch host" affordances
// in the dashboard and settings. Styled with the same HIFI tokens as the
// error screens (tone pill, glyph tile, mono headline, accent primary).

@Composable
fun HostEntryScreen(
    initialValue: String = "",
    onConnect: (String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    var value by remember { mutableStateOf(initialValue) }
    val accent = Hifi.accents.getValue("amber").rec
    val trimmed = value.trim()
    val canConnect = trimmed.isNotEmpty()

    fun submit() {
        if (canConnect) onConnect(trimmed)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Hifi.bg)
            .imePadding()
            .padding(start = 22.dp, end = 22.dp, bottom = 22.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp, bottom = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "CLWK · CONNECT",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.4.sp,
                color = Hifi.ink3,
            )
            Row(
                modifier = Modifier
                    .border(1.dp, accent.a(0x55), RoundedCornerShape(20.dp))
                    .background(accent.a(0x11), RoundedCornerShape(20.dp))
                    .padding(horizontal = 10.dp, vertical = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(modifier = Modifier.size(6.dp).background(accent, CircleShape))
                Text(
                    "NO HOST",
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.4.sp,
                    color = accent,
                )
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(bottom = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterVertically),
        ) {
            Box(
                modifier = Modifier
                    .size(68.dp)
                    .background(accent.a(0x18), RoundedCornerShape(18.dp))
                    .border(1.dp, accent.a(0x44), RoundedCornerShape(18.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text("◎", fontSize = 34.sp, color = accent, fontFamily = Hifi.mono)
            }
            Text(
                "Connect to your daemon",
                fontFamily = Hifi.mono,
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.3.sp,
                lineHeight = (18 * 1.3).sp,
                color = Hifi.ink,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 300.dp),
            )
            Text(
                "Enter the host ID of your Clawkie Talkie daemon. It's the DAEMON_PEER_ID " +
                    "the daemon prints at startup — also the host= value in any voice link " +
                    "OpenClaw gives you.",
                fontFamily = Hifi.sans,
                fontSize = 14.sp,
                lineHeight = (14 * 1.5).sp,
                color = Hifi.ink2,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 300.dp),
            )

            // Host ID input — mono, surface card, stroke border (SelectRow look).
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 340.dp)
                    .background(Hifi.surface, RoundedCornerShape(12.dp))
                    .border(
                        1.dp,
                        if (canConnect) accent.a(0x66) else Hifi.strokeStrong,
                        RoundedCornerShape(12.dp),
                    )
                    .padding(horizontal = 14.dp, vertical = 14.dp),
            ) {
                if (value.isEmpty()) {
                    Text(
                        "host id",
                        fontFamily = Hifi.mono,
                        fontSize = 14.sp,
                        letterSpacing = 0.4.sp,
                        color = Hifi.ink4,
                    )
                }
                BasicTextField(
                    value = value,
                    onValueChange = { value = it.replace("\n", "") },
                    singleLine = true,
                    textStyle = TextStyle(
                        fontFamily = Hifi.mono,
                        fontSize = 14.sp,
                        letterSpacing = 0.4.sp,
                        color = Hifi.ink,
                    ),
                    cursorBrush = SolidColor(accent),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Go,
                    ),
                    keyboardActions = KeyboardActions(onGo = { submit() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .alpha(if (canConnect) 1f else 0.55f)
                    .background(accent, RoundedCornerShape(14.dp))
                    .clickable(enabled = canConnect) { submit() }
                    .padding(16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "CONNECT",
                    fontFamily = Hifi.mono,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.6.sp,
                    color = Color.Black,
                )
            }
            if (onBack != null) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp))
                        .clickable { onBack() }
                        .padding(14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "CANCEL",
                        fontFamily = Hifi.mono,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 1.4.sp,
                        color = Hifi.ink2,
                    )
                }
            }
        }
    }
}
