package app.clawkietalkie

import android.view.KeyEvent
import app.clawkietalkie.voice.isPttMediaKeyCode
import app.clawkietalkie.voice.shouldTriggerPttForKeyEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Headset media-button → PTT mapping. The action itself is the same
// callback as the on-screen button (state semantics covered by
// DrivingReducerTest); these tests pin which physical buttons fire it.

class PttMediaKeysTest {
    @Test
    fun `primary play pause and hook keys act as ptt`() {
        assertTrue(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_PLAY))
        assertTrue(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_PAUSE))
        assertTrue(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        assertTrue(isPttMediaKeyCode(KeyEvent.KEYCODE_HEADSETHOOK))
    }

    @Test
    fun `next previous stop and volume keys are left alone`() {
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_NEXT))
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_PREVIOUS))
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_STOP))
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD))
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_MEDIA_REWIND))
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_VOLUME_UP))
        assertFalse(isPttMediaKeyCode(KeyEvent.KEYCODE_VOLUME_DOWN))
    }

    @Test
    fun `only the initial key-down of a press triggers`() {
        assertTrue(
            shouldTriggerPttForKeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 0),
        )
        // key-up must not double-fire
        assertFalse(
            shouldTriggerPttForKeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 0),
        )
        // auto-repeat while held must not re-fire
        assertFalse(
            shouldTriggerPttForKeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 1),
        )
        // unrelated keys never trigger, even on key-down
        assertFalse(
            shouldTriggerPttForKeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_NEXT, 0),
        )
    }
}
