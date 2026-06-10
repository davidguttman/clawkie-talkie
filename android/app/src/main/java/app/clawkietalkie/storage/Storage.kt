package app.clawkietalkie.storage

import android.content.Context
import android.content.SharedPreferences
import app.clawkietalkie.protocol.RecentSession
import app.clawkietalkie.protocol.SttSelection
import app.clawkietalkie.protocol.TtsSelection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Device-local settings persistence. Mirror of the web client's
// `src/storage.ts`, including the exact storage keys and JSON shapes so the
// semantics (host-scoped voice settings, global export prefs, favorites,
// transcripts) match 1:1. Provider credentials never live on the phone.

private const val PREFS_NAME = "clawkie"
private const val KEY = "clawkie.settings.v1"
private const val HOLD_MUSIC_MUTE_STORAGE_KEY = "clawkie.holdMusic.muted.v1"
private const val LAST_DASHBOARD_HOST_KEY = "clawkie.dashboard.lastHost.v1"
private const val TRANSCRIPTS_KEY = "clawkie.transcripts.v1"
private const val FAVORITE_SESSIONS_KEY = "clawkie.favoriteSessions.v1"

enum class ExportFormat(val id: String) { MD("md"), TXT("txt"), JSON("json") }
enum class MusicVolumeLevel(val id: String) { LOW("low"), MEDIUM("medium"), HIGH("high") }

data class ExportSettings(
    val format: ExportFormat = ExportFormat.MD,
    val timestamps: Boolean = false,
)

data class MusicSettings(
    val muted: Boolean = false,
    val effects: Boolean = true,
    val volumeLevel: MusicVolumeLevel = MusicVolumeLevel.MEDIUM,
    val disabledTracks: List<String> = emptyList(),
)

data class Settings(
    // Temporary legacy mirror for callers that still read/write `voice`.
    val voice: String = "",
    val tts: TtsSelection = TtsSelection(),
    val stt: SttSelection = SttSelection(),
    val music: MusicSettings = MusicSettings(),
    val format: ExportFormat = ExportFormat.MD,
    val timestamps: Boolean = false,
)

val DEFAULT_MUSIC_SETTINGS = MusicSettings()
val DEFAULT_SETTINGS = Settings()

data class RecentSessionFavoriteState(
    val session: RecentSession,
    val favorite: Boolean = false,
    val persistedFavorite: Boolean = false,
)

class Storage(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    // ------------------------------------------------------------------
    // Dashboard host recovery
    // ------------------------------------------------------------------

    fun loadLastDashboardHostPeerId(): String? =
        prefs.getString(LAST_DASHBOARD_HOST_KEY, null)?.trim()?.takeIf { it.isNotEmpty() }

    fun saveLastDashboardHostPeerId(hostPeerId: String?) {
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        prefs.edit().putString(LAST_DASHBOARD_HOST_KEY, hostKey).apply()
    }

    // ------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------

    fun loadSettings(hostPeerId: String?): Settings = normalizeSettings(readRawSettings(), hostPeerId)

    fun saveSettings(settings: Settings, hostPeerId: String?) {
        val normalized = normalizeSettingsForSave(settings, hostPeerId)
        prefs.edit().putString(KEY, normalized.toString()).apply()
        writeLegacyHoldMusicMute(normalizeMusicSettingsFromValue(musicSettingsJson(settings.music)).muted)
    }

    fun loadMusicSettings(): MusicSettings = normalizeMusicSettings(readRawSettings())

    fun saveMusicSettings(settings: MusicSettings) {
        val existing = objectRecord(readRawSettings())
        val music = normalizeMusicSettingsFromValue(musicSettingsJson(settings))
        val next = buildJsonObject {
            for ((key, value) in existing) {
                if (key == "music") continue
                put(key, value)
            }
            if (!isDefaultMusicSettings(music)) put("music", musicSettingsJson(music))
        }
        prefs.edit().putString(KEY, next.toString()).apply()
        writeLegacyHoldMusicMute(music.muted)
    }

    fun loadExportSettings(): ExportSettings = normalizeExportSettings(readRawSettings())

    private fun readRawSettings(): JsonElement? {
        val raw = prefs.getString(KEY, null) ?: return null
        return runCatching { json.parseToJsonElement(raw) }.getOrNull()
    }

    private fun normalizeSettings(value: JsonElement?, hostPeerId: String?): Settings {
        val exportSettings = normalizeExportSettings(value)
        val music = normalizeMusicSettings(value)
        val source = readHostSettings(value, hostPeerId)
        val tts = normalizeTtsSelection(source["tts"], source["voice"])
        val stt = normalizeSttSelection(source["stt"])
        return Settings(
            voice = tts.voice ?: "",
            tts = tts,
            stt = stt,
            music = music,
            format = exportSettings.format,
            timestamps = exportSettings.timestamps,
        )
    }

    private fun normalizeSettingsForSave(settings: Settings, hostPeerId: String?): JsonObject {
        val existing = objectRecord(readRawSettings())
        val music = normalizeMusicSettingsFromValue(musicSettingsJson(settings.music))
        val hosts = cloneHosts(existing["hosts"]).toMutableMap()
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() }
        if (hostKey != null) hosts[hostKey] = hostSettingsForSave(settings)
        return buildJsonObject {
            put("format", settings.format.id)
            put("timestamps", settings.timestamps)
            if (!isDefaultMusicSettings(music)) put("music", musicSettingsJson(music))
            if (hosts.isNotEmpty()) {
                put("hosts", buildJsonObject {
                    for ((key, value) in hosts) put(key, value)
                })
            }
        }
    }

    private fun hostSettingsForSave(settings: Settings): JsonObject {
        val legacyVoice = settings.voice.trim().takeIf { it.isNotEmpty() }
        val tts = normalizeTtsSelection(
            buildJsonObject {
                settings.tts.providerId?.let { put("providerId", it) }
                settings.tts.model?.let { put("model", it) }
                (legacyVoice ?: settings.tts.voice)?.let { put("voice", it) }
            },
            null,
        )
        return buildJsonObject {
            put("voice", tts.voice ?: "")
            put("tts", buildJsonObject {
                tts.providerId?.let { put("providerId", it) }
                tts.model?.let { put("model", it) }
                tts.voice?.let { put("voice", it) }
            })
            val stt = normalizeSttSelection(buildJsonObject {
                settings.stt.providerId?.let { put("providerId", it) }
                settings.stt.model?.let { put("model", it) }
            })
            put("stt", buildJsonObject {
                stt.providerId?.let { put("providerId", it) }
                stt.model?.let { put("model", it) }
            })
        }
    }

    private fun normalizeExportSettings(value: JsonElement?): ExportSettings {
        val source = objectRecord(value)
        val format = when (source["format"].stringOrNull()) {
            "txt" -> ExportFormat.TXT
            "json" -> ExportFormat.JSON
            else -> ExportFormat.MD
        }
        val timestamps = (source["timestamps"] as? JsonPrimitive)?.booleanOrNull ?: false
        return ExportSettings(format, timestamps)
    }

    private fun normalizeMusicSettings(value: JsonElement?): MusicSettings {
        val record = objectRecord(value)
        val source = objectRecord(record["music"]) .ifEmpty { record }
        return normalizeMusicSettingsFromValue(JsonObject(source))
    }

    private fun normalizeMusicSettingsFromValue(source: JsonObject): MusicSettings {
        val legacyVolume = (source["volume"] as? JsonPrimitive)?.doubleOrNull
        val muted = if (isSilentLegacyMusicVolume(legacyVolume)) {
            true
        } else {
            (source["muted"] as? JsonPrimitive)?.booleanOrNull ?: readLegacyHoldMusicMuted()
        }
        val effects = (source["effects"] as? JsonPrimitive)?.booleanOrNull ?: DEFAULT_MUSIC_SETTINGS.effects
        val volumeLevel = normalizeMusicVolumeLevel(source["volumeLevel"].stringOrNull(), legacyVolume)
        val disabledTracks = (source["disabledTracks"] as? JsonArray)
            ?.mapNotNull { it.stringOrNull()?.trim()?.takeIf { s -> s.isNotEmpty() } }
            ?.distinct()
            ?: DEFAULT_MUSIC_SETTINGS.disabledTracks
        return MusicSettings(muted, effects, volumeLevel, disabledTracks)
    }

    private fun musicSettingsJson(settings: MusicSettings): JsonObject = buildJsonObject {
        put("muted", settings.muted)
        put("effects", settings.effects)
        put("volumeLevel", settings.volumeLevel.id)
        put("disabledTracks", buildJsonArray {
            settings.disabledTracks.forEach { add(JsonPrimitive(it)) }
        })
    }

    private fun isDefaultMusicSettings(settings: MusicSettings): Boolean =
        settings.muted == DEFAULT_MUSIC_SETTINGS.muted &&
            settings.effects == DEFAULT_MUSIC_SETTINGS.effects &&
            settings.volumeLevel == DEFAULT_MUSIC_SETTINGS.volumeLevel &&
            settings.disabledTracks.isEmpty()

    private fun normalizeMusicVolumeLevel(value: String?, legacyVolume: Double?): MusicVolumeLevel {
        if (isSilentLegacyMusicVolume(legacyVolume)) return MusicVolumeLevel.LOW
        when (value) {
            "low" -> return MusicVolumeLevel.LOW
            "medium" -> return MusicVolumeLevel.MEDIUM
            "high" -> return MusicVolumeLevel.HIGH
        }
        return legacyMusicVolumeToLevel(legacyVolume)
    }

    private fun isSilentLegacyMusicVolume(value: Double?): Boolean =
        value != null && value.isFinite() && value <= 0

    private fun legacyMusicVolumeToLevel(value: Double?): MusicVolumeLevel {
        if (value == null || !value.isFinite()) return DEFAULT_MUSIC_SETTINGS.volumeLevel
        val clamped = value.coerceIn(0.0, 1.0)
        if (clamped <= 0.33) return MusicVolumeLevel.LOW
        if (clamped >= 0.67) return MusicVolumeLevel.HIGH
        return MusicVolumeLevel.MEDIUM
    }

    private fun readLegacyHoldMusicMuted(): Boolean =
        prefs.getString(HOLD_MUSIC_MUTE_STORAGE_KEY, null) == "1"

    private fun writeLegacyHoldMusicMute(muted: Boolean) {
        if (muted) prefs.edit().putString(HOLD_MUSIC_MUTE_STORAGE_KEY, "1").apply()
        else prefs.edit().remove(HOLD_MUSIC_MUTE_STORAGE_KEY).apply()
    }

    private fun readHostSettings(value: JsonElement?, hostPeerId: String?): Map<String, JsonElement> {
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: return emptyMap()
        val hosts = objectRecord(objectRecord(value)["hosts"])
        return objectRecord(hosts[hostKey])
    }

    private fun cloneHosts(value: JsonElement?): Map<String, JsonObject> {
        val hosts = objectRecord(value)
        val next = LinkedHashMap<String, JsonObject>()
        for ((key, settings) in hosts) {
            val hostKey = key.trim().takeIf { it.isNotEmpty() } ?: continue
            val hostSettings = objectRecord(settings)
            if (hostSettings.isNotEmpty()) next[hostKey] = JsonObject(hostSettings)
        }
        return next
    }

    private fun normalizeTtsSelection(value: JsonElement?, legacyVoice: JsonElement?): TtsSelection {
        val source = objectRecord(value)
        val providerId = source["providerId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        val model = source["model"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        val voice = source["voice"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
            ?: legacyVoice.stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        return TtsSelection(providerId, model, voice)
    }

    private fun normalizeSttSelection(value: JsonElement?): SttSelection {
        val source = objectRecord(value)
        val providerId = source["providerId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        val model = source["model"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        return SttSelection(providerId, model)
    }

    // ------------------------------------------------------------------
    // Favorite recent sessions
    // ------------------------------------------------------------------

    fun loadFavoriteRecentSessions(hostPeerId: String?): List<RecentSession> {
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        return readFavoriteSessionStore()[hostKey] ?: emptyList()
    }

    fun saveFavoriteRecentSession(hostPeerId: String?, session: RecentSession): RecentSession? {
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val normalized = normalizeFavoriteRecentSession(session) ?: return null
        val store = readFavoriteSessionStore().toMutableMap()
        val key = favoriteRecentSessionIdentity(normalized) ?: return null
        val sessions = (store[hostKey] ?: emptyList()).filter { favoriteRecentSessionIdentity(it) != key }
        store[hostKey] = listOf(normalized) + sessions
        writeFavoriteSessionStore(store)
        return normalized
    }

    fun removeFavoriteRecentSession(hostPeerId: String?, session: RecentSession) {
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val key = favoriteRecentSessionIdentity(session) ?: return
        val store = readFavoriteSessionStore().toMutableMap()
        val host = store[hostKey] ?: return
        val next = host.filter { !favoriteRecentSessionIdentityMatches(it, session) }
        if (next.isNotEmpty()) store[hostKey] = next else store.remove(hostKey)
        writeFavoriteSessionStore(store)
    }

    fun reconcileFavoriteRecentSessions(
        hostPeerId: String?,
        daemonSessions: List<RecentSession>,
    ): List<RecentSession> {
        val hostKey = hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        val store = readFavoriteSessionStore().toMutableMap()
        val host = store[hostKey] ?: return emptyList()
        if (host.isEmpty()) return emptyList()
        val daemonByKey = HashMap<String, RecentSession>()
        for (session in daemonSessions) {
            val normalized = normalizeFavoriteRecentSession(session) ?: continue
            val key = favoriteRecentSessionIdentity(normalized) ?: continue
            daemonByKey[key] = normalized
        }
        var changed = false
        val next = host.map { favorite ->
            val key = favoriteRecentSessionIdentity(favorite)
            val fresh = key?.let { daemonByKey[it] }
            if (fresh != null) changed = true
            fresh ?: favorite
        }
        store[hostKey] = next
        if (changed) writeFavoriteSessionStore(store)
        return next
    }

    private fun readFavoriteSessionStore(): Map<String, List<RecentSession>> {
        val raw = prefs.getString(FAVORITE_SESSIONS_KEY, null) ?: return emptyMap()
        val parsed = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return emptyMap()
        val hosts = objectRecord(objectRecord(parsed)["hosts"])
        val out = LinkedHashMap<String, List<RecentSession>>()
        for ((rawHostKey, rawHost) in hosts) {
            val hostKey = rawHostKey.trim().takeIf { it.isNotEmpty() } ?: continue
            val rawSessions: List<JsonElement> = when (rawHost) {
                is JsonArray -> rawHost
                is JsonObject -> (rawHost["sessions"] as? JsonArray) ?: JsonArray(emptyList())
                else -> emptyList()
            }
            val seen = HashSet<String>()
            val sessions = mutableListOf<RecentSession>()
            for (entry in rawSessions) {
                val normalized = decodeFavoriteSession(entry) ?: continue
                val key = favoriteRecentSessionIdentity(normalized) ?: continue
                if (!seen.add(key)) continue
                sessions.add(normalized)
            }
            if (sessions.isNotEmpty()) out[hostKey] = sessions
        }
        return out
    }

    private fun writeFavoriteSessionStore(store: Map<String, List<RecentSession>>) {
        val payload = buildJsonObject {
            put("hosts", buildJsonObject {
                for ((hostKey, sessions) in store) {
                    if (sessions.isEmpty()) continue
                    put(hostKey, buildJsonObject {
                        put("sessions", buildJsonArray {
                            sessions.forEach { add(recentSessionJson(it)) }
                        })
                    })
                }
            })
        }
        prefs.edit().putString(FAVORITE_SESSIONS_KEY, payload.toString()).apply()
    }

    private fun decodeFavoriteSession(value: JsonElement): RecentSession? =
        app.clawkietalkie.protocol.decodeRecentSession(value)?.let { normalizeFavoriteRecentSession(it) }

    private fun recentSessionJson(session: RecentSession): JsonObject = buildJsonObject {
        put("sessionId", session.sessionId)
        put("sessionKey", session.sessionKey)
        put("agent", session.agent)
        put("displayLabel", session.displayLabel)
        session.channel?.let { put("channel", it) }
        session.target?.let { put("target", it) }
        session.accountId?.let { put("accountId", it) }
        session.lastActivity?.let { put("lastActivity", it) }
        session.lastMessagePreview?.let { put("lastMessagePreview", it) }
        session.lastMessageRole?.let { put("lastMessageRole", it) }
        session.lastAssistantPreview?.let { put("lastAssistantPreview", it) }
    }

    // ------------------------------------------------------------------
    // Transcript store
    // ------------------------------------------------------------------

    fun listTranscriptSessions(): List<TranscriptSessionMeta> =
        readTranscriptStore()
            .map { session ->
                TranscriptSessionMeta(
                    id = session.id,
                    threadId = session.threadId,
                    hostPeerId = session.hostPeerId,
                    createdAt = session.createdAt,
                    updatedAt = session.updatedAt,
                    turnCount = session.turns.size,
                    preview = latestTurnPreview(session),
                )
            }
            .sortedByDescending { it.updatedAt }

    fun loadTranscriptSession(sessionId: String): TranscriptSession? {
        val id = sessionId.trim().takeIf { it.isNotEmpty() } ?: return null
        return readTranscriptStore().find { it.id == id }
    }

    fun appendTranscriptTurn(
        input: TranscriptSessionInput,
        role: TranscriptRole,
        text: String,
        error: String? = null,
        now: Date = Date(),
    ): TranscriptSession? {
        val sessionId = input.sessionId.trim()
        val trimmed = text.trim()
        if (sessionId.isEmpty() || (trimmed.isEmpty() && error == null)) return null

        val iso = isoTimestamp(now)
        val store = readTranscriptStore().toMutableList()
        var index = store.indexOfFirst { it.id == sessionId }
        if (index < 0) {
            store.add(
                TranscriptSession(
                    id = sessionId,
                    threadId = input.threadId?.trim()?.takeIf { it.isNotEmpty() },
                    hostPeerId = input.hostPeerId?.trim()?.takeIf { it.isNotEmpty() },
                    createdAt = iso,
                    updatedAt = iso,
                    turns = emptyList(),
                ),
            )
            index = store.size - 1
        }
        val session = store[index]
        val nextSession = session.copy(
            updatedAt = iso,
            threadId = input.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: session.threadId,
            hostPeerId = input.hostPeerId?.trim()?.takeIf { it.isNotEmpty() } ?: session.hostPeerId,
            turns = session.turns + TranscriptTurn(
                id = createTurnId(now, session.turns.size),
                role = role,
                text = trimmed,
                createdAt = iso,
                error = error,
            ),
        )
        store[index] = nextSession
        writeTranscriptStore(store)
        return nextSession
    }

    private fun readTranscriptStore(): List<TranscriptSession> {
        val raw = prefs.getString(TRANSCRIPTS_KEY, null) ?: return emptyList()
        val parsed = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
        val sessions = (objectRecord(parsed)["sessions"] as? JsonArray) ?: return emptyList()
        return sessions.mapNotNull { decodeTranscriptSession(it) }
    }

    private fun writeTranscriptStore(sessions: List<TranscriptSession>) {
        val payload = buildJsonObject {
            put("sessions", buildJsonArray {
                sessions.forEach { session ->
                    add(buildJsonObject {
                        put("id", session.id)
                        session.threadId?.let { put("threadId", it) }
                        session.hostPeerId?.let { put("hostPeerId", it) }
                        put("createdAt", session.createdAt)
                        put("updatedAt", session.updatedAt)
                        put("turns", buildJsonArray {
                            session.turns.forEach { turn ->
                                add(buildJsonObject {
                                    put("id", turn.id)
                                    put("role", turn.role.id)
                                    put("text", turn.text)
                                    put("createdAt", turn.createdAt)
                                    turn.error?.let { put("error", it) }
                                })
                            }
                        })
                    })
                }
            })
        }
        prefs.edit().putString(TRANSCRIPTS_KEY, payload.toString()).apply()
    }

    private fun decodeTranscriptSession(value: JsonElement): TranscriptSession? {
        val source = value as? JsonObject ?: return null
        val id = source["id"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val createdAt = source["createdAt"].stringOrNull() ?: isoTimestamp(Date(0))
        val updatedAt = source["updatedAt"].stringOrNull() ?: createdAt
        return TranscriptSession(
            id = id,
            threadId = source["threadId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
            hostPeerId = source["hostPeerId"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
            createdAt = createdAt,
            updatedAt = updatedAt,
            turns = (source["turns"] as? JsonArray)?.mapNotNull { decodeTranscriptTurn(it) } ?: emptyList(),
        )
    }

    private fun decodeTranscriptTurn(value: JsonElement): TranscriptTurn? {
        val source = value as? JsonObject ?: return null
        val role = when (source["role"].stringOrNull()) {
            "assistant" -> TranscriptRole.ASSISTANT
            "user" -> TranscriptRole.USER
            else -> return null
        }
        val text = source["text"].stringOrNull() ?: return null
        return TranscriptTurn(
            id = source["id"].stringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
                ?: createTurnId(Date(), 0),
            role = role,
            text = text,
            createdAt = source["createdAt"].stringOrNull() ?: isoTimestamp(Date(0)),
            error = source["error"].stringOrNull()?.takeIf { it.isNotEmpty() },
        )
    }
}

// ---------------------------------------------------------------------------
// Transcript model + exports (pure logic, host-agnostic)
// ---------------------------------------------------------------------------

enum class TranscriptRole(val id: String) { USER("user"), ASSISTANT("assistant") }

data class TranscriptTurn(
    val id: String,
    val role: TranscriptRole,
    val text: String,
    val createdAt: String,
    val error: String? = null,
)

data class TranscriptSession(
    val id: String,
    val threadId: String? = null,
    val hostPeerId: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val turns: List<TranscriptTurn>,
)

data class TranscriptSessionMeta(
    val id: String,
    val threadId: String?,
    val hostPeerId: String?,
    val createdAt: String,
    val updatedAt: String,
    val turnCount: Int,
    val preview: String,
)

data class TranscriptSessionInput(
    val sessionId: String,
    val threadId: String? = null,
    val hostPeerId: String? = null,
)

data class TranscriptExport(val filename: String, val mime: String, val body: String)

fun latestAssistantText(session: TranscriptSession?): String? {
    if (session == null) return null
    for (turn in session.turns.asReversed()) {
        if (turn.role == TranscriptRole.ASSISTANT && turn.text.isNotBlank()) return turn.text
    }
    return null
}

fun exportTranscript(session: TranscriptSession, settings: ExportSettings): TranscriptExport {
    val baseName = safeFilePart(session.id.ifEmpty { "transcript" })
    val filename = "$baseName.${settings.format.id}"
    return when (settings.format) {
        ExportFormat.JSON -> TranscriptExport(
            filename,
            "application/json",
            jsonExportBody(session, settings.timestamps),
        )
        ExportFormat.TXT -> TranscriptExport(filename, "text/plain", textExportBody(session, settings.timestamps))
        ExportFormat.MD -> TranscriptExport(filename, "text/markdown", markdownExportBody(session, settings.timestamps))
    }
}

private fun jsonExportBody(session: TranscriptSession, timestamps: Boolean): String {
    val payload = buildJsonObject {
        put("sessionId", session.id)
        session.threadId?.let { put("threadId", it) }
        session.hostPeerId?.let { put("hostPeerId", it) }
        if (timestamps) {
            put("createdAt", session.createdAt)
            put("updatedAt", session.updatedAt)
        }
        put("turns", buildJsonArray {
            session.turns.forEach { turn ->
                add(buildJsonObject {
                    put("role", turn.role.id)
                    put("text", turn.text)
                    turn.error?.let { put("error", it) }
                    if (timestamps) put("createdAt", turn.createdAt)
                })
            }
        })
    }
    val pretty = Json { prettyPrint = true; prettyPrintIndent = "  " }
    return pretty.encodeToString(JsonObject.serializer(), payload) + "\n"
}

private fun textExportBody(session: TranscriptSession, timestamps: Boolean): String {
    val lines = mutableListOf("Clawkie Talkie Transcript", "Session: ${session.id}")
    session.threadId?.let { lines.add("Thread: $it") }
    lines.add("")
    for (turn in session.turns) {
        val who = if (turn.role == TranscriptRole.ASSISTANT) "AI" else "You"
        val stamp = if (timestamps) "[${formatTimestamp(turn.createdAt)}] " else ""
        val error = turn.error?.let { " ($it)" } ?: ""
        lines.add("$stamp$who$error: ${turn.text}")
    }
    return lines.joinToString("\n").trimEnd() + "\n"
}

private fun markdownExportBody(session: TranscriptSession, timestamps: Boolean): String {
    val lines = mutableListOf("# Clawkie Talkie Transcript", "", "- Session: `${session.id}`")
    session.threadId?.let { lines.add("- Thread: `$it`") }
    lines.add("")
    for (turn in session.turns) {
        val who = if (turn.role == TranscriptRole.ASSISTANT) "AI" else "You"
        val stamp = if (timestamps) " _${formatTimestamp(turn.createdAt)}_" else ""
        val error = turn.error?.let { " `$it`" } ?: ""
        lines.add("**$who**$stamp$error")
        lines.add("")
        lines.add(turn.text)
        lines.add("")
    }
    return lines.joinToString("\n").trimEnd() + "\n"
}

fun formatTimestamp(value: String): String {
    val parsed = parseIsoTimestamp(value) ?: return value
    val formatter = SimpleDateFormat("M/d/yyyy, h:mm:ss a", Locale.getDefault())
    return formatter.format(parsed)
}

fun parseIsoTimestamp(value: String): Date? {
    // Tolerant ISO-8601 parsing (Date.parse equivalent for daemon timestamps).
    runCatching {
        return Date(java.time.Instant.parse(value).toEpochMilli())
    }
    runCatching {
        return Date(
            java.time.OffsetDateTime.parse(value, java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                .toInstant()
                .toEpochMilli(),
        )
    }
    return runCatching {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        formatter.parse(value)
    }.getOrNull()
}

fun isoTimestamp(date: Date): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    formatter.timeZone = TimeZone.getTimeZone("UTC")
    return formatter.format(date)
}

private fun latestTurnPreview(session: TranscriptSession): String {
    val turn = session.turns.asReversed().firstOrNull { it.text.isNotBlank() }
        ?: return "No turns saved yet"
    val prefix = if (turn.role == TranscriptRole.ASSISTANT) "AI" else "You"
    return "$prefix: ${truncate(turn.text.trim(), 96)}"
}

private fun truncate(value: String, max: Int): String =
    if (value.length <= max) value else value.take(max - 1) + "…"

private fun createTurnId(now: Date, index: Int): String =
    now.time.toString(36) + "-" + index.toString(36)

private fun safeFilePart(value: String): String =
    value.trim()
        .replace(Regex("[^a-zA-Z0-9._-]+"), "-")
        .trim('-')
        .ifEmpty { "transcript" }

// ---------------------------------------------------------------------------
// Favorites helpers (pure logic; mirror of storage.ts exports)
// ---------------------------------------------------------------------------

fun normalizeFavoriteRecentSession(session: RecentSession): RecentSession? {
    val sessionId = session.sessionId.trim().takeIf { it.isNotEmpty() } ?: return null
    val sessionKey = session.sessionKey.trim().takeIf { it.isNotEmpty() } ?: return null
    val agent = session.agent.trim().takeIf { it.isNotEmpty() } ?: "unknown"
    return RecentSession(
        sessionId = sessionId,
        sessionKey = sessionKey,
        agent = agent,
        displayLabel = session.displayLabel.trim().takeIf { it.isNotEmpty() } ?: agent,
        channel = session.channel?.trim()?.takeIf { it.isNotEmpty() },
        target = session.target?.trim()?.takeIf { it.isNotEmpty() },
        accountId = session.accountId?.trim()?.takeIf { it.isNotEmpty() },
        lastActivity = session.lastActivity?.trim()?.takeIf { it.isNotEmpty() },
        lastMessagePreview = session.lastMessagePreview?.trim()?.takeIf { it.isNotEmpty() },
        lastMessageRole = session.lastMessageRole?.trim()?.takeIf { it.isNotEmpty() },
        lastAssistantPreview = session.lastAssistantPreview?.trim()?.takeIf { it.isNotEmpty() },
    )
}

fun favoriteRecentSessionIdentity(session: RecentSession): String? {
    val sessionKey = session.sessionKey.trim()
    if (sessionKey.isNotEmpty()) return "sessionKey:$sessionKey"
    val sessionId = session.sessionId.trim()
    return if (sessionId.isNotEmpty()) "sessionId:$sessionId" else null
}

fun favoriteRecentSessionIdentityMatches(left: RecentSession, right: RecentSession): Boolean {
    val leftKey = left.sessionKey.trim()
    val rightKey = right.sessionKey.trim()
    if (leftKey.isNotEmpty() && rightKey.isNotEmpty()) return leftKey == rightKey
    val leftId = left.sessionId.trim()
    val rightId = right.sessionId.trim()
    return leftId.isNotEmpty() && rightId.isNotEmpty() && leftId == rightId
}

fun mergeRecentSessionsWithFavorites(
    daemonSessions: List<RecentSession>,
    favoriteSessions: List<RecentSession>,
): List<RecentSessionFavoriteState> {
    val favoritesByKey = LinkedHashMap<String, RecentSession>()
    for (session in favoriteSessions) {
        val normalized = normalizeFavoriteRecentSession(session) ?: continue
        val key = favoriteRecentSessionIdentity(normalized) ?: continue
        favoritesByKey[key] = normalized
    }

    val seen = HashSet<String>()
    val favoriteRows = mutableListOf<RecentSessionFavoriteState>()
    val nonFavoriteRows = mutableListOf<RecentSessionFavoriteState>()
    for (session in daemonSessions) {
        val normalized = normalizeFavoriteRecentSession(session) ?: continue
        val key = favoriteRecentSessionIdentity(normalized) ?: continue
        seen.add(key)
        val favorite = favoritesByKey.containsKey(key)
        val row = RecentSessionFavoriteState(normalized, favorite = favorite)
        if (favorite) favoriteRows.add(row) else nonFavoriteRows.add(row)
    }

    for (favorite in favoriteSessions) {
        val normalized = normalizeFavoriteRecentSession(favorite) ?: continue
        val key = favoriteRecentSessionIdentity(normalized) ?: continue
        if (key in seen) continue
        favoriteRows.add(RecentSessionFavoriteState(normalized, favorite = true, persistedFavorite = true))
    }

    return favoriteRows + nonFavoriteRows
}

private fun JsonElement?.stringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun objectRecord(value: JsonElement?): Map<String, JsonElement> =
    (value as? JsonObject) ?: emptyMap()
