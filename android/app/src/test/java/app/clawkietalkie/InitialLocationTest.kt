package app.clawkietalkie

import app.clawkietalkie.ui.ErrorKind
import app.clawkietalkie.ui.ScreenId
import app.clawkietalkie.ui.parseInitialLocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// Launch routing: URL host > saved host > build default > host entry prompt.

class InitialLocationTest {
    @Test
    fun `voice link with host and session routes to driving`() {
        val initial = parseInitialLocation(
            url = "https://clawkietalkie.app/voice#host=H&session=S",
            savedDashboardHostPeerId = "saved-host",
            defaultDashboardHostPeerId = "default-host",
        )
        assertEquals(ScreenId.DRIVING, initial.screen)
        assertEquals("H", initial.hostPeerId)
        assertEquals("S", initial.sessionId)
        assertNotNull(initial.handoff)
    }

    @Test
    fun `dashboard link with host wins over saved and default`() {
        val initial = parseInitialLocation(
            url = "https://clawkietalkie.app/dashboard#host=url-host",
            savedDashboardHostPeerId = "saved-host",
            defaultDashboardHostPeerId = "default-host",
        )
        assertEquals(ScreenId.DASHBOARD, initial.screen)
        assertEquals("url-host", initial.hostPeerId)
    }

    @Test
    fun `dashboard link without host falls back to saved then default`() {
        val saved = parseInitialLocation(
            url = "https://clawkietalkie.app/dashboard",
            savedDashboardHostPeerId = "saved-host",
            defaultDashboardHostPeerId = "default-host",
        )
        assertEquals(ScreenId.DASHBOARD, saved.screen)
        assertEquals("saved-host", saved.hostPeerId)

        val default = parseInitialLocation(
            url = "https://clawkietalkie.app/dashboard",
            savedDashboardHostPeerId = null,
            defaultDashboardHostPeerId = "default-host",
        )
        assertEquals(ScreenId.DASHBOARD, default.screen)
        assertEquals("default-host", default.hostPeerId)
    }

    @Test
    fun `dashboard link with no host anywhere prompts for a host`() {
        val initial = parseInitialLocation(
            url = "https://clawkietalkie.app/dashboard",
            savedDashboardHostPeerId = null,
            defaultDashboardHostPeerId = null,
        )
        assertEquals(ScreenId.HOST_ENTRY, initial.screen)
        assertNull(initial.hostPeerId)
    }

    @Test
    fun `launcher start recovers the saved host`() {
        val initial = parseInitialLocation(
            url = null,
            savedDashboardHostPeerId = "saved-host",
            defaultDashboardHostPeerId = null,
        )
        assertEquals(ScreenId.DASHBOARD, initial.screen)
        assertEquals("saved-host", initial.hostPeerId)
    }

    @Test
    fun `fresh launcher start with nothing saved prompts for a host`() {
        val initial = parseInitialLocation(
            url = null,
            savedDashboardHostPeerId = null,
            defaultDashboardHostPeerId = null,
        )
        assertEquals(ScreenId.HOST_ENTRY, initial.screen)
        assertNull(initial.hostPeerId)
    }

    @Test
    fun `malformed voice link still surfaces the bad-session error`() {
        val initial = parseInitialLocation(
            url = "https://clawkietalkie.app/voice#session=only-session",
            savedDashboardHostPeerId = null,
            defaultDashboardHostPeerId = null,
        )
        assertEquals(ScreenId.ERROR, initial.screen)
        assertEquals(ErrorKind.BAD_SESSION, initial.errorKind)
    }

    @Test
    fun `blank saved host is ignored`() {
        val initial = parseInitialLocation(
            url = null,
            savedDashboardHostPeerId = "   ",
            defaultDashboardHostPeerId = null,
        )
        assertEquals(ScreenId.HOST_ENTRY, initial.screen)
    }
}
