package app.clawkietalkie.rtc

import android.os.Handler
import android.os.Looper
import app.clawkietalkie.protocol.CLIENT_WANTED_PROTOCOL_FEATURES
import app.clawkietalkie.protocol.ControlMessage
import app.clawkietalkie.protocol.NewSessionDestinationsCatalog
import app.clawkietalkie.protocol.PhoneToDaemon
import app.clawkietalkie.protocol.ProtocolFeatures
import app.clawkietalkie.protocol.RecentSession
import app.clawkietalkie.protocol.RecentSessionsSnapshot
import app.clawkietalkie.protocol.RendezvousJoinInput
import app.clawkietalkie.protocol.SttCatalog
import app.clawkietalkie.protocol.SttSelection
import app.clawkietalkie.protocol.TtsCatalog
import app.clawkietalkie.protocol.TtsSelection
import app.clawkietalkie.protocol.VoiceSettings
import app.clawkietalkie.protocol.decodeNewSessionDestinationsCatalog
import app.clawkietalkie.protocol.decodeRecentSession
import app.clawkietalkie.protocol.decodeSttCatalog
import app.clawkietalkie.protocol.decodeTtsCatalog
import app.clawkietalkie.protocol.isDaemonSupportedProtocol
import app.clawkietalkie.storage.RecentSessionFavoriteState
import app.clawkietalkie.storage.Storage
import app.clawkietalkie.storage.mergeRecentSessionsWithFavorites
import app.clawkietalkie.storage.normalizeFavoriteRecentSession
import app.clawkietalkie.storage.favoriteRecentSessionIdentity
import app.clawkietalkie.voice.DaemonTtsAudio
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.webrtc.PeerConnectionFactory
import java.util.concurrent.CopyOnWriteArraySet

// One live connection per host peer ID, hoisted so the Driving screen can
// consume the connection + control message stream. Mirror of the web
// client's `src/rtc/RtcContext.tsx`: protocol negotiation with legacy
// fallback, rendezvous room flip, catalog/session subscriptions, retry
// backoff and session-replaced handling.

enum class RecentSessionsSupportStatus { UNKNOWN, PROBING, SUPPORTED, UNSUPPORTED }

private enum class NegotiationMode { IDLE, PENDING, NEGOTIATED, LEGACY, UNSUPPORTED }

private data class NegotiationState(
    val roomId: String?,
    val mode: NegotiationMode,
    val features: List<String>,
)

private const val RECENT_SESSIONS_SUPPORT_TIMEOUT_MS = 12_000L
private const val CLIENT_HELLO_FALLBACK_MS = 250L
private val RTC_RETRY_BACKOFF_MS = longArrayOf(1_000, 2_500, 5_000, 10_000, 15_000)

data class RtcUiState(
    val status: RtcStatus = RtcStatus.IDLE,
    val detail: String? = null,
    val ttsCatalog: TtsCatalog? = null,
    val sttCatalog: SttCatalog? = null,
    val recentSessions: List<RecentSessionFavoriteState> = emptyList(),
    val recentSessionsGeneratedAt: String? = null,
    val recentSessionsResponseSeq: Int = 0,
    val recentSessionsSupportStatus: RecentSessionsSupportStatus = RecentSessionsSupportStatus.UNKNOWN,
    val newSessionDestinationsCatalog: NewSessionDestinationsCatalog? = null,
    val newSessionDestinationsResponseSeq: Int = 0,
    val newSessionsSupported: Boolean = false,
    val canRetryConnection: Boolean = false,
    val hasClient: Boolean = false,
)

fun normalizeVoiceSettingsForRtc(settings: VoiceSettings?): VoiceSettings? {
    if (settings == null) return null
    val ttsProviderId = settings.tts?.providerId?.trim()?.takeIf { it.isNotEmpty() }
    val ttsModel = settings.tts?.model?.trim()?.takeIf { it.isNotEmpty() }
    val effectiveVoice = settings.tts?.voice?.trim()?.takeIf { it.isNotEmpty() }
        ?: settings.voice?.trim()?.takeIf { it.isNotEmpty() }
    val sttProviderId = settings.stt?.providerId?.trim()?.takeIf { it.isNotEmpty() }
    val sttModel = settings.stt?.model?.trim()?.takeIf { it.isNotEmpty() }

    val tts = if (ttsProviderId != null || ttsModel != null || effectiveVoice != null) {
        TtsSelection(providerId = ttsProviderId, model = ttsModel, voice = effectiveVoice)
    } else null
    val stt = if (sttProviderId != null || sttModel != null) {
        SttSelection(providerId = sttProviderId, model = sttModel)
    } else null

    val normalized = VoiceSettings(voice = effectiveVoice, tts = tts, stt = stt)
    return if (normalized.isEmpty) null else normalized
}

private fun voiceSelectionKey(settings: VoiceSettings?): String? {
    val normalized = normalizeVoiceSettingsForRtc(settings) ?: return null
    val providerId = normalized.tts?.providerId ?: ""
    val model = normalized.tts?.model ?: ""
    val voice = normalized.tts?.voice ?: normalized.voice ?: ""
    val legacyVoice = normalized.voice ?: ""
    val sttProviderId = normalized.stt?.providerId ?: ""
    val sttModel = normalized.stt?.model ?: ""
    if (providerId.isEmpty() && model.isEmpty() && voice.isEmpty() && legacyVoice.isEmpty() &&
        sttProviderId.isEmpty() && sttModel.isEmpty()
    ) return null
    return listOf(providerId, model, voice, legacyVoice, sttProviderId, sttModel).joinToString("\n")
}

class RtcSession(
    private val factory: PeerConnectionFactory,
    private val storage: Storage,
    private val signalServer: String,
    private val iceServers: List<IceServer>,
    val hostPeerId: String?,
    private val rendezvous: RendezvousJoinInput?,
    initialVoiceSettings: VoiceSettings?,
) {
    private val handler = Handler(Looper.getMainLooper())

    private val _state = MutableStateFlow(RtcUiState(hasClient = hostPeerId != null))
    val state: StateFlow<RtcUiState> = _state.asStateFlow()

    private val controlListeners = CopyOnWriteArraySet<(ControlMessage) -> Unit>()
    private val binaryListeners = CopyOnWriteArraySet<(ByteArray) -> Unit>()

    private var client: RtcClient? = null
    private var clientGeneration = 0
    private var activeRoomId: String? = hostPeerId
    private var negotiation = NegotiationState(hostPeerId, NegotiationMode.IDLE, emptyList())
    private var voiceSettings: VoiceSettings? = normalizeVoiceSettingsForRtc(initialVoiceSettings)
    private var appliedVoiceSettingsKey: String? = null
    private var lastSentVoiceKey: String? = null
    private var catalogRequestedRoom: String? = null
    private var newSessionDestinationsRequestedRoom: String? = null
    private var sessionsSubscribedRoom: String? = null
    private var recentSessionsSnapshot = RecentSessionsSnapshot("", emptyList())
    private var favoriteSessions: List<RecentSession> =
        storage.loadFavoriteRecentSessions(hostPeerId)
    private var autoRetryAttempt = 0
    private var retryRunnable: Runnable? = null
    private var helloFallbackRunnable: Runnable? = null
    private var probeTimeoutRunnable: Runnable? = null
    private var closed = false

    fun start() {
        handler.post { connectToRoom() }
    }

    fun close() {
        handler.post {
            closed = true
            cancelTimers()
            client?.close()
            client = null
            DaemonTtsAudio.detachRemoteTrack()
        }
    }

    // ------------------------------------------------------------------
    // Public API used by the UI / driving loop
    // ------------------------------------------------------------------

    fun sendControl(msg: ControlMessage) {
        handler.post {
            if (!allowsControlMessage(msg)) return@post
            client?.sendControl(msg)
        }
    }

    fun sendBinary(bytes: ByteArray) {
        // Mic PCM frames; skip the handler hop for latency, but apply the same
        // unsupported-daemon gate.
        if (negotiation.roomId == activeRoomId && negotiation.mode == NegotiationMode.UNSUPPORTED) return
        client?.sendBinary(bytes)
    }

    fun addControlListener(listener: (ControlMessage) -> Unit): () -> Unit {
        controlListeners.add(listener)
        return { controlListeners.remove(listener) }
    }

    fun addBinaryListener(listener: (ByteArray) -> Unit): () -> Unit {
        binaryListeners.add(listener)
        return { binaryListeners.remove(listener) }
    }

    fun updateVoiceSettings(settings: VoiceSettings?) {
        handler.post {
            val previousKey = voiceSelectionKey(voiceSettings)
            voiceSettings = normalizeVoiceSettingsForRtc(settings)
            // Still waiting on the rendezvous lane: re-send the join with the
            // updated settings (the web join effect re-fires on settings
            // changes before the voice-room flip).
            if (
                rendezvous != null && hostPeerId != null && activeRoomId == hostPeerId &&
                _state.value.status == RtcStatus.OPEN && isNegotiationResolved() &&
                voiceSelectionKey(voiceSettings) != previousKey
            ) {
                val settingsKey = voiceSelectionKey(voiceSettings)
                if (settingsKey != null) appliedVoiceSettingsKey = settingsKey
                client?.sendControl(PhoneToDaemon.rendezvousJoin(rendezvous, voiceSettings))
                return@post
            }
            pushVoiceSettingsIfNeeded()
        }
    }

    fun requestTtsCatalog() {
        handler.post {
            val roomId = activeRoomId ?: return@post
            if (rendezvous != null && roomId == hostPeerId) return@post
            if (_state.value.status != RtcStatus.OPEN) return@post
            if (!allowsProtocolFeature(ProtocolFeatures.TTS_CATALOG)) return@post
            client?.sendControl(PhoneToDaemon.ttsCatalogRequest())
        }
    }

    fun requestSttCatalog() {
        handler.post {
            val roomId = activeRoomId ?: return@post
            if (rendezvous != null && roomId == hostPeerId) return@post
            if (_state.value.status != RtcStatus.OPEN) return@post
            if (!allowsProtocolFeature(ProtocolFeatures.STT_CATALOG)) return@post
            client?.sendControl(PhoneToDaemon.sttCatalogRequest())
        }
    }

    fun requestNewSessionDestinations() {
        handler.post {
            val roomId = activeRoomId ?: return@post
            if (rendezvous != null && roomId == hostPeerId) return@post
            if (_state.value.status != RtcStatus.OPEN) return@post
            if (!isNegotiationResolved()) return@post
            if (!allowsProtocolFeature(ProtocolFeatures.SESSIONS_DESTINATIONS)) return@post
            client?.sendControl(PhoneToDaemon.sessionsDestinationsRequest())
        }
    }

    fun requestRecentSessions() {
        handler.post {
            val roomId = activeRoomId ?: return@post
            if (rendezvous != null && roomId == hostPeerId) return@post
            if (_state.value.status != RtcStatus.OPEN) return@post
            if (!isNegotiationResolved()) return@post
            val allowList = allowsProtocolFeature(ProtocolFeatures.SESSIONS_LIST)
            val allowCatalog = allowsProtocolFeature(ProtocolFeatures.SESSIONS_CATALOG)
            if (!allowList && !allowCatalog) {
                setSupportStatus(RecentSessionsSupportStatus.UNSUPPORTED)
                return@post
            }
            setProbingSupportStatus()
            if (allowList) client?.sendControl(PhoneToDaemon.sessionsListRequest())
            if (allowCatalog) client?.sendControl(PhoneToDaemon.sessionsCatalogRequest())
        }
    }

    fun retryConnection() {
        handler.post {
            if (!isRetryableConnectionState()) return@post
            autoRetryAttempt = 0
            update { it.copy(detail = null, status = RtcStatus.IDLE, canRetryConnection = false) }
            resetRetryConnectionRefs()
            reconnect()
        }
    }

    fun toggleRecentSessionFavorite(session: RecentSession) {
        handler.post {
            val normalized = normalizeFavoriteRecentSession(session) ?: return@post
            val host = hostPeerId ?: return@post
            val current = storage.loadFavoriteRecentSessions(host)
            val identity = favoriteRecentSessionIdentity(normalized)
            val favorite = identity != null &&
                current.any { favoriteRecentSessionIdentity(it) == identity }
            if (favorite) {
                storage.removeFavoriteRecentSession(host, normalized)
            } else {
                storage.saveFavoriteRecentSession(host, normalized)
            }
            favoriteSessions = storage.loadFavoriteRecentSessions(host)
            publishRecentSessions()
        }
    }

    // ------------------------------------------------------------------
    // Connection lifecycle
    // ------------------------------------------------------------------

    private fun connectToRoom() {
        if (closed) return
        val roomId = activeRoomId ?: return
        cancelHelloFallback()
        client?.close()
        clientGeneration += 1
        val generation = clientGeneration
        negotiation = NegotiationState(roomId, NegotiationMode.IDLE, emptyList())
        val newClient = RtcClient(
            factory = factory,
            hostPeerId = roomId,
            signalServer = signalServer,
            iceServers = iceServers,
            listener = object : RtcClientListener {
                override fun onStatusChange(status: RtcStatus, detail: String?) {
                    handler.post {
                        if (closed || generation != clientGeneration) return@post
                        handleStatusChange(status, detail)
                    }
                }

                override fun onControlMessage(msg: ControlMessage) {
                    handler.post {
                        if (closed || generation != clientGeneration) return@post
                        handleIncomingControlMessage(msg)
                    }
                }

                override fun onBinaryMessage(bytes: ByteArray) {
                    if (closed || generation != clientGeneration) return
                    for (listener in binaryListeners) {
                        runCatching { listener(bytes) }
                    }
                }

                override fun onRemoteAudioTrack(track: org.webrtc.AudioTrack) {
                    handler.post {
                        if (closed || generation != clientGeneration) return@post
                        // Attach so playback/visualization is ready the moment
                        // the daemon's first audio frame arrives.
                        DaemonTtsAudio.attachRemoteTrack(track)
                    }
                }
            },
        )
        client = newClient
        newClient.connect()
    }

    private fun reconnect() {
        DaemonTtsAudio.detachRemoteTrack()
        connectToRoom()
    }

    private fun handleStatusChange(status: RtcStatus, detail: String?) {
        update { current ->
            val nextDetail = detail
                ?: if (current.detail == "session_replaced" || current.detail == "unsupported_daemon_protocol") {
                    current.detail
                } else null
            current.copy(status = status, detail = nextDetail)
        }
        if (status == RtcStatus.OPEN) {
            autoRetryAttempt = 0
            beginNegotiation()
        } else {
            setSupportStatusForLane()
        }
        publishNewSessionsSupported()
        updateCanRetry()
        maybeScheduleAutoRetry()
    }

    private fun beginNegotiation() {
        val roomId = activeRoomId ?: return
        negotiation = NegotiationState(roomId, NegotiationMode.PENDING, emptyList())
        publishNewSessionsSupported()
        client?.sendControl(PhoneToDaemon.clientHello(CLIENT_WANTED_PROTOCOL_FEATURES))
        cancelHelloFallback()
        val runnable = Runnable {
            if (negotiation.roomId == roomId && negotiation.mode == NegotiationMode.PENDING) {
                negotiation = NegotiationState(roomId, NegotiationMode.LEGACY, emptyList())
                publishNewSessionsSupported()
                onNegotiationResolved()
            }
        }
        helloFallbackRunnable = runnable
        handler.postDelayed(runnable, CLIENT_HELLO_FALLBACK_MS)
    }

    private fun handleIncomingControlMessage(msg: ControlMessage) {
        if (msg.t == "session.snapshot") {
            deliverControlMessage(msg)
            val events = msg.array("events")
                ?.mapNotNull { entry ->
                    val record = entry as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                    val id = (record["id"] as? kotlinx.serialization.json.JsonPrimitive)
                        ?.content?.toDoubleOrNull() ?: return@mapNotNull null
                    val nested = record["msg"] as? kotlinx.serialization.json.JsonObject
                        ?: return@mapNotNull null
                    Pair(id, ControlMessage(nested))
                }
                ?.sortedBy { it.first }
                ?: emptyList()
            for ((_, event) in events) deliverControlMessage(event)
            return
        }
        deliverControlMessage(msg)
    }

    private fun deliverControlMessage(msg: ControlMessage) {
        val roomId = activeRoomId
        when (msg.t) {
            "daemon.hello" -> {
                if (!isDaemonSupportedProtocol(msg.int("protocol"))) {
                    if (negotiation.roomId == roomId && negotiation.mode != NegotiationMode.UNSUPPORTED) {
                        negotiation = NegotiationState(roomId, NegotiationMode.UNSUPPORTED, emptyList())
                    }
                    update { it.copy(detail = "unsupported_daemon_protocol", status = RtcStatus.ERROR) }
                    updateCanRetry()
                    return
                }
                val features = msg.array("features")
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                    ?: emptyList()
                if (negotiation.roomId == roomId && negotiation.mode != NegotiationMode.UNSUPPORTED) {
                    negotiation = NegotiationState(roomId, NegotiationMode.NEGOTIATED, features)
                    publishNewSessionsSupported()
                    cancelHelloFallback()
                    onNegotiationResolved()
                }
            }
            "daemon.unsupported" -> {
                negotiation = NegotiationState(roomId, NegotiationMode.UNSUPPORTED, emptyList())
                publishNewSessionsSupported()
                update {
                    it.copy(
                        detail = msg.string("message") ?: "unsupported_daemon_protocol",
                        status = RtcStatus.ERROR,
                    )
                }
                updateCanRetry()
            }
            "session.replaced" -> {
                update { it.copy(detail = "session_replaced", status = RtcStatus.CLOSED) }
                updateCanRetry()
                handler.post { client?.close() }
            }
            "rendezvous.accept" -> {
                val nextRoom = msg.string("roomId")
                if (rendezvous != null && nextRoom != null) {
                    update { it.copy(status = RtcStatus.IDLE) }
                    switchToRoom(nextRoom)
                }
            }
            "rendezvous.error" -> {
                if (rendezvous != null) {
                    val message = msg.string("message") ?: "rendezvous_error"
                    val onHostLane = activeRoomId == hostPeerId
                    if (
                        message == "unexpected_message" && onHostLane &&
                        _state.value.status == RtcStatus.OPEN &&
                        negotiation.roomId == activeRoomId &&
                        (negotiation.mode == NegotiationMode.PENDING || negotiation.mode == NegotiationMode.LEGACY)
                    ) {
                        // Older daemons reject client.hello on the rendezvous
                        // lane with unexpected_message. Treat it as legacy.
                        if (negotiation.mode == NegotiationMode.PENDING) {
                            negotiation = NegotiationState(activeRoomId, NegotiationMode.LEGACY, emptyList())
                            cancelHelloFallback()
                            onNegotiationResolved()
                        }
                        update { it.copy(detail = null) }
                        return
                    }
                    update { it.copy(detail = message, status = RtcStatus.ERROR) }
                    updateCanRetry()
                    maybeScheduleAutoRetry()
                }
            }
            "tts.catalog" -> {
                msg.obj("catalog")?.let { catalog ->
                    update { it.copy(ttsCatalog = decodeTtsCatalog(catalog)) }
                }
            }
            "stt.catalog" -> {
                msg.obj("catalog")?.let { catalog ->
                    update { it.copy(sttCatalog = decodeSttCatalog(catalog)) }
                }
            }
            "sessions.list" -> {
                val sessions = msg.array("sessions")?.mapNotNull { decodeRecentSession(it) }
                if (sessions != null) {
                    applyRecentSessionsSnapshot(
                        RecentSessionsSnapshot(msg.string("generatedAt") ?: "", sessions),
                    )
                }
            }
            "sessions.destinations" -> {
                msg.obj("catalog")?.let { catalog ->
                    update {
                        it.copy(
                            newSessionDestinationsCatalog = decodeNewSessionDestinationsCatalog(catalog),
                            newSessionDestinationsResponseSeq = it.newSessionDestinationsResponseSeq + 1,
                        )
                    }
                }
            }
            "sessions.catalog" -> {
                val catalog = msg.obj("catalog")
                if (catalog != null) {
                    val sessionsArray = catalog["sessions"] as? kotlinx.serialization.json.JsonArray
                    if (sessionsArray != null) {
                        val sessions = sessionsArray.mapNotNull { decodeRecentSession(it) }
                        val generatedAt = (catalog["generatedAt"] as? kotlinx.serialization.json.JsonPrimitive)
                            ?.takeIf { it.isString }?.content ?: ""
                        applyRecentSessionsSnapshot(RecentSessionsSnapshot(generatedAt, sessions))
                    }
                }
            }
        }
        for (listener in controlListeners) {
            runCatching { listener(msg) }
        }
    }

    private fun applyRecentSessionsSnapshot(snapshot: RecentSessionsSnapshot) {
        recentSessionsSnapshot = snapshot
        favoriteSessions = storage.reconcileFavoriteRecentSessions(hostPeerId, snapshot.sessions)
        setSupportStatus(RecentSessionsSupportStatus.SUPPORTED)
        update {
            it.copy(
                recentSessionsGeneratedAt = snapshot.generatedAt.takeIf { s -> s.isNotEmpty() },
                recentSessionsResponseSeq = it.recentSessionsResponseSeq + 1,
            )
        }
        publishRecentSessions()
    }

    private fun publishRecentSessions() {
        val merged = mergeRecentSessionsWithFavorites(recentSessionsSnapshot.sessions, favoriteSessions)
        update { it.copy(recentSessions = merged) }
    }

    private fun switchToRoom(roomId: String) {
        activeRoomId = roomId
        negotiation = NegotiationState(roomId, NegotiationMode.IDLE, emptyList())
        connectToRoom()
    }

    private fun onNegotiationResolved() {
        val roomId = activeRoomId ?: return
        if (_state.value.status != RtcStatus.OPEN) return

        val onHostLane = roomId == hostPeerId
        if (rendezvous != null && onHostLane) {
            // Rendezvous orchestration: send rendezvous.join once and wait for
            // the daemon to point us at the per-session voice room.
            val settingsKey = voiceSelectionKey(voiceSettings)
            if (settingsKey != null) appliedVoiceSettingsKey = settingsKey
            client?.sendControl(PhoneToDaemon.rendezvousJoin(rendezvous, voiceSettings))
            return
        }

        // Voice room (or host dashboard lane without rendezvous): request
        // catalogs once and subscribe to recent sessions once per room.
        if (catalogRequestedRoom != roomId) {
            catalogRequestedRoom = roomId
            if (allowsProtocolFeature(ProtocolFeatures.TTS_CATALOG)) {
                client?.sendControl(PhoneToDaemon.ttsCatalogRequest())
            }
            if (allowsProtocolFeature(ProtocolFeatures.STT_CATALOG)) {
                client?.sendControl(PhoneToDaemon.sttCatalogRequest())
            }
        }
        if (newSessionDestinationsRequestedRoom != roomId) {
            newSessionDestinationsRequestedRoom = roomId
            if (allowsProtocolFeature(ProtocolFeatures.SESSIONS_DESTINATIONS)) {
                client?.sendControl(PhoneToDaemon.sessionsDestinationsRequest())
            }
        }
        if (sessionsSubscribedRoom != roomId) {
            sessionsSubscribedRoom = roomId
            val allowList = allowsProtocolFeature(ProtocolFeatures.SESSIONS_LIST)
            val allowCatalog = allowsProtocolFeature(ProtocolFeatures.SESSIONS_CATALOG)
            if (!allowList && !allowCatalog) {
                setSupportStatus(RecentSessionsSupportStatus.UNSUPPORTED)
            } else {
                setProbingSupportStatus()
                if (allowList) client?.sendControl(PhoneToDaemon.sessionsListSubscribe())
                if (allowCatalog) client?.sendControl(PhoneToDaemon.sessionsCatalogRequest())
            }
        }
        pushVoiceSettingsIfNeeded()
    }

    private fun pushVoiceSettingsIfNeeded() {
        val roomId = activeRoomId ?: return
        if (rendezvous == null || hostPeerId == null) return
        if (roomId == hostPeerId) return
        if (_state.value.status != RtcStatus.OPEN) return
        if (!isNegotiationResolved()) return
        val settingsToSend = voiceSettings
        val key = voiceSelectionKey(settingsToSend)
        if (key == null) {
            if (appliedVoiceSettingsKey != null) {
                client?.sendControl(PhoneToDaemon.settingsUpdate(VoiceSettings()))
                appliedVoiceSettingsKey = null
                lastSentVoiceKey = null
            }
            return
        }
        if (settingsToSend == null) return
        if (lastSentVoiceKey == key) return
        appliedVoiceSettingsKey = key
        lastSentVoiceKey = key
        client?.sendControl(PhoneToDaemon.settingsUpdate(settingsToSend))
    }

    // ------------------------------------------------------------------
    // Retry / support-status helpers
    // ------------------------------------------------------------------

    private fun isRetryableConnectionState(): Boolean {
        val state = _state.value
        return activeRoomId != null &&
            state.detail != "session_replaced" &&
            state.detail != "unsupported_daemon_protocol" &&
            (state.status == RtcStatus.ERROR || state.status == RtcStatus.CLOSED)
    }

    private fun updateCanRetry() {
        update { it.copy(canRetryConnection = isRetryableConnectionState()) }
    }

    private fun maybeScheduleAutoRetry() {
        retryRunnable?.let { handler.removeCallbacks(it) }
        retryRunnable = null
        if (closed || !isRetryableConnectionState()) return
        val delay = RTC_RETRY_BACKOFF_MS[autoRetryAttempt.coerceIn(0, RTC_RETRY_BACKOFF_MS.size - 1)]
        val runnable = Runnable {
            retryRunnable = null
            if (closed || !isRetryableConnectionState()) return@Runnable
            autoRetryAttempt = (autoRetryAttempt + 1).coerceAtMost(RTC_RETRY_BACKOFF_MS.size - 1)
            update { it.copy(detail = null, status = RtcStatus.IDLE) }
            resetRetryConnectionRefs()
            reconnect()
        }
        retryRunnable = runnable
        handler.postDelayed(runnable, delay)
    }

    private fun resetRetryConnectionRefs() {
        lastSentVoiceKey = null
        catalogRequestedRoom = null
        newSessionDestinationsRequestedRoom = null
        sessionsSubscribedRoom = null
    }

    private fun setSupportStatusForLane() {
        val roomId = activeRoomId
        if (roomId == null || _state.value.status != RtcStatus.OPEN ||
            (rendezvous != null && roomId == hostPeerId)
        ) {
            setSupportStatus(RecentSessionsSupportStatus.UNKNOWN)
        }
    }

    private fun setProbingSupportStatus() {
        if (_state.value.recentSessionsSupportStatus != RecentSessionsSupportStatus.SUPPORTED) {
            setSupportStatus(RecentSessionsSupportStatus.PROBING)
        }
        probeTimeoutRunnable?.let { handler.removeCallbacks(it) }
        val runnable = Runnable {
            probeTimeoutRunnable = null
            val hasResponse = recentSessionsSnapshot.sessions.isNotEmpty() ||
                recentSessionsSnapshot.generatedAt.isNotEmpty()
            if (_state.value.recentSessionsSupportStatus == RecentSessionsSupportStatus.PROBING && !hasResponse) {
                setSupportStatus(RecentSessionsSupportStatus.UNSUPPORTED)
            }
        }
        probeTimeoutRunnable = runnable
        handler.postDelayed(runnable, RECENT_SESSIONS_SUPPORT_TIMEOUT_MS)
    }

    private fun setSupportStatus(status: RecentSessionsSupportStatus) {
        update { it.copy(recentSessionsSupportStatus = status) }
    }

    private fun publishNewSessionsSupported() {
        update { it.copy(newSessionsSupported = supportsNewSessionCreation()) }
    }

    private fun supportsNewSessionCreation(): Boolean =
        _state.value.status == RtcStatus.OPEN &&
            negotiation.roomId == activeRoomId &&
            negotiation.mode == NegotiationMode.NEGOTIATED &&
            ProtocolFeatures.SESSIONS_DESTINATIONS in negotiation.features &&
            ProtocolFeatures.SESSIONS_CREATE in negotiation.features

    private fun isNegotiationResolved(): Boolean =
        negotiation.roomId == activeRoomId &&
            (negotiation.mode == NegotiationMode.NEGOTIATED || negotiation.mode == NegotiationMode.LEGACY)

    private fun allowsProtocolFeature(feature: String): Boolean {
        if (negotiation.roomId != activeRoomId) return false
        if (negotiation.mode == NegotiationMode.LEGACY) return true
        return negotiation.mode == NegotiationMode.NEGOTIATED && feature in negotiation.features
    }

    private fun requiredFeatureForControlMessage(msg: ControlMessage): String? = when (msg.t) {
        "tts.catalog.request" -> ProtocolFeatures.TTS_CATALOG
        "stt.catalog.request" -> ProtocolFeatures.STT_CATALOG
        "sessions.list.request", "sessions.list.subscribe", "sessions.list.unsubscribe" ->
            ProtocolFeatures.SESSIONS_LIST
        "sessions.catalog.request" -> ProtocolFeatures.SESSIONS_CATALOG
        "sessions.destinations.request" -> ProtocolFeatures.SESSIONS_DESTINATIONS
        "sessions.create.request" -> ProtocolFeatures.SESSIONS_CREATE
        else -> null
    }

    private fun allowsControlMessage(msg: ControlMessage): Boolean {
        if (negotiation.roomId == activeRoomId && negotiation.mode == NegotiationMode.UNSUPPORTED) return false
        val feature = requiredFeatureForControlMessage(msg) ?: return true
        return allowsProtocolFeature(feature)
    }

    private fun cancelHelloFallback() {
        helloFallbackRunnable?.let { handler.removeCallbacks(it) }
        helloFallbackRunnable = null
    }

    private fun cancelTimers() {
        cancelHelloFallback()
        retryRunnable?.let { handler.removeCallbacks(it) }
        retryRunnable = null
        probeTimeoutRunnable?.let { handler.removeCallbacks(it) }
        probeTimeoutRunnable = null
    }

    private inline fun update(transform: (RtcUiState) -> RtcUiState) {
        _state.value = transform(_state.value)
    }

    val currentStatus: RtcStatus
        get() = _state.value.status

    val isConnected: Boolean
        get() = _state.value.status == RtcStatus.OPEN
}
