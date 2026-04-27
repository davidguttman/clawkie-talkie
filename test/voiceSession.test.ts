import { describe, expect, it } from 'vitest';
import { createVoiceSessionState, decidePhoneConnection } from '../daemon/src/voiceSession';

describe('voice session state', () => {
  it('binds one room to one session and delivery target for its lifetime', () => {
    const s = createVoiceSessionState({
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    expect(s.chatTarget()).toEqual({
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });
    expect(s.roomId).toBe('host-1:session-1');
  });

  it('does not accept route changes on stt.start', () => {
    const s = createVoiceSessionState({
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    s.handleStartTurn();

    expect(s.chatTarget().sessionId).toBe('session-1');
    expect(s.chatTarget().delivery.target).toBe('channel:thread-1');
    expect(s.turnInFlight).toBe(true);
  });

  it('marks a voice session closed after cleanup', () => {
    const s = createVoiceSessionState({
      roomId: 'host:s1',
      sessionId: 's1',
      delivery: { channel: 'discord', target: 'channel:t1' },
    });
    expect(s.closed).toBe(false);
    s.close();
    expect(s.closed).toBe(true);
  });

  it('resetTurn clears in-flight flag', () => {
    const s = createVoiceSessionState({
      roomId: 'host:s1',
      sessionId: 's1',
      delivery: { channel: 'discord', target: 'channel:t1' },
    });
    s.handleStartTurn();
    s.resetTurn();
    expect(s.turnInFlight).toBe(false);
  });

  it('uses last-phone-wins decisions for a different incoming phone', () => {
    expect(
      decidePhoneConnection({
        hasCurrentPeer: false,
        currentRemoteId: null,
        incomingRemoteId: 'phone-a',
      }),
    ).toBe('accept');

    expect(
      decidePhoneConnection({
        hasCurrentPeer: true,
        currentRemoteId: 'phone-a',
        incomingRemoteId: 'phone-a',
      }),
    ).toBe('use_existing');

    expect(
      decidePhoneConnection({
        hasCurrentPeer: true,
        currentRemoteId: 'phone-a',
        incomingRemoteId: 'phone-b',
      }),
    ).toBe('replace_existing');
  });
});
