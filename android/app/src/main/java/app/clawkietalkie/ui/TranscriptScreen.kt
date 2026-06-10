package app.clawkietalkie.ui

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.storage.ExportSettings
import app.clawkietalkie.storage.Settings
import app.clawkietalkie.storage.Storage
import app.clawkietalkie.storage.TranscriptSession
import app.clawkietalkie.storage.TranscriptTurn
import app.clawkietalkie.storage.TranscriptRole
import app.clawkietalkie.storage.exportTranscript
import app.clawkietalkie.storage.formatTimestamp

// Saved transcript viewer + export. Mirror of the web client's
// Transcript.tsx; the export downloads become an Android share sheet.

@Composable
fun TranscriptScreen(
    storage: Storage,
    sessionId: String?,
    onBack: () -> Unit,
    compact: Boolean,
    settings: Settings,
) {
    val session = remember(sessionId) {
        sessionId?.let { storage.loadTranscriptSession(it) }
    }
    val subtitle = sessionId?.let { compactSessionLabel(it) } ?: "NO SESSION"
    val canExport = session != null && session.turns.isNotEmpty()
    val context = LocalContext.current

    Column(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
        ScreenHeader(
            title = "Transcript",
            subtitle = subtitle,
            onBack = onBack,
            right = {
                Box(
                    modifier = Modifier
                        .height(36.dp)
                        .border(1.dp, Hifi.stroke, RoundedCornerShape(10.dp))
                        .background(Hifi.surface, RoundedCornerShape(10.dp))
                        .let { modifier ->
                            if (canExport) {
                                modifier.clickable {
                                    session?.let { shareTranscript(context, it, settings) }
                                }
                            } else modifier
                        }
                        .padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "EXPORT",
                        fontFamily = Hifi.mono,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp,
                        color = if (canExport) Hifi.ink else Hifi.ink4,
                    )
                }
            },
        )
        ScrollBody(pad = if (compact) 2.dp else 22.dp) {
            if (session == null || session.turns.isEmpty()) {
                ListEmptyState(
                    glyph = "↺",
                    title = "No transcript saved",
                    body = "This phone has not saved any turns for this session yet.",
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (turn in session.turns) {
                        TurnBubble(turn = turn, showTimestamp = settings.timestamps)
                    }
                }
            }
        }
    }
}

@Composable
private fun TurnBubble(turn: TranscriptTurn, showTimestamp: Boolean) {
    val isAssistant = turn.role == TranscriptRole.ASSISTANT
    val borderColor = if (isAssistant) Hifi.ai.copy(alpha = 0.3f) else Hifi.stroke
    val background = if (isAssistant) Hifi.ai.copy(alpha = 0.09f) else Hifi.surface
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, borderColor, RoundedCornerShape(14.dp))
            .background(background, RoundedCornerShape(14.dp))
            .padding(horizontal = 13.dp, vertical = 12.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(bottom = 7.dp),
        ) {
            Text(
                if (isAssistant) "AI" else "YOU",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                color = if (isAssistant) Hifi.ai else Hifi.ink3,
            )
            if (showTimestamp) {
                Text(
                    formatTimestamp(turn.createdAt),
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    letterSpacing = 1.2.sp,
                    color = Hifi.ink4,
                )
            }
            turn.error?.let {
                Text(
                    it,
                    fontFamily = Hifi.mono,
                    fontSize = 10.sp,
                    letterSpacing = 1.2.sp,
                    color = Hifi.errorRed,
                )
            }
        }
        Text(
            text = turn.text.ifEmpty { "(no text)" },
            fontFamily = Hifi.sans,
            fontSize = 14.sp,
            lineHeight = (14 * 1.55).sp,
            color = Hifi.ink,
        )
    }
}

private fun shareTranscript(
    context: android.content.Context,
    session: TranscriptSession,
    settings: Settings,
) {
    val exported = exportTranscript(session, ExportSettings(settings.format, settings.timestamps))
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = exported.mime
        putExtra(Intent.EXTRA_SUBJECT, exported.filename)
        putExtra(Intent.EXTRA_TEXT, exported.body)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, exported.filename))
    }
}
