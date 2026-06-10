package app.clawkietalkie

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import app.clawkietalkie.ui.ClawkieAppRoot
import app.clawkietalkie.ui.Hifi
import app.clawkietalkie.ui.ScreenId
import app.clawkietalkie.ui.parseInitialLocation
import app.clawkietalkie.voice.MicAudio

class MainActivity : ComponentActivity() {
    private var launchUrl by mutableStateOf<String?>(null)
    private var launchGeneration by mutableStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        launchUrl = intent?.dataString

        setContent {
            val app = application as ClawkieApp
            val initial = rememberInitial(launchUrl, launchGeneration)
            MaterialTheme(
                colorScheme = darkColorScheme(
                    background = Hifi.bg,
                    surface = Hifi.surface,
                    onBackground = Hifi.ink,
                    onSurface = Hifi.ink,
                ),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Hifi.bg)
                        .safeDrawingPadding(),
                ) {
                    ClawkieAppRoot(
                        storage = app.storage,
                        factory = app.peerConnectionFactory,
                        initial = initial,
                        onFinish = { finish() },
                    )
                }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun rememberInitial(url: String?, generation: Int) =
        androidx.compose.runtime.remember(url, generation) {
            val app = application as ClawkieApp
            val initial = parseInitialLocation(
                url = url,
                savedDashboardHostPeerId = app.storage.loadLastDashboardHostPeerId(),
            )
            if (initial.hostPeerId != null &&
                (initial.screen == ScreenId.DASHBOARD || initial.screen == ScreenId.DRIVING)
            ) {
                app.storage.saveLastDashboardHostPeerId(initial.hostPeerId)
            }
            initial
        }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val data = intent.dataString
        if (data != null) {
            launchUrl = data
            launchGeneration += 1
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) MicAudio.release()
    }
}
