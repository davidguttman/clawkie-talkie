// Classify simple-peer signal payloads so we can decide whether an
// incoming signal is allowed to start a brand-new non-initiator peer.
//
// The bug this guards against: rambly's signaling server can deliver
// ICE `candidate` (or stale `answer`) frames before — or after — the
// SDP `offer` that a non-initiator peer needs to bootstrap from. If we
// blindly hand the first signal to `new SimplePeer({ initiator: false })`
// the underlying RTCPeerConnection ends up in the wrong state
// (`Failed to set remote answer sdp: Called in wrong state: stable`)
// and the link never establishes.

export type SignalKind =
  | 'offer'
  | 'answer'
  | 'candidate'
  | 'renegotiate'
  | 'transceiver'
  | 'unknown';

export function classifySignal(data: unknown): SignalKind {
  if (!data || typeof data !== 'object') return 'unknown';
  const d = data as Record<string, unknown>;
  if (d.type === 'offer') return 'offer';
  if (d.type === 'answer') return 'answer';
  if (d.type === 'candidate' || d.candidate !== undefined) return 'candidate';
  if (d.renegotiate) return 'renegotiate';
  if (d.transceiverRequest) return 'transceiver';
  return 'unknown';
}

export type SignalAction =
  | 'forward'
  | 'create-non-initiator'
  | 'buffer-candidate'
  | 'ignore';

export function decideIncomingSignal(input: {
  hasLivePeer: boolean;
  kind: SignalKind;
}): SignalAction {
  if (input.hasLivePeer) return 'forward';
  if (input.kind === 'offer') return 'create-non-initiator';
  if (input.kind === 'candidate') return 'buffer-candidate';
  return 'ignore';
}

// Tracks per-peer SDP application state so we can drop duplicates and
// role-invalid SDP on the forward path. The rambly signaling server has
// been observed to redeliver `answer` frames (e.g. on SSE reconnect),
// which then poisons RTCPeerConnection with `Called in wrong state:
// stable` when simple-peer.signal() retries setRemoteDescription.
export interface SdpRouteState {
  initiator: boolean;
  acceptedOffer: boolean;
  acceptedAnswer: boolean;
}

export type ForwardDecision =
  | 'forward'
  | 'drop-duplicate-sdp'
  | 'drop-unexpected-sdp';

export function decideForwardToLivePeer(
  state: SdpRouteState,
  kind: SignalKind,
): ForwardDecision {
  if (kind === 'candidate') return 'forward';
  if (kind === 'offer') {
    if (state.initiator) return 'drop-unexpected-sdp';
    if (state.acceptedOffer) return 'drop-duplicate-sdp';
    return 'forward';
  }
  if (kind === 'answer') {
    if (!state.initiator) return 'drop-unexpected-sdp';
    if (state.acceptedAnswer) return 'drop-duplicate-sdp';
    return 'forward';
  }
  return 'drop-unexpected-sdp';
}
