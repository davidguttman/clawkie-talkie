package app.clawkietalkie.ui.driving

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.clawkietalkie.rtc.RtcStatus
import app.clawkietalkie.ui.Hifi
import app.clawkietalkie.voice.DaemonTtsAudio
import app.clawkietalkie.voice.DrivingState
import app.clawkietalkie.voice.SttChunkConfig
import kotlinx.coroutines.delay

// Audio debug panel (behind the `debug=true` link param). Mirror of the
// web client's AudioDebugPanel — refreshed twice a second.

@Composable
fun AudioDebugPanel(
    compact: Boolean,
    state: DrivingState,
    rtcStatus: RtcStatus,
    sttChunkConfig: SttChunkConfig?,
) {
    var snapshot by remember { mutableStateOf(DaemonTtsAudio.debugSnapshot()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            snapshot = DaemonTtsAudio.debugSnapshot()
        }
    }

    val rows = listOf(
        "present" to snapshot.present.toString(),
        "suppressed" to snapshot.suppressed.toString(),
        "sink" to snapshot.sinkAttached.toString(),
        "framesLive" to snapshot.framesLive.toString(),
        "lastFrameAge" to (snapshot.lastFrameAgeMs?.let { "${it}ms" } ?: "n/a"),
        "trackState" to (snapshot.trackState ?: "n/a"),
        "drivingState" to state.name.lowercase(),
        "rtc" to rtcStatus.name.lowercase(),
        "sttChunking" to (sttChunkConfig?.let { "${it.chunkMs}ms ~${it.chunkBytes}B" } ?: "default"),
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                drawLine(
                    color = Hifi.stroke,
                    start = androidx.compose.ui.geometry.Offset(0f, 0f),
                    end = androidx.compose.ui.geometry.Offset(size.width, 0f),
                    strokeWidth = 1.dp.toPx(),
                )
            }
            .padding(top = if (compact) 7.dp else 9.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "AUDIO DEBUG",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                color = Hifi.ink,
            )
            Text(
                "REMOTE TTS " + if (snapshot.present) "READY" else "WAITING",
                fontFamily = Hifi.mono,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                color = if (snapshot.present) Hifi.ai else Hifi.ink3,
            )
        }
        Column(
            modifier = Modifier
                .heightIn(max = if (compact) 118.dp else 132.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                "remoteTtsAudio",
                fontFamily = Hifi.mono,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
                color = Hifi.ink3,
                modifier = Modifier.padding(bottom = 3.dp),
            )
            for ((label, value) in rows) {
                Row(modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp)) {
                    Text(
                        label,
                        fontSize = 10.sp,
                        lineHeight = (10 * 1.35).sp,
                        color = Hifi.ink4,
                        fontFamily = Hifi.mono,
                        modifier = Modifier.width(82.dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        value,
                        fontSize = 10.sp,
                        lineHeight = (10 * 1.35).sp,
                        color = Hifi.ink2,
                        fontFamily = Hifi.mono,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
