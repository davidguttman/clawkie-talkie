import { describe, expect, it, vi } from 'vitest';
import {
  buildRecentSessionsFromRows,
  createRecentSessionsCache,
  extractDiscordChannelName,
  parseOpenClawSessionKey,
} from '../daemon/src/recentSessions';

describe('recent OpenClaw session parsing', () => {
  it('derives Discord routing metadata and labels from OpenClaw session keys', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: 'agent:kamaji:discord:channel:1501301184101617886',
          sessionId: 'uuid-1',
          updatedAt: '2026-05-05T19:26:00.000Z',
          agentId: 'kamaji',
        },
      ],
      {
        generatedAt: '2026-05-05T19:27:00.000Z',
        resolveDisplayLabel: async (session) => {
          expect(session.target).toBe('channel:1501301184101617886');
          return 'planning thread';
        },
      },
    );

    expect(snapshot).toEqual({
      generatedAt: '2026-05-05T19:27:00.000Z',
      sessions: [
        {
          sessionId: 'uuid-1',
          sessionKey: 'agent:kamaji:discord:channel:1501301184101617886',
          agent: 'kamaji',
          channel: 'discord',
          target: 'channel:1501301184101617886',
          lastActivity: '2026-05-05T19:26:00.000Z',
          displayLabel: 'planning thread',
        },
      ],
    });
  });

  it('sorts by last activity and caps to the 10 most recent sessions', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      key: `agent:main:discord:channel:${index}`,
      sessionId: `session-${index}`,
      updatedAt: `2026-05-05T19:${String(index).padStart(2, '0')}:00.000Z`,
    }));

    const snapshot = await buildRecentSessionsFromRows(rows, { generatedAt: 'now' });

    expect(snapshot.sessions).toHaveLength(10);
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      'session-11',
      'session-10',
      'session-9',
      'session-8',
      'session-7',
      'session-6',
      'session-5',
      'session-4',
      'session-3',
      'session-2',
    ]);
  });

  it('preserves numeric updatedAt timestamps as ISO last activity', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: 'agent:kamaji:discord:channel:numeric',
          sessionId: 'numeric-session',
          updatedAt: Date.parse('2026-05-05T19:30:00.000Z'),
        },
      ],
      { generatedAt: 'now' },
    );

    expect(snapshot.sessions[0].lastActivity).toBe('2026-05-05T19:30:00.000Z');
  });

  it('sorts mixed numeric and ISO last activity timestamps', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: 'agent:main:discord:channel:iso-old',
          sessionId: 'iso-old',
          updatedAt: '2026-05-05T19:29:00.000Z',
        },
        {
          key: 'agent:main:discord:channel:numeric-new',
          sessionId: 'numeric-new',
          updatedAt: Date.parse('2026-05-05T19:31:00.000Z'),
        },
        {
          key: 'agent:main:discord:channel:numeric-middle',
          sessionId: 'numeric-middle',
          lastActivity: Date.parse('2026-05-05T19:30:00.000Z'),
        },
        {
          key: 'agent:main:discord:channel:numeric-oldest',
          sessionId: 'numeric-oldest',
          lastActivityAt: Date.parse('2026-05-05T19:28:00.000Z'),
        },
      ],
      { generatedAt: 'now' },
    );

    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      'numeric-new',
      'numeric-middle',
      'iso-old',
      'numeric-oldest',
    ]);
  });

  it('falls back to the raw session key when label lookup returns empty', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [{ key: 'agent:main:discord:channel:t1', sessionId: 's1' }],
      { generatedAt: 'now', resolveDisplayLabel: async () => '   ' },
    );

    expect(snapshot.sessions[0].displayLabel).toBe('agent:main:discord:channel:t1');
  });

  it('parses Discord channel-info names from supported JSON shapes', () => {
    expect(extractDiscordChannelName(JSON.stringify({ payload: { thread: { name: 'thread name' }, channel: { name: 'parent name' } } }))).toBe('thread name');
    expect(extractDiscordChannelName(JSON.stringify({ payload: { channel: { name: 'channel name' } } }))).toBe('channel name');
    expect(extractDiscordChannelName(JSON.stringify({ channel: { name: 'parent name' } }))).toBe('parent name');
  });

  it('parses session-key agent/channel/target details', () => {
    expect(parseOpenClawSessionKey('agent:kamaji:discord:channel:123')).toEqual({
      agent: 'kamaji',
      channel: 'discord',
      target: 'channel:123',
    });
  });
});

describe('recent sessions cache', () => {
  it('serves cached state inside the ttl and refreshes after expiry', async () => {
    let now = 1_000;
    const loadSessions = vi
      .fn()
      .mockResolvedValueOnce({ generatedAt: 'first', sessions: [] })
      .mockResolvedValueOnce({ generatedAt: 'second', sessions: [] });
    const cache = createRecentSessionsCache({ ttlMs: 60_000, now: () => now, loadSessions });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'first' });
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'first' });
    now += 60_001;
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'second' });
    expect(loadSessions).toHaveBeenCalledTimes(2);
  });
});
