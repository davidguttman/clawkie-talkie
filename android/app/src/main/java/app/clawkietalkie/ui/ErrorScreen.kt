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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Invalid handoff and runtime failure states. Mirror of the web client's
// ErrorScreen.tsx (six error kinds, three tone categories).

enum class ErrorKind { MIC_DENIED, OFFLINE, STT_FAILED, TTS_FAILED, BAD_SESSION, REPLACED }

private enum class ErrorTone { BLOCKED, DEGRADED, INFO }

private enum class PrimaryAction { RETRY, BACK, DISMISS }

private class ErrorDef(
    val tone: ErrorTone,
    val pill: String,
    val glyph: String,
    val headline: String,
    val body: String,
    val detail: String? = null,
    val primaryLabel: String,
    val primaryAction: PrimaryAction,
    val secondaryLabel: String? = null,
)

private fun errorDef(kind: ErrorKind): ErrorDef = when (kind) {
    ErrorKind.MIC_DENIED -> ErrorDef(
        tone = ErrorTone.BLOCKED,
        pill = "MIC BLOCKED",
        glyph = "⊘",
        headline = "Can't hear you",
        body = "Clawkie-Talkie needs microphone access. Enable it in Settings, then come back.",
        primaryLabel = "OPEN SETTINGS",
        primaryAction = PrimaryAction.DISMISS,
        secondaryLabel = "NOT NOW",
    )
    ErrorKind.OFFLINE -> ErrorDef(
        tone = ErrorTone.DEGRADED,
        pill = "OFFLINE",
        glyph = "⇢",
        headline = "No connection",
        body = "We saved what you said. As soon as you're back online, the AI will reply.",
        primaryLabel = "TRY AGAIN",
        primaryAction = PrimaryAction.RETRY,
    )
    ErrorKind.STT_FAILED -> ErrorDef(
        tone = ErrorTone.DEGRADED,
        pill = "RETRY",
        glyph = "≈",
        headline = "Couldn't catch that",
        body = "Say it again — try to speak closer to the mic and cut engine noise if you can.",
        detail = "STT error · 504",
        primaryLabel = "TAP TO RETRY",
        primaryAction = PrimaryAction.RETRY,
        secondaryLabel = "CANCEL",
    )
    ErrorKind.TTS_FAILED -> ErrorDef(
        tone = ErrorTone.INFO,
        pill = "AUDIO OFF",
        glyph = "◌",
        headline = "Can't play audio",
        body = "Your reply is ready — it's in the transcript. Audio playback hit an error; the text is all saved.",
        primaryLabel = "READ IT",
        primaryAction = PrimaryAction.DISMISS,
        secondaryLabel = "DISMISS",
    )
    ErrorKind.BAD_SESSION -> ErrorDef(
        tone = ErrorTone.BLOCKED,
        pill = "SESSION UNAVAILABLE",
        glyph = "⚠",
        headline = "Clawkie-Talkie can’t join this session",
        body = "The handoff details are missing or unavailable. Go back to your chat and open the voice link again.",
        primaryLabel = "GOT IT",
        primaryAction = PrimaryAction.DISMISS,
    )
    ErrorKind.REPLACED -> ErrorDef(
        tone = ErrorTone.BLOCKED,
        pill = "REPLACED",
        glyph = "⇄",
        headline = "Opened on another phone",
        body = "This phone was disconnected because a newer phone joined the same Clawkie-Talkie session.",
        primaryLabel = "RELOAD",
        primaryAction = PrimaryAction.RETRY,
    )
}

@Composable
fun ErrorScreen(
    kind: ErrorKind,
    onDismiss: (() -> Unit)? = null,
    onRetry: (() -> Unit)? = null,
    onBack: (() -> Unit)? = null,
) {
    val def = errorDef(kind)
    val toneColor = when (def.tone) {
        ErrorTone.BLOCKED -> Hifi.errorRed
        ErrorTone.DEGRADED -> Hifi.accents.getValue("amber").rec
        ErrorTone.INFO -> Hifi.ink2
    }
    val primary = when (def.primaryAction) {
        PrimaryAction.RETRY -> onRetry
        PrimaryAction.BACK -> onBack
        PrimaryAction.DISMISS -> onDismiss
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Hifi.bg)
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
                "CLWK · ERROR",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.4.sp,
                color = Hifi.ink3,
            )
            Row(
                modifier = Modifier
                    .border(1.dp, toneColor.a(0x55), RoundedCornerShape(20.dp))
                    .background(toneColor.a(0x11), RoundedCornerShape(20.dp))
                    .padding(horizontal = 10.dp, vertical = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(modifier = Modifier.size(6.dp).background(toneColor, CircleShape))
                Text(
                    def.pill,
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.4.sp,
                    color = toneColor,
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
                    .background(toneColor.a(0x18), RoundedCornerShape(18.dp))
                    .border(1.dp, toneColor.a(0x44), RoundedCornerShape(18.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(def.glyph, fontSize = 34.sp, color = toneColor, fontFamily = Hifi.mono)
            }
            Text(
                def.headline,
                fontFamily = Hifi.mono,
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.3.sp,
                lineHeight = (18 * 1.3).sp,
                color = Hifi.ink,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 280.dp),
            )
            Text(
                def.body,
                fontFamily = Hifi.sans,
                fontSize = 14.sp,
                lineHeight = (14 * 1.5).sp,
                color = Hifi.ink2,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 280.dp),
            )
            if (def.detail != null) {
                Text(
                    def.detail,
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    letterSpacing = 0.4.sp,
                    color = Hifi.ink3,
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .widthIn(max = 280.dp)
                        .background(Hifi.surface, RoundedCornerShape(8.dp))
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(8.dp))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(toneColor, RoundedCornerShape(14.dp))
                    .let { if (primary != null) it.clickable { primary() } else it }
                    .padding(16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    def.primaryLabel,
                    fontFamily = Hifi.mono,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.6.sp,
                    color = Color.Black,
                )
            }
            if (def.secondaryLabel != null) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp))
                        .let { if (onDismiss != null) it.clickable { onDismiss() } else it }
                        .padding(14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        def.secondaryLabel,
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
