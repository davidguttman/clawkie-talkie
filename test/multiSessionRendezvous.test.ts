import { describe, expect, it } from 'vitest';
import { makeVoiceRoomId } from '../daemon/src/voiceRoom';
import { createVoiceSessionState } from '../daemon/src/voiceSession';

describe('multi-session rendezvous', () => {
  it('derives separate rooms for separate sessions on the same host', () => {
    const host = 'host-1';
    const roomA = makeVoiceRoomId({ hostPeerId: host, sessionId: 'session-a' });
    const roomB = makeVoiceRoomId({ hostPeerId: host, sessionId: 'session-b' });

    expect(roomA).toBe('host-1:session-a');
    expect(roomB).toBe('host-1:session-b');
    expect(roomA).not.toBe(roomB);
  });

  it('keeps chat targets isolated by room', () => {
    const a = createVoiceSessionState({
      roomId: 'host-1:session-a',
      sessionId: 'session-a',
      delivery: { channel: 'discord', target: 'channel:thread-a' },
    });
    const b = createVoiceSessionState({
      roomId: 'host-1:session-b',
      sessionId: 'session-b',
      delivery: { channel: 'slack', target: 'channel:C123' },
    });

    expect(a.chatTarget()).toEqual({
      sessionId: 'session-a',
      delivery: { channel: 'discord', target: 'channel:thread-a' },
    });
    expect(b.chatTarget()).toEqual({
      sessionId: 'session-b',
      delivery: { channel: 'slack', target: 'channel:C123' },
    });
  });

  it('closing one session does not affect the other', () => {
    const a = createVoiceSessionState({
      roomId: 'host:s-a',
      sessionId: 's-a',
      delivery: { channel: 'discord', target: 'channel:t-a' },
    });
    const b = createVoiceSessionState({
      roomId: 'host:s-b',
      sessionId: 's-b',
      delivery: { channel: 'discord', target: 'channel:t-b' },
    });
    a.close();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(b.chatTarget().sessionId).toBe('s-b');
  });
});
