import { describe, expect, it } from 'vitest';
import { makeVoiceRoomId as daemonMakeVoiceRoomId } from '../daemon/src/voiceRoom';
import { makeVoiceRoomId as clientMakeVoiceRoomId } from '../client/src/rtc/voiceRoom';

describe('voice room derivation', () => {
  it('derives the same room id in daemon and client code', () => {
    const input = {
      hostPeerId: 'host-123',
      sessionId: 'agent:main:discord:channel:1498020851298209852',
    };

    expect(daemonMakeVoiceRoomId(input)).toBe('host-123:agent_main_discord_channel_1498020851298209852');
    expect(clientMakeVoiceRoomId(input)).toBe(daemonMakeVoiceRoomId(input));
  });

  it('keeps different sessions in different rooms', () => {
    expect(
      daemonMakeVoiceRoomId({ hostPeerId: 'host-123', sessionId: 'session-a' }),
    ).not.toBe(
      daemonMakeVoiceRoomId({ hostPeerId: 'host-123', sessionId: 'session-b' }),
    );
  });
});
