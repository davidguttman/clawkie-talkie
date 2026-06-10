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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.storage.Storage
import app.clawkietalkie.storage.TranscriptSessionMeta
import app.clawkietalkie.storage.formatTimestamp

// Local transcript history. Mirror of the web client's History.tsx.

@Composable
fun HistoryScreen(
    storage: Storage,
    onBack: () -> Unit,
    onOpenSession: (String) -> Unit,
    compact: Boolean,
) {
    val sessions = remember { storage.listTranscriptSessions() }

    Column(modifier = Modifier.fillMaxSize().background(Hifi.bg)) {
        ScreenHeader(title = "History", subtitle = "LOCAL DEVICE", onBack = onBack)
        ScrollBody(pad = if (compact) 2.dp else 22.dp) {
            if (sessions.isEmpty()) {
                ListEmptyState(
                    glyph = "≡",
                    title = "No local history",
                    body = "Saved conversations will appear here after a voice reply finishes on this phone.",
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (session in sessions) {
                        HistoryItem(session = session, compact = compact) {
                            onOpenSession(session.id)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryItem(
    session: TranscriptSessionMeta,
    compact: Boolean,
    onOpen: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp))
            .background(Hifi.surface, RoundedCornerShape(14.dp))
            .clickable { onOpen() }
            .padding(if (compact) 12.dp else 14.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = compactSessionLabel(session.id),
                fontFamily = Hifi.mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = Hifi.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text(
                text = "${session.turnCount} TURNS",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                letterSpacing = 1.sp,
                color = Hifi.ink3,
                modifier = Modifier.padding(start = 12.dp),
            )
        }
        Text(
            text = session.preview,
            fontFamily = Hifi.sans,
            fontSize = 13.sp,
            lineHeight = (13 * 1.45).sp,
            color = Hifi.ink2,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = formatTimestamp(session.updatedAt),
            fontFamily = Hifi.mono,
            fontSize = 10.sp,
            letterSpacing = 0.8.sp,
            color = Hifi.ink4,
            modifier = Modifier.padding(top = 10.dp),
        )
    }
}

@Composable
fun ListEmptyState(glyph: String, title: String, body: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(52.dp)
                .border(1.dp, Hifi.stroke, RoundedCornerShape(14.dp))
                .background(Hifi.surface, RoundedCornerShape(14.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(glyph, fontFamily = Hifi.mono, fontSize = 22.sp, color = Hifi.ink3)
        }
        Text(
            title,
            fontFamily = Hifi.mono,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp,
            color = Hifi.ink,
        )
        Text(
            body,
            fontFamily = Hifi.sans,
            fontSize = 13.sp,
            lineHeight = (13 * 1.5).sp,
            color = Hifi.ink2,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp),
        )
    }
}

fun compactSessionLabel(sessionId: String): String {
    val trimmed = sessionId.trim()
    if (trimmed.length <= 22) return trimmed.uppercase()
    return "${trimmed.take(10)}...${trimmed.takeLast(8)}".uppercase()
}
