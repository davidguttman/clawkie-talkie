package app.clawkietalkie.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Wire protocol for the WebRTC DataChannel between the phone and daemon.
// Mirror of the web client's `src/voice/protocol.ts` (which itself mirrors
// `daemon/src/protocol.ts`). Control messages are loosely-typed JSON objects
// with a `t` discriminator; unknown fields must be tolerated so a newer
// client keeps working against an older daemon.

const val PROTOCOL_VERSION = 1

object ProtocolFeatures {
    const val TTS_CATALOG = "tts.catalog"
    const val STT_CATALOG = "stt.catalog"
    const val SESSIONS_LIST = "sessions.list"
    const val SESSIONS_CATALOG = "sessions.catalog"
    const val SESSIONS_DESTINATIONS = "sessions.destinations"
    const val SESSIONS_CREATE = "sessions.create"
}

val CLIENT_WANTED_PROTOCOL_FEATURES = listOf(
    ProtocolFeatures.TTS_CATALOG,
    ProtocolFeatures.STT_CATALOG,
    ProtocolFeatures.SESSIONS_LIST,
    ProtocolFeatures.SESSIONS_CATALOG,
    ProtocolFeatures.SESSIONS_DESTINATIONS,
    ProtocolFeatures.SESSIONS_CREATE,
)

fun isDaemonSupportedProtocol(protocol: Int?): Boolean = protocol == PROTOCOL_VERSION

val protocolJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
}

/**
 * A decoded control message. Equivalent to the web client's
 * `ControlMessage { t: string; [key: string]: unknown }`.
 */
class ControlMessage(val fields: JsonObject) {
    val t: String = (fields["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""

    fun string(key: String): String? =
        (fields[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun number(key: String): Double? =
        (fields[key] as? JsonPrimitive)?.content?.toDoubleOrNull()?.takeIf { it.isFinite() }

    fun int(key: String): Int? = number(key)?.toInt()

    fun boolean(key: String): Boolean? =
        (fields[key] as? JsonPrimitive)?.takeIf { !it.isString }?.let {
            runCatching { it.boolean }.getOrNull()
        }

    fun obj(key: String): JsonObject? = fields[key] as? JsonObject

    fun array(key: String): JsonArray? = fields[key] as? JsonArray

    fun encode(): String = protocolJson.encodeToString(JsonObject.serializer(), fields)

    companion object {
        fun parse(text: String): ControlMessage? = runCatching {
            val element = protocolJson.parseToJsonElement(text)
            if (element is JsonObject) ControlMessage(element) else null
        }.getOrNull()

        fun of(builder: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): ControlMessage =
            ControlMessage(buildJsonObject(builder))
    }
}

// ---------------------------------------------------------------------------
// Typed payloads (decoded from control messages)
// ---------------------------------------------------------------------------

data class DeliveryTarget(
    val channel: String,
    val target: String,
    val accountId: String? = null,
)

data class RendezvousJoinInput(
    val sessionId: String,
    val sessionKey: String? = null,
    val channel: String? = null,
    val target: String? = null,
    val accountId: String? = null,
    val delivery: DeliveryTarget? = null,
)

data class TtsSelection(
    val providerId: String? = null,
    val model: String? = null,
    val voice: String? = null,
)

data class SttSelection(
    val providerId: String? = null,
    val model: String? = null,
)

data class VoiceSettings(
    val voice: String? = null,
    val tts: TtsSelection? = null,
    val stt: SttSelection? = null,
) {
    val isEmpty: Boolean
        get() = voice == null && tts == null && stt == null
}

data class TtsCatalogVoice(val id: String, val name: String)

data class TtsCatalogProvider(
    val id: String,
    val name: String,
    val configured: Boolean,
    val selected: Boolean,
    val available: Boolean,
    val models: List<String>,
    val voices: List<TtsCatalogVoice>,
)

data class TtsCatalog(
    val activeProvider: String?,
    val generatedAt: String,
    val providers: List<TtsCatalogProvider>,
)

data class SttCatalogProvider(
    val id: String,
    val name: String,
    val configured: Boolean,
    val selected: Boolean,
    val available: Boolean,
    val models: List<String>,
)

data class SttCatalog(
    val activeProvider: String?,
    val generatedAt: String,
    val providers: List<SttCatalogProvider>,
)

data class RecentSession(
    val sessionId: String,
    val sessionKey: String,
    val agent: String,
    val channel: String? = null,
    val target: String? = null,
    val accountId: String? = null,
    val lastActivity: String? = null,
    val displayLabel: String,
    val lastMessagePreview: String? = null,
    val lastMessageRole: String? = null,
    val lastAssistantPreview: String? = null,
)

data class RecentSessionsSnapshot(
    val generatedAt: String,
    val sessions: List<RecentSession>,
)

data class NewSessionDestinationOption(
    val id: String,
    val target: String,
    val label: String,
    val accountId: String? = null,
    val group: String? = null,
)

data class NewSessionDestinationProvider(
    val id: String,
    val label: String,
    val kind: String,
    val status: String,
    val statusDetail: String? = null,
    val destinations: List<NewSessionDestinationOption>,
)

data class NewSessionDestinationsCatalog(
    val generatedAt: String,
    val providers: List<NewSessionDestinationProvider>,
)

data class NewSessionCreateInput(
    val requestId: String,
    val providerId: String,
    val agent: String? = null,
    val target: String? = null,
    val accountId: String? = null,
)

fun webOnlyNewSessionDestinationsCatalog(): NewSessionDestinationsCatalog = NewSessionDestinationsCatalog(
    generatedAt = "",
    providers = listOf(
        NewSessionDestinationProvider(
            id = "webchat",
            label = "Web only (no chat channel)",
            kind = "local",
            status = "available",
            destinations = emptyList(),
        ),
    ),
)

// ---------------------------------------------------------------------------
// Phone → daemon message builders (mirror of `phoneToDaemon` in protocol.ts)
// ---------------------------------------------------------------------------

object PhoneToDaemon {
    fun clientHello(wants: List<String> = CLIENT_WANTED_PROTOCOL_FEATURES): ControlMessage =
        ControlMessage.of {
            put("t", "client.hello")
            put("protocol", PROTOCOL_VERSION)
            putJsonArray("wants") { wants.forEach { add(JsonPrimitive(it)) } }
        }

    fun rendezvousJoin(input: RendezvousJoinInput, settings: VoiceSettings?): ControlMessage =
        ControlMessage.of {
            put("t", "rendezvous.join")
            put("sessionId", input.sessionId)
            input.sessionKey?.let { put("sessionKey", it) }
            input.channel?.let { put("channel", it) }
            input.target?.let { put("target", it) }
            input.accountId?.let { put("accountId", it) }
            input.delivery?.let { delivery ->
                put("delivery", buildJsonObject {
                    put("channel", delivery.channel)
                    put("target", delivery.target)
                    delivery.accountId?.let { put("accountId", it) }
                })
            }
            if (settings != null && !settings.isEmpty) put("settings", voiceSettingsJson(settings))
        }

    fun settingsUpdate(settings: VoiceSettings): ControlMessage = ControlMessage.of {
        put("t", "settings.update")
        put("settings", voiceSettingsJson(settings))
    }

    fun ttsCatalogRequest(): ControlMessage = simple("tts.catalog.request")
    fun sttCatalogRequest(): ControlMessage = simple("stt.catalog.request")
    fun sessionsListRequest(): ControlMessage = simple("sessions.list.request")
    fun sessionsCatalogRequest(): ControlMessage = simple("sessions.catalog.request")
    fun sessionsListSubscribe(): ControlMessage = simple("sessions.list.subscribe")
    fun sessionsListUnsubscribe(): ControlMessage = simple("sessions.list.unsubscribe")
    fun sessionsDestinationsRequest(): ControlMessage = simple("sessions.destinations.request")
    fun sessionsCreateRequest(input: NewSessionCreateInput): ControlMessage = ControlMessage.of {
        put("t", "sessions.create.request")
        put("requestId", input.requestId)
        put("providerId", input.providerId)
        input.agent?.let { put("agent", it) }
        input.target?.let { put("target", it) }
        input.accountId?.let { put("accountId", it) }
    }
    fun sttStart(): ControlMessage = simple("stt.start")
    fun sttAudioDone(): ControlMessage = simple("stt.audio.done")
    fun sttCancel(): ControlMessage = simple("stt.cancel")
    fun replyCancel(): ControlMessage = simple("reply.cancel")

    private fun simple(t: String): ControlMessage = ControlMessage.of { put("t", t) }

    fun voiceSettingsJson(settings: VoiceSettings): JsonObject = buildJsonObject {
        settings.voice?.let { put("voice", it) }
        settings.tts?.let { tts ->
            put("tts", buildJsonObject {
                tts.providerId?.let { put("providerId", it) }
                tts.model?.let { put("model", it) }
                tts.voice?.let { put("voice", it) }
            })
        }
        settings.stt?.let { stt ->
            put("stt", buildJsonObject {
                stt.providerId?.let { put("providerId", it) }
                stt.model?.let { put("model", it) }
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Decoders for daemon → phone payloads
// ---------------------------------------------------------------------------

private fun JsonElement?.stringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.booleanOrFalse(): Boolean =
    (this as? JsonPrimitive)?.let { runCatching { it.boolean }.getOrNull() } ?: false

private fun JsonElement?.stringList(): List<String> =
    (this as? JsonArray)?.mapNotNull { it.stringOrNull() } ?: emptyList()

fun decodeTtsCatalog(catalog: JsonObject): TtsCatalog {
    val providers = (catalog["providers"] as? JsonArray)?.mapNotNull { entry ->
        val source = entry as? JsonObject ?: return@mapNotNull null
        val id = source["id"].stringOrNull() ?: return@mapNotNull null
        TtsCatalogProvider(
            id = id,
            name = source["name"].stringOrNull() ?: "",
            configured = source["configured"].booleanOrFalse(),
            selected = source["selected"].booleanOrFalse(),
            available = source["available"].booleanOrFalse(),
            models = source["models"].stringList(),
            voices = (source["voices"] as? JsonArray)?.mapNotNull { voiceEntry ->
                val voice = voiceEntry as? JsonObject ?: return@mapNotNull null
                val voiceId = voice["id"].stringOrNull() ?: return@mapNotNull null
                TtsCatalogVoice(id = voiceId, name = voice["name"].stringOrNull() ?: "")
            } ?: emptyList(),
        )
    } ?: emptyList()
    return TtsCatalog(
        activeProvider = catalog["activeProvider"].stringOrNull(),
        generatedAt = catalog["generatedAt"].stringOrNull() ?: "",
        providers = providers,
    )
}

fun decodeSttCatalog(catalog: JsonObject): SttCatalog {
    val providers = (catalog["providers"] as? JsonArray)?.mapNotNull { entry ->
        val source = entry as? JsonObject ?: return@mapNotNull null
        val id = source["id"].stringOrNull() ?: return@mapNotNull null
        SttCatalogProvider(
            id = id,
            name = source["name"].stringOrNull() ?: "",
            configured = source["configured"].booleanOrFalse(),
            selected = source["selected"].booleanOrFalse(),
            available = source["available"].booleanOrFalse(),
            models = source["models"].stringList(),
        )
    } ?: emptyList()
    return SttCatalog(
        activeProvider = catalog["activeProvider"].stringOrNull(),
        generatedAt = catalog["generatedAt"].stringOrNull() ?: "",
        providers = providers,
    )
}

fun decodeNewSessionDestinationsCatalog(catalog: JsonObject): NewSessionDestinationsCatalog {
    val providers = (catalog["providers"] as? JsonArray)?.mapNotNull { entry ->
        val source = entry as? JsonObject ?: return@mapNotNull null
        val id = source["id"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val destinations = (source["destinations"] as? JsonArray)?.mapNotNull { destinationEntry ->
            val destination = destinationEntry as? JsonObject ?: return@mapNotNull null
            val destinationId = destination["id"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
                ?: return@mapNotNull null
            val target = destination["target"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
                ?: return@mapNotNull null
            NewSessionDestinationOption(
                id = destinationId,
                target = target,
                label = destination["label"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: target,
                accountId = destination["accountId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
                group = destination["group"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
            )
        } ?: emptyList()
        NewSessionDestinationProvider(
            id = id,
            label = source["label"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id,
            kind = source["kind"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "channel",
            status = source["status"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unavailable",
            statusDetail = source["statusDetail"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
            destinations = destinations,
        )
    } ?: emptyList()
    return NewSessionDestinationsCatalog(
        generatedAt = catalog["generatedAt"].stringOrNull() ?: "",
        providers = providers,
    )
}

fun decodeRecentSession(value: JsonElement): RecentSession? {
    val source = value as? JsonObject ?: return null
    val sessionId = source["sessionId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val sessionKey = source["sessionKey"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return RecentSession(
        sessionId = sessionId,
        sessionKey = sessionKey,
        agent = source["agent"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unknown",
        channel = source["channel"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        target = source["target"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        accountId = source["accountId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        lastActivity = source["lastActivity"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        displayLabel = source["displayLabel"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
            ?: (source["agent"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unknown"),
        lastMessagePreview = source["lastMessagePreview"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        lastMessageRole = source["lastMessageRole"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        lastAssistantPreview = source["lastAssistantPreview"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    )
}
