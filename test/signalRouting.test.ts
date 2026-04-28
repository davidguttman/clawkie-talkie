import { describe, expect, it } from 'vitest';
import {
  classifySignal,
  decideIncomingSignal,
} from '../daemon/src/signalKind';
import {
  classifySignal as classifyClient,
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
