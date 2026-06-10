package app.clawkietalkie.voice

import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.view.KeyEvent

// Bluetooth headset / AirPods stem media-button control for the voice
// screen. A plain framework MediaSession is registered while the Driving
// screen is active; the headset play/pause button then triggers the exact
// same action callback as the big on-screen PTT button (no parallel PTT
// logic lives here). The session is released the moment the screen goes
// away, handing media buttons back to whatever app owned them before.

/** Key codes that should act as a PTT press (headset primary button). */
fun isPttMediaKeyCode(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_MEDIA_PLAY,
    KeyEvent.KEYCODE_MEDIA_PAUSE,
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
    KeyEvent.KEYCODE_HEADSETHOOK,
    -> true
    else -> false
}

/**
 * A media-button KeyEvent triggers PTT only on the initial key-down of a
 * primary play/pause/hook press — never on key-up, auto-repeat, or
 * next/previous (AirPods double/triple press), which are left unhandled.
 */
fun shouldTriggerPttForKeyEvent(action: Int, keyCode: Int, repeatCount: Int): Boolean =
    action == KeyEvent.ACTION_DOWN && repeatCount == 0 && isPttMediaKeyCode(keyCode)

class PttMediaSession(
    context: Context,
    private val onPttPress: () -> Unit,
) {
    // Some Bluetooth stacks deliver a single physical press both as a raw
    // KeyEvent and as a transport-control callback; collapse anything that
    // lands within this window into one press. Human re-presses are slower.
    private val dedupeWindowMs = 200L
    private var lastPressAtMs = 0L

    private val session = MediaSession(context, "clawkie-ptt").apply {
        setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                val event: KeyEvent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }
                if (event != null &&
                    shouldTriggerPttForKeyEvent(event.action, event.keyCode, event.repeatCount)
                ) {
                    press()
                    return true
                }
                // Consume the key-up halves of handled presses so the default
                // handler doesn't synthesize a second transport action.
                if (event != null && isPttMediaKeyCode(event.keyCode)) return true
                return super.onMediaButtonEvent(mediaButtonIntent)
            }

            // AVRCP transport controls (no KeyEvent attached on some stacks).
            override fun onPlay() = press()
            override fun onPause() = press()
        })
    }

    private fun press() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastPressAtMs < dedupeWindowMs) return
        lastPressAtMs = now
        onPttPress()
    }

    /**
     * Claim media buttons. An active session advertising a "playing" state
     * is what Android routes headset buttons to; while the voice screen is
     * up this takes priority over background media apps, which is the
     * point of a walkie-talkie surface in the car.
     */
    fun activate() {
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or
                        PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_STOP,
                )
                .setState(PlaybackState.STATE_PLAYING, 0L, 1f)
                .build(),
        )
        session.isActive = true
    }

    fun release() {
        runCatching {
            session.setPlaybackState(
                PlaybackState.Builder()
                    .setState(PlaybackState.STATE_STOPPED, 0L, 0f)
                    .build(),
            )
            session.isActive = false
        }
        runCatching { session.release() }
    }
}
