package app.clawkietalkie.ui

import app.clawkietalkie.BuildConfig
import app.clawkietalkie.protocol.RecentSession
import app.clawkietalkie.protocol.RendezvousJoinInput
import app.clawkietalkie.protocol.SttSelection
import app.clawkietalkie.protocol.TtsSelection
import app.clawkietalkie.protocol.VoiceSettings
import app.clawkietalkie.storage.Settings
import app.clawkietalkie.voice.HandoffRoute
import app.clawkietalkie.voice.parseHandoffUrl
import app.clawkietalkie.voice.parseHostDashboardUrl

// Route/launch parsing + handoff helpers. Mirror of the route logic in the
// web client's app.tsx (parseInitialLocation, handoffToRendezvous,
// selectHandoffFromRecentSession, favoriteSessionFromHandoff).

enum class ScreenId { DASHBOARD, DRIVING, TRANSCRIPT, ERROR, HOST_ENTRY }

data class InitialLocation(
    val screen: ScreenId,
    val errorKind: ErrorKind = ErrorKind.BAD_SESSION,
    val hostPeerId: String? = null,
    val sessionId: String? = null,
    val threadId: String? = null,
    val handoff: HandoffRoute? = null,
    val debug: Boolean = false,
    val sttChunkMs: String? = null,
    val audioFixtureUrl: String? = null,
)

fun parseInitialLocation(
    url: String?,
    savedDashboardHostPeerId: String?,
    defaultDashboardHostPeerId: String? = BuildConfig.DEFAULT_HOST_ID.trim().takeIf { it.isNotEmpty() },
): InitialLocation {
    val raw = url?.trim().takeUnless { it.isNullOrEmpty() }
    if (raw != null) {
        val queryParams = parseUrlQuery(raw)
        val debug = queryParams["debug"] == "true"
        val sttChunkMs = queryParams["sttChunkMs"]
        val audioFixtureUrl = queryParams["audio-fixture"]?.takeIf { it.isNotEmpty() }
        val errorKind = if (queryParams["errorKind"] == "replaced") ErrorKind.REPLACED else ErrorKind.BAD_SESSION
        val threadId = queryParams["threadId"]?.takeIf { it.isNotEmpty() }

        val handoff = parseHandoffUrl(raw)
        if (handoff != null) {
            return InitialLocation(
                screen = ScreenId.DRIVING,
                errorKind = errorKind,
                hostPeerId = handoff.hostPeerId,
                sessionId = handoff.sessionId,
                threadId = threadId,
                handoff = handoff,
                debug = debug,
                sttChunkMs = sttChunkMs,
                audioFixtureUrl = audioFixtureUrl,
            )
        }
        val dashboard = parseHostDashboardUrl(raw)
        if (dashboard != null) {
            return InitialLocation(
                screen = ScreenId.DASHBOARD,
                errorKind = errorKind,
                hostPeerId = dashboard.hostPeerId,
                threadId = threadId,
                debug = debug,
                sttChunkMs = sttChunkMs,
            )
        }
        val pathIsDashboard = runCatching {
            java.net.URI("https://clawkietalkie.app").resolve(raw).path?.trimEnd('/') == "/dashboard"
        }.getOrDefault(false)
        val fallbackHost = savedDashboardHostPeerId?.trim()?.takeIf { it.isNotEmpty() }
            ?: defaultDashboardHostPeerId
        if (pathIsDashboard) {
            // Dashboard launch without a host in the URL: recover the saved
            // host, else ask for one (the web's address bar equivalent).
            return if (fallbackHost != null) {
                InitialLocation(
                    screen = ScreenId.DASHBOARD,
                    errorKind = errorKind,
                    hostPeerId = fallbackHost,
                    debug = debug,
                    sttChunkMs = sttChunkMs,
                )
            } else {
                InitialLocation(screen = ScreenId.HOST_ENTRY, errorKind = errorKind, debug = debug, sttChunkMs = sttChunkMs)
            }
        }
        return InitialLocation(screen = ScreenId.ERROR, errorKind = errorKind, debug = debug, sttChunkMs = sttChunkMs)
    }

    // Launcher start with no URL: recover the last dashboard host (the PWA
    // home-screen launch path in the web client); with nothing saved and no
    // build default, prompt for a host ID.
    val fallbackHost = savedDashboardHostPeerId?.trim()?.takeIf { it.isNotEmpty() }
        ?: defaultDashboardHostPeerId
    if (fallbackHost != null) {
        return InitialLocation(screen = ScreenId.DASHBOARD, hostPeerId = fallbackHost)
    }
    return InitialLocation(screen = ScreenId.HOST_ENTRY)
}

private fun parseUrlQuery(raw: String): Map<String, String> {
    val query = runCatching {
        java.net.URI("https://clawkietalkie.app").resolve(raw.replace(" ", "%20")).rawQuery
    }.getOrNull() ?: return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (pair in query.split('&')) {
        if (pair.isEmpty()) continue
        val index = pair.indexOf('=')
        val key = if (index >= 0) pair.substring(0, index) else pair
        val value = if (index >= 0) pair.substring(index + 1) else ""
        val decodedKey = runCatching { java.net.URLDecoder.decode(key, "UTF-8") }.getOrNull() ?: continue
        val decodedValue = runCatching { java.net.URLDecoder.decode(value, "UTF-8") }.getOrDefault("")
        out.putIfAbsent(decodedKey, decodedValue)
    }
    return out
}

fun handoffToRendezvous(handoff: HandoffRoute): RendezvousJoinInput = RendezvousJoinInput(
    sessionId = handoff.sessionId,
    sessionKey = handoff.sessionKey,
    channel = handoff.channel,
    target = handoff.target,
    accountId = handoff.accountId,
)

fun voiceSettingsForRtc(settings: Settings): VoiceSettings = VoiceSettings(
    voice = settings.voice.trim().takeIf { it.isNotEmpty() },
    tts = settings.tts.takeIf { it != TtsSelection() },
    stt = settings.stt.takeIf { it != SttSelection() },
)

fun selectHandoffFromRecentSession(
    current: HandoffRoute?,
    session: RecentSession,
    fallbackHostPeerId: String?,
): HandoffRoute? {
    val hostPeerId = current?.hostPeerId ?: fallbackHostPeerId ?: return current
    return HandoffRoute(
        hostPeerId = hostPeerId,
        sessionId = session.sessionId,
        sessionKey = session.sessionKey,
        channel = session.channel,
        target = session.target,
        accountId = session.accountId,
    )
}

fun favoriteSessionFromHandoff(handoff: HandoffRoute?): RecentSession? {
    val sessionId = handoff?.sessionId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val sessionKey = handoff.sessionKey?.trim()?.takeIf { it.isNotEmpty() } ?: return null

    val parsed = parseFavoriteSessionKey(sessionKey)
    val channel = handoff.channel?.trim()?.takeIf { it.isNotEmpty() } ?: parsed.channel
    val target = handoff.target?.trim()?.takeIf { it.isNotEmpty() } ?: parsed.target
    val accountId = handoff.accountId?.trim()?.takeIf { it.isNotEmpty() }
    val agent = parsed.agent ?: "unknown"

    return RecentSession(
        sessionId = sessionId,
        sessionKey = sessionKey,
        agent = agent,
        channel = channel,
        target = target,
        accountId = accountId,
        displayLabel = buildFavoriteSessionDisplayLabel(sessionKey, channel, target),
    )
}

private class ParsedSessionKey(val agent: String?, val channel: String?, val target: String?)

private fun parseFavoriteSessionKey(sessionKey: String): ParsedSessionKey {
    val parts = sessionKey.split(':').map { it.trim() }.filter { it.isNotEmpty() }
    if (parts.firstOrNull() != "agent") return ParsedSessionKey(null, null, null)
    val agent = parts.getOrNull(1)
    val channel = parts.getOrNull(2) ?: return ParsedSessionKey(agent, null, null)

    val kind = parts.getOrNull(3)
    val id = parts.lastOrNull()
    val targetKind = if (channel == "discord" && kind == "direct") "user" else kind
    val target = if (targetKind != null && id != null && id != kind) "$targetKind:$id" else null
    return ParsedSessionKey(agent, channel, target)
}

private fun buildFavoriteSessionDisplayLabel(sessionKey: String, channel: String?, target: String?): String {
    if (channel != null && target != null) return "$channel $target"
    val parts = sessionKey.split(':').map { it.trim() }.filter { it.isNotEmpty() }
    val visibleParts = if (parts.firstOrNull() == "agent") parts.drop(2) else parts
    return if (visibleParts.isNotEmpty()) visibleParts.joinToString(" ") else "Voice session"
}
