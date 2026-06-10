package app.clawkietalkie.voice

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

// Parse handoff parameters from Clawkie-Talkie app URLs. Hash fragments are
// preferred so identifiers are not transmitted to web servers; query params
// are accepted for compatibility. If a key is present in both, the hash wins.
// Mirror of the web client's `src/voice/handoffUrl.ts`.

data class HandoffRoute(
    val hostPeerId: String,
    val sessionId: String,
    val sessionKey: String? = null,
    val channel: String? = null,
    val target: String? = null,
    val accountId: String? = null,
)

data class HostDashboardRoute(val hostPeerId: String)

private class ParsedAppUrl(
    val pathname: String,
    val query: Map<String, String>,
    val hash: Map<String, String>,
)

private fun parseQueryParams(raw: String?): Map<String, String> {
    if (raw.isNullOrEmpty()) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (pair in raw.split('&')) {
        if (pair.isEmpty()) continue
        val index = pair.indexOf('=')
        val key = if (index >= 0) pair.substring(0, index) else pair
        val value = if (index >= 0) pair.substring(index + 1) else ""
        val decodedKey = runCatching { URLDecoder.decode(key, "UTF-8") }.getOrNull() ?: continue
        val decodedValue = runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault("")
        // First occurrence wins, like URLSearchParams.get.
        out.putIfAbsent(decodedKey, decodedValue)
    }
    return out
}

private fun parseAppUrl(raw: String): ParsedAppUrl? {
    val resolved = runCatching {
        val base = URI("https://clawkietalkie.app")
        val uri = base.resolve(raw.replace(" ", "%20"))
        uri
    }.getOrNull() ?: return null

    return ParsedAppUrl(
        pathname = resolved.path ?: "/",
        query = parseQueryParams(resolved.rawQuery),
        hash = parseQueryParams(resolved.rawFragment),
    )
}

private fun readParam(parsed: ParsedAppUrl, key: String): String =
    parsed.hash[key]?.takeIf { it.isNotEmpty() } ?: parsed.query[key] ?: ""

fun parseHandoffUrl(raw: String): HandoffRoute? {
    val parsed = parseAppUrl(raw) ?: return null
    val pathname = parsed.pathname.trimEnd('/').ifEmpty { "/" }
    if (pathname != "/voice") return null

    val hostPeerId = readParam(parsed, "host").trim()
    val sessionId = readParam(parsed, "session").trim()
    val sessionKey = readParam(parsed, "sessionKey").trim()
    val channel = readParam(parsed, "channel").trim()
    val target = readParam(parsed, "target").trim()
    val accountId = readParam(parsed, "accountId").trim()
        .ifEmpty { readParam(parsed, "account").trim() }

    if (hostPeerId.isEmpty() || sessionId.isEmpty()) return null

    return HandoffRoute(
        hostPeerId = hostPeerId,
        sessionId = sessionId,
        sessionKey = sessionKey.takeIf { it.isNotEmpty() },
        channel = channel.takeIf { it.isNotEmpty() },
        target = target.takeIf { it.isNotEmpty() },
        accountId = accountId.takeIf { it.isNotEmpty() },
    )
}

fun parseHostDashboardUrl(raw: String): HostDashboardRoute? {
    val parsed = parseAppUrl(raw) ?: return null
    val pathname = parsed.pathname.trimEnd('/').ifEmpty { "/" }
    if (pathname != "/dashboard" && pathname != "/voice") return null

    val hostPeerId = readParam(parsed, "host").trim()
    val sessionId = readParam(parsed, "session").trim()
    if (hostPeerId.isEmpty() || sessionId.isNotEmpty()) return null

    return HostDashboardRoute(hostPeerId)
}

fun formatHandoffHash(handoff: HandoffRoute): String {
    val params = mutableListOf<Pair<String, String>>()
    params.add("host" to handoff.hostPeerId)
    params.add("session" to handoff.sessionId)
    handoff.sessionKey?.let { params.add("sessionKey" to it) }
    handoff.channel?.let { params.add("channel" to it) }
    handoff.target?.let { params.add("target" to it) }
    handoff.accountId?.let { params.add("accountId" to it) }
    return "#" + params.joinToString("&") { (key, value) ->
        "${urlEncodeQuery(key)}=${urlEncodeQuery(value)}"
    }
}

private fun urlEncodeQuery(value: String): String =
    URLEncoder.encode(value, "UTF-8").replace("+", "%20")
