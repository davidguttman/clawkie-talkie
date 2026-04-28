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
