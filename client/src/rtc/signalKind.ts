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

export type AnnounceDecision = 'ignore' | 'remember' | 'initiate';

// The signaling server announces a new subscriber only to peers already
// in the room. The voice-room daemon subscribes when the session is
// created, which races the phone's subscribe right after
// rendezvous.accept. If the phone lands first, the daemon's later
// subscribe is announced to the phone and the daemon never learns the
// phone is waiting, so nobody offers and the UI stays on CONNECTING.
// The phone must offer in that case. When the daemon was already in the
// room it is the one who sees the announce and offers; the phone does
// not get an announce and keeps the non-initiator path.
export function decidePeerAnnounce(input: {
  hasLivePeer: boolean;
  currentRemoteId: string | null;
  announcedPeerId: string;
}): AnnounceDecision {
  if (!input.announcedPeerId) return 'ignore';
  if (input.hasLivePeer) {
    if (input.currentRemoteId && input.currentRemoteId !== input.announcedPeerId) return 'ignore';
    return 'remember';
  }
  return 'initiate';
}

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
