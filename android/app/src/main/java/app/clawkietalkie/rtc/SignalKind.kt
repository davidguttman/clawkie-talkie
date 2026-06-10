package app.clawkietalkie.rtc

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// Classify simple-peer signal payloads so we can decide whether an incoming
// signal is allowed to start a brand-new non-initiator peer. Mirror of the
// web client's `src/rtc/signalKind.ts`, including the duplicate-SDP guards.

enum class SignalKind { OFFER, ANSWER, CANDIDATE, RENEGOTIATE, TRANSCEIVER, UNKNOWN }

fun classifySignal(data: JsonObject?): SignalKind {
    if (data == null) return SignalKind.UNKNOWN
    val type = (data["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (type == "offer") return SignalKind.OFFER
    if (type == "answer") return SignalKind.ANSWER
    if (type == "candidate" || data.containsKey("candidate")) return SignalKind.CANDIDATE
    val renegotiate = (data["renegotiate"] as? JsonPrimitive)?.booleanOrNull
    if (renegotiate == true) return SignalKind.RENEGOTIATE
    if (data.containsKey("transceiverRequest")) return SignalKind.TRANSCEIVER
    return SignalKind.UNKNOWN
}

enum class SignalAction { FORWARD, CREATE_NON_INITIATOR, BUFFER_CANDIDATE, IGNORE }

fun decideIncomingSignal(hasLivePeer: Boolean, kind: SignalKind): SignalAction {
    if (hasLivePeer) return SignalAction.FORWARD
    if (kind == SignalKind.OFFER) return SignalAction.CREATE_NON_INITIATOR
    if (kind == SignalKind.CANDIDATE) return SignalAction.BUFFER_CANDIDATE
    return SignalAction.IGNORE
}

data class SdpRouteState(
    val initiator: Boolean,
    val acceptedOffer: Boolean,
    val acceptedAnswer: Boolean,
)

enum class ForwardDecision { FORWARD, DROP_DUPLICATE_SDP, DROP_UNEXPECTED_SDP }

fun decideForwardToLivePeer(state: SdpRouteState, kind: SignalKind): ForwardDecision {
    if (kind == SignalKind.CANDIDATE) return ForwardDecision.FORWARD
    if (kind == SignalKind.OFFER) {
        if (state.initiator) return ForwardDecision.DROP_UNEXPECTED_SDP
        if (state.acceptedOffer) return ForwardDecision.DROP_DUPLICATE_SDP
        return ForwardDecision.FORWARD
    }
    if (kind == SignalKind.ANSWER) {
        if (!state.initiator) return ForwardDecision.DROP_UNEXPECTED_SDP
        if (state.acceptedAnswer) return ForwardDecision.DROP_DUPLICATE_SDP
        return ForwardDecision.FORWARD
    }
    return ForwardDecision.DROP_UNEXPECTED_SDP
}
