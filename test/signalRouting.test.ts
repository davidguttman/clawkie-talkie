import { describe, expect, it } from 'vitest';
import {
  classifySignal,
  decideForwardToLivePeer,
  decideIncomingSignal,
  type SdpRouteState,
} from '../daemon/src/signalKind';
import {
  classifySignal as classifyClient,
  decideForwardToLivePeer as decideForwardClient,
  decideIncomingSignal as decideClient,
} from '../client/src/rtc/signalKind';

describe('classifySignal', () => {
  it('identifies offer/answer by SDP type', () => {
    expect(classifySignal({ type: 'offer', sdp: 'v=0' })).toBe('offer');
    expect(classifySignal({ type: 'answer', sdp: 'v=0' })).toBe('answer');
  });

  it('identifies ICE candidates by candidate field', () => {
    expect(
      classifySignal({ candidate: { candidate: 'candidate:...', sdpMLineIndex: 0 } }),
    ).toBe('candidate');
    expect(classifySignal({ type: 'candidate', candidate: 'foo' })).toBe('candidate');
  });

  it('identifies renegotiate / transceiverRequest', () => {
    expect(classifySignal({ renegotiate: true })).toBe('renegotiate');
    expect(classifySignal({ transceiverRequest: { kind: 'audio' } })).toBe(
      'transceiver',
    );
  });

  it('returns unknown for malformed input', () => {
    expect(classifySignal(null)).toBe('unknown');
    expect(classifySignal('hi')).toBe('unknown');
    expect(classifySignal({})).toBe('unknown');
  });

  it('client and daemon classifiers agree', () => {
    const cases: unknown[] = [
      { type: 'offer', sdp: 'x' },
      { type: 'answer', sdp: 'x' },
      { candidate: { candidate: 'a' } },
      { renegotiate: true },
      {},
    ];
    for (const c of cases) {
      expect(classifyClient(c)).toBe(classifySignal(c));
    }
  });
});

describe('decideIncomingSignal', () => {
  it('forwards any signal to a live peer', () => {
    expect(decideIncomingSignal({ hasLivePeer: true, kind: 'offer' })).toBe('forward');
    expect(decideIncomingSignal({ hasLivePeer: true, kind: 'answer' })).toBe('forward');
    expect(decideIncomingSignal({ hasLivePeer: true, kind: 'candidate' })).toBe('forward');
  });

  it('creates a non-initiator peer only on offer when no peer exists', () => {
    expect(decideIncomingSignal({ hasLivePeer: false, kind: 'offer' })).toBe(
      'create-non-initiator',
    );
  });

  it('buffers candidates that arrive before an offer', () => {
    expect(decideIncomingSignal({ hasLivePeer: false, kind: 'candidate' })).toBe(
      'buffer-candidate',
    );
  });

  it('ignores stale answer / renegotiate / unknown when there is no peer', () => {
    expect(decideIncomingSignal({ hasLivePeer: false, kind: 'answer' })).toBe('ignore');
    expect(decideIncomingSignal({ hasLivePeer: false, kind: 'renegotiate' })).toBe(
      'ignore',
    );
    expect(decideIncomingSignal({ hasLivePeer: false, kind: 'transceiver' })).toBe(
      'ignore',
    );
    expect(decideIncomingSignal({ hasLivePeer: false, kind: 'unknown' })).toBe('ignore');
  });

  it('client and daemon decision helpers agree', () => {
    const inputs = [
      { hasLivePeer: false, kind: 'offer' as const },
      { hasLivePeer: false, kind: 'candidate' as const },
      { hasLivePeer: false, kind: 'answer' as const },
      { hasLivePeer: true, kind: 'candidate' as const },
    ];
    for (const inp of inputs) {
      expect(decideClient(inp)).toBe(decideIncomingSignal(inp));
    }
  });
});

// Behavioral sketch: walk the (hasPeer, kind) state machine through the
// candidate-before-offer ordering observed against api.rambly.app and
// assert the route through the helper does not try to bootstrap a
// non-initiator peer from a candidate or a stale answer.
describe('candidate-before-offer ordering', () => {
  it('buffers candidate first, then creates peer on offer', () => {
    const incoming = [
      { candidate: { candidate: 'a=...' } },
      { type: 'offer', sdp: 'v=0' },
    ];
    const actions = incoming.map((sig) =>
      decideIncomingSignal({ hasLivePeer: false, kind: classifySignal(sig) }),
    );
    expect(actions).toEqual(['buffer-candidate', 'create-non-initiator']);
  });

  it('ignores a stale answer arriving with no peer (post-teardown)', () => {
    const action = decideIncomingSignal({
      hasLivePeer: false,
      kind: classifySignal({ type: 'answer', sdp: 'v=0' }),
    });
    expect(action).toBe('ignore');
  });

  it('forwards to live peer regression: prior fix decides forward only on hasLivePeer', () => {
    expect(decideIncomingSignal({ hasLivePeer: true, kind: 'answer' })).toBe('forward');
  });

  it('ignores a stale candidate after teardown if we never re-established', () => {
    // Even without an offer, the non-creating path is "buffer", but
    // upstream callers must drop buffers on teardown — see
    // dropRendezvous / VoiceSession.close pendingCandidates.clear().
    const action = decideIncomingSignal({
      hasLivePeer: false,
      kind: classifySignal({ candidate: { candidate: 'a' } }),
    });
    expect(action).toBe('buffer-candidate');
  });
});

// Regression for the second observed daemon failure: "Failed to set
// remote answer sdp: Called in wrong state: stable". The signaling
// server redelivered the same `answer` after RTCPeerConnection moved
// to stable; forwarding it tore down the rendezvous peer.
describe('decideForwardToLivePeer', () => {
  const fresh = (over: Partial<SdpRouteState> = {}): SdpRouteState => ({
    initiator: false,
    acceptedOffer: false,
    acceptedAnswer: false,
    ...over,
  });

  it('forwards candidates regardless of role/state', () => {
    expect(decideForwardToLivePeer(fresh(), 'candidate')).toBe('forward');
    expect(
      decideForwardToLivePeer(fresh({ initiator: true, acceptedAnswer: true }), 'candidate'),
    ).toBe('forward');
  });

  it('forwards the first offer to a non-initiator', () => {
    expect(decideForwardToLivePeer(fresh({ initiator: false }), 'offer')).toBe('forward');
  });

  it('drops a duplicate offer to a non-initiator (re-delivered SDP)', () => {
    expect(
      decideForwardToLivePeer(fresh({ initiator: false, acceptedOffer: true }), 'offer'),
    ).toBe('drop-duplicate-sdp');
  });

  it('drops an offer aimed at an initiator (no renegotiation in this app)', () => {
    expect(decideForwardToLivePeer(fresh({ initiator: true }), 'offer')).toBe(
      'drop-unexpected-sdp',
    );
  });

  it('forwards the first answer to an initiator', () => {
    expect(decideForwardToLivePeer(fresh({ initiator: true }), 'answer')).toBe('forward');
  });

  it('drops a duplicate answer to an initiator (the rambly redelivery bug)', () => {
    expect(
      decideForwardToLivePeer(fresh({ initiator: true, acceptedAnswer: true }), 'answer'),
    ).toBe('drop-duplicate-sdp');
  });

  it('drops an answer aimed at a non-initiator', () => {
    expect(decideForwardToLivePeer(fresh({ initiator: false }), 'answer')).toBe(
      'drop-unexpected-sdp',
    );
  });

  it('drops renegotiate / transceiver / unknown on rendezvous peers', () => {
    expect(decideForwardToLivePeer(fresh({ initiator: true }), 'renegotiate')).toBe(
      'drop-unexpected-sdp',
    );
    expect(decideForwardToLivePeer(fresh({ initiator: true }), 'transceiver')).toBe(
      'drop-unexpected-sdp',
    );
    expect(decideForwardToLivePeer(fresh({ initiator: true }), 'unknown')).toBe(
      'drop-unexpected-sdp',
    );
  });

  it('client and daemon forward decisions agree', () => {
    const cases = [
      { state: fresh({ initiator: true, acceptedAnswer: true }), kind: 'answer' as const },
      { state: fresh({ initiator: false }), kind: 'offer' as const },
      { state: fresh({ initiator: false, acceptedOffer: true }), kind: 'offer' as const },
      { state: fresh(), kind: 'candidate' as const },
    ];
    for (const c of cases) {
      expect(decideForwardClient(c.state, c.kind)).toBe(
        decideForwardToLivePeer(c.state, c.kind),
      );
    }
  });
});

// Walk a full sequence through the helpers to mimic what the daemon's
// rendezvous initiator now does when the signaling server redelivers
// the answer twice and emits a stale candidate after the answer.
describe('initiator receives duplicate answer + stale candidate', () => {
  it('first answer forwards, second answer is dropped, candidate still forwards', () => {
    const state: SdpRouteState = {
      initiator: true,
      acceptedOffer: false,
      acceptedAnswer: false,
    };
    // 1st: answer → forward, mark accepted.
    expect(decideForwardToLivePeer(state, 'answer')).toBe('forward');
    state.acceptedAnswer = true;
    // 2nd: same answer redelivered → drop, no peer.signal() retry.
    expect(decideForwardToLivePeer(state, 'answer')).toBe('drop-duplicate-sdp');
    // Trickled candidate after the stable transition still forwards.
    expect(decideForwardToLivePeer(state, 'candidate')).toBe('forward');
  });
});
