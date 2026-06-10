package app.clawkietalkie.rtc

import app.clawkietalkie.protocol.ControlMessage
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.Executors

// WebRTC client. Joins a "room" named after the daemon's UUID via the
// rambly-style signaling server; the daemon (already in the room) is the
// initiator per the rambly convention and sends the SDP offer. The phone
// never initiates. The DataChannel carries JSON control frames + binary
// PCM16 audio; the daemon's TTS audio additionally arrives as a remote
// WebRTC audio track. Mirror of the web client's `src/rtc/client.ts`.

enum class RtcStatus { IDLE, CONNECTING, OPEN, ERROR, CLOSED }

interface RtcClientListener {
    fun onStatusChange(status: RtcStatus, detail: String?) {}
    fun onControlMessage(msg: ControlMessage) {}
    fun onBinaryMessage(bytes: ByteArray) {}
    fun onRemoteAudioTrack(track: AudioTrack) {}
}

data class IceServer(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

val HOSTED_DEFAULT_ICE_SERVERS = listOf(
    IceServer(urls = listOf("stun:stun.l.google.com:19302")),
    IceServer(urls = listOf("turn:api.rambly.app:3478"), username = "rambly", credential = "rambly"),
)

private const val MAX_BUFFERED_CANDIDATES_PER_PEER = 32

fun randomPeerId(): String {
    val bytes = ByteArray(12)
    SecureRandom().nextBytes(bytes)
    return "phone-" + bytes.joinToString("") { "%02x".format(it) }
}

class RtcClient(
    private val factory: PeerConnectionFactory,
    private val hostPeerId: String,
    signalServer: String,
    iceServers: List<IceServer> = HOSTED_DEFAULT_ICE_SERVERS,
    private val listener: RtcClientListener,
) {
    val peerId: String = randomPeerId()

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "rtc-client").apply { isDaemon = true }
    }

    private val rtcIceServers: List<PeerConnection.IceServer> = iceServers.map { server ->
        PeerConnection.IceServer.builder(server.urls)
            .apply {
                if (server.username != null) setUsername(server.username)
                if (server.credential != null) setPassword(server.credential)
            }
            .createIceServer()
    }

    private val signalClient = SignalClient(
        signalServer = signalServer,
        peerId = peerId,
        roomName = hostPeerId,
        listener = object : SignalListener {
            override fun onError(error: Throwable) {
                run { if (!closed) setStatus(RtcStatus.ERROR, "signal:${error.message}") }
            }

            override fun onAnnounce(peerId: String) {
                run {
                    // The daemon is the one that initiates; we just remember
                    // who it is so we can route signals.
                    if (remotePeerId != null && remotePeerId != peerId) return@run
                    remotePeerId = peerId
                }
            }

            override fun onSignal(event: SignalEvent) {
                run { handleSignal(event) }
            }
        },
    )

    private var peer: PeerConnection? = null
    private var dataChannel: DataChannel? = null
    private var peerInitiator = false
    private var acceptedOffer = false
    private var acceptedAnswer = false
    private var remotePeerId: String? = null
    private var status = RtcStatus.IDLE
    private var closed = false
    private var channelOpen = false
    private var makingAnswer = false
    private val pendingCandidates = HashMap<String, MutableList<JsonObject>>()
    // Candidates received after the offer but before setRemoteDescription
    // completed (the answer flow is async on Android, unlike simple-peer's
    // internal queueing).
    private val preRemoteDescriptionCandidates = mutableListOf<IceCandidate>()
    private var remoteDescriptionSet = false

    private fun run(block: () -> Unit) {
        if (executor.isShutdown) return
        try {
            executor.execute(block)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // shutting down
        }
    }

    fun connect() {
        run {
            if (closed) return@run
            setStatus(RtcStatus.CONNECTING, null)
            signalClient.subscribe()
        }
    }

    fun sendControl(msg: ControlMessage) {
        run {
            val channel = dataChannel ?: return@run
            if (!channelOpen) return@run
            try {
                val bytes = msg.encode().toByteArray(Charsets.UTF_8)
                channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
            } catch (err: Exception) {
                android.util.Log.e("rtc", "sendControl failed", err)
            }
        }
    }

    fun sendBinary(bytes: ByteArray) {
        run {
            val channel = dataChannel ?: return@run
            if (!channelOpen) return@run
            try {
                channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true))
            } catch (_: Exception) {
                // ignore
            }
        }
    }

    fun close() {
        run {
            if (closed) return@run
            closed = true
            disposeLivePeer()
            try {
                signalClient.close()
            } catch (_: Exception) {
            }
            setStatus(RtcStatus.CLOSED, null)
        }
        executor.shutdown()
    }

    /** Must run on the executor. Tears down the active channel + peer pair. */
    private fun disposeLivePeer() {
        val channel = dataChannel
        dataChannel = null
        channelOpen = false
        if (channel != null) {
            runCatching { channel.unregisterObserver() }
            runCatching { channel.close() }
            runCatching { channel.dispose() }
        }
        val connection = peer
        peer = null
        if (connection != null) {
            runCatching { connection.dispose() }
        }
    }

    // ------------------------------------------------------------------
    // Incoming signal routing (mirror of handleSignal in client.ts)
    // ------------------------------------------------------------------

    private fun handleSignal(event: SignalEvent) {
        if (closed) return
        val payload = event.data
        val livePeer = peer != null && remotePeerId == event.from
        val kind = classifySignal(payload)
        when (decideIncomingSignal(hasLivePeer = livePeer, kind = kind)) {
            SignalAction.FORWARD -> {
                val decision = decideForwardToLivePeer(
                    SdpRouteState(peerInitiator, acceptedOffer, acceptedAnswer),
                    kind,
                )
                if (decision != ForwardDecision.FORWARD) {
                    android.util.Log.w("rtc", "dropping $kind from ${event.from}: $decision")
                    return
                }
                applySignal(payload, kind)
            }
            SignalAction.CREATE_NON_INITIATOR -> {
                remotePeerId = event.from
                val buffered = pendingCandidates.remove(event.from) ?: emptyList()
                setupPeer(payload)
                for (candidate in buffered) applySignal(candidate, SignalKind.CANDIDATE)
            }
            SignalAction.BUFFER_CANDIDATE -> {
                val list = pendingCandidates.getOrPut(event.from) { mutableListOf() }
                if (list.size >= MAX_BUFFERED_CANDIDATES_PER_PEER) return
                list.add(payload)
            }
            SignalAction.IGNORE -> {
                android.util.Log.w("rtc", "ignoring $kind signal from ${event.from} with no live peer")
            }
        }
    }

    private fun applySignal(payload: JsonObject, kind: SignalKind) {
        val peer = this.peer ?: return
        when (kind) {
            SignalKind.OFFER -> {
                val sdp = (payload["sdp"] as? JsonPrimitive)?.content ?: return
                acceptedOffer = true
                setRemoteOfferAndAnswer(peer, sdp)
            }
            SignalKind.CANDIDATE -> {
                val candidate = decodeIceCandidate(payload) ?: return
                if (!remoteDescriptionSet) {
                    preRemoteDescriptionCandidates.add(candidate)
                } else {
                    peer.addIceCandidate(candidate)
                }
            }
            else -> {
                // renegotiate/transceiver requests come from a non-initiator
                // simple-peer; the daemon is the initiator so these should not
                // arrive. Mirror the web client by ignoring them on the
                // forward path (decideForwardToLivePeer already drops them).
            }
        }
    }

    private fun decodeIceCandidate(payload: JsonObject): IceCandidate? {
        val source = payload["candidate"] as? JsonObject ?: return null
        val candidate = (source["candidate"] as? JsonPrimitive)?.content ?: return null
        val sdpMid = (source["sdpMid"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val sdpMLineIndex = (source["sdpMLineIndex"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
        return IceCandidate(sdpMid, sdpMLineIndex, candidate)
    }

    // ------------------------------------------------------------------
    // Peer setup (non-initiator; the daemon sent us an offer)
    // ------------------------------------------------------------------

    private fun setupPeer(initialOffer: JsonObject) {
        if (closed) return
        // A fresh offer (e.g. daemon restart with a new peer id) replaces any
        // previous connection; dispose it so the native objects don't leak.
        disposeLivePeer()
        val config = PeerConnection.RTCConfiguration(rtcIceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        peerInitiator = false
        acceptedOffer = false
        acceptedAnswer = false
        remoteDescriptionSet = false
        preRemoteDescriptionCandidates.clear()
        channelOpen = false

        val observer = object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                run {
                    val target = remotePeerId ?: return@run
                    // simple-peer wire shape: { type: 'candidate', candidate: {...} }
                    val payload = buildJsonObject {
                        put("type", "candidate")
                        put("candidate", buildJsonObject {
                            put("candidate", candidate.sdp)
                            put("sdpMLineIndex", candidate.sdpMLineIndex)
                            put("sdpMid", candidate.sdpMid ?: "")
                        })
                    }
                    sendSignalAsync(target, payload)
                }
            }

            override fun onDataChannel(channel: DataChannel) {
                run {
                    dataChannel = channel
                    registerDataChannel(channel)
                }
            }

            override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) {
                val track = transceiver?.receiver?.track()
                if (track is AudioTrack) {
                    run { if (!closed) listener.onRemoteAudioTrack(track) }
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                run {
                    if (closed) return@run
                    when (newState) {
                        PeerConnection.PeerConnectionState.FAILED ->
                            setStatus(RtcStatus.ERROR, "peer:connection_failed")
                        PeerConnection.PeerConnectionState.CLOSED -> {
                            // Release the live-peer pair (mirror of the web
                            // client nulling `this.peer` on 'close') so a
                            // fresh daemon offer can bootstrap a new peer.
                            disposeLivePeer()
                            setStatus(RtcStatus.CLOSED, null)
                        }
                        else -> {}
                    }
                }
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onAddStream(stream: MediaStream?) {}
            override fun onRemoveStream(stream: MediaStream?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
        }

        val connection = factory.createPeerConnection(config, observer)
        if (connection == null) {
            setStatus(RtcStatus.ERROR, "peer:create_failed")
            return
        }
        peer = connection

        val sdp = (initialOffer["sdp"] as? JsonPrimitive)?.content
        if (sdp != null) {
            acceptedOffer = true
            setRemoteOfferAndAnswer(connection, sdp)
        }
    }

    /** Must run on the executor; true while [connection] is still the live peer. */
    private fun isLiveConnection(connection: PeerConnection): Boolean =
        !closed && peer === connection

    private fun setRemoteOfferAndAnswer(connection: PeerConnection, sdp: String) {
        if (makingAnswer) return
        makingAnswer = true
        val offer = SessionDescription(SessionDescription.Type.OFFER, sdp)
        connection.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() {
                run {
                    makingAnswer = false
                    if (!isLiveConnection(connection)) return@run
                    remoteDescriptionSet = true
                    for (candidate in preRemoteDescriptionCandidates) {
                        runCatching { connection.addIceCandidate(candidate) }
                    }
                    preRemoteDescriptionCandidates.clear()
                    createAndSendAnswer(connection)
                }
            }

            override fun onSetFailure(error: String?) {
                run {
                    makingAnswer = false
                    if (!closed) setStatus(RtcStatus.ERROR, "peer:setRemoteDescription:$error")
                }
            }
        }, offer)
    }

    private fun createAndSendAnswer(connection: PeerConnection) {
        connection.createAnswer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(description: SessionDescription) {
                run {
                    if (!isLiveConnection(connection)) return@run
                    runCatching {
                        connection.setLocalDescription(object : SdpObserverAdapter() {
                            override fun onSetSuccess() {
                                run {
                                    if (!isLiveConnection(connection)) return@run
                                    val target = remotePeerId ?: return@run
                                    val payload = buildJsonObject {
                                        put("type", "answer")
                                        put("sdp", description.description)
                                    }
                                    sendSignalAsync(target, payload)
                                }
                            }

                            override fun onSetFailure(error: String?) {
                                run { if (!closed) setStatus(RtcStatus.ERROR, "peer:setLocalDescription:$error") }
                            }
                        }, description)
                    }
                }
            }

            override fun onCreateFailure(error: String?) {
                run { if (!closed) setStatus(RtcStatus.ERROR, "peer:createAnswer:$error") }
            }
        }, MediaConstraints())
    }

    private fun registerDataChannel(channel: DataChannel) {
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}

            override fun onStateChange() {
                run {
                    if (closed) return@run
                    when (channel.state()) {
                        DataChannel.State.OPEN -> {
                            channelOpen = true
                            setStatus(RtcStatus.OPEN, null)
                        }
                        DataChannel.State.CLOSED -> {
                            channelOpen = false
                            if (!closed) setStatus(RtcStatus.CLOSED, null)
                        }
                        else -> {}
                    }
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                // Copy out before leaving the callback; the buffer is reused.
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                run {
                    if (closed) return@run
                    // Control messages are JSON objects, so the first byte is
                    // '{'. PCM16 audio frames almost never start with 0x7B, so
                    // this is a reliable split (mirrors the web client).
                    val text = tryDecodeJsonText(bytes)
                    if (text != null) {
                        val msg = ControlMessage.parse(text)
                        if (msg != null) {
                            listener.onControlMessage(msg)
                            return@run
                        }
                    }
                    listener.onBinaryMessage(bytes)
                }
            }
        })
        // The channel may already be open by the time we attach.
        if (channel.state() == DataChannel.State.OPEN) {
            channelOpen = true
            setStatus(RtcStatus.OPEN, null)
        }
    }

    private fun sendSignalAsync(target: String, payload: JsonObject) {
        Thread {
            try {
                signalClient.sendSignal(target, payload)
            } catch (err: Exception) {
                android.util.Log.e("rtc", "sendSignal failed", err)
            }
        }.apply {
            isDaemon = true
            start()
        }
    }

    private fun setStatus(next: RtcStatus, detail: String?) {
        if (status == next && detail == null) return
        status = next
        listener.onStatusChange(next, detail)
    }
}

private fun tryDecodeJsonText(bytes: ByteArray): String? {
    if (bytes.isEmpty()) return null
    if (bytes[0] != 0x7b.toByte()) return null
    return try {
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        decoder.decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: Exception) {
        null
    }
}

private open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {}
    override fun onSetFailure(error: String?) {}
}
