import { describe, expect, it } from 'vitest';
import {
  compareSessionRowsByLastActivityDesc,
  deriveRouteFromSessionKey,
  parseDiscordChannelLabel,
  RecentSessionsCache,
  sessionRowToEntry,
} from '../daemon/src/recentSessions';

describe('recent sessions', () => {
  it('derives Discord channel targets from OpenClaw session keys', () => {
    expect(deriveRouteFromSessionKey('agent:main:discord:channel:1501247836103245874')).toEqual({
      channel: 'discord',
      target: 'channel:1501247836103245874',
    });
    expect(deriveRouteFromSessionKey('agent:kamaji:subagent:abc')).toEqual({});
  });

  it('reads Discord thread/channel names from channel-info output', () => {
    expect(parseDiscordChannelLabel(JSON.stringify({
      payload: { channel: { id: '1', type: 11, name: 'Switch to Voice' } },
    }))).toBe('Switch to Voice');
  });

  it('keeps a capped cached snapshot', async () => {
    const cache = new RecentSessionsCache({
      autoStart: false,
      limit: 2,
      loadSessions: async () => [
        { id: '1', sessionId: '1', label: 'One' },
        { id: '2', sessionId: '2', label: 'Two' },
        { id: '3', sessionId: '3', label: 'Three' },
      ],
    });
    await cache.refresh();
    expect(cache.getSnapshot().sessions.map((session) => session.label)).toEqual(['One', 'Two']);
  });

  it('builds session entries with route metadata and fallback labels', async () => {
    const entry = await sessionRowToEntry({
      key: 'agent:main:discord:channel:123',
      sessionId: 'session-uuid',
      agentId: 'main',
      kind: 'group',
      updatedAt: 1778000000000,
    }, async () => undefined);
    expect(entry).toMatchObject({
      id: 'session-uuid',
      sessionId: 'session-uuid',
      sessionKey: 'agent:main:discord:channel:123',
      channel: 'discord',
      target: 'channel:123',
      agentId: 'main',
      kind: 'group',
      lastActivity: '2026-05-05T16:53:20.000Z',
    });
    expect(entry?.label).toContain('discord');
  });

  it('sorts mixed numeric and ISO activity timestamps newest first', () => {
    const rows = [
      { sessionId: 'iso-older', updatedAt: '2026-05-05T16:53:20.000Z' },
      { sessionId: 'numeric-newer', updatedAt: 1778000001000 },
      { sessionId: 'activity-mid', lastActivity: 1778000000500 },
      { sessionId: 'activity-at-newest', lastActivityAt: 1778000002000 },
    ];

    expect(rows.sort(compareSessionRowsByLastActivityDesc).map((row) => row.sessionId)).toEqual([
      'activity-at-newest',
      'numeric-newer',
      'activity-mid',
      'iso-older',
    ]);
  });

  it('normalizes numeric lastActivity and lastActivityAt values to ISO strings', async () => {
    await expect(sessionRowToEntry({
      sessionId: 'session-1',
      lastActivity: 1778000000500,
    }, async () => undefined)).resolves.toMatchObject({
      lastActivity: '2026-05-05T16:53:20.500Z',
    });

    await expect(sessionRowToEntry({
      sessionId: 'session-2',
      lastActivityAt: 1778000002000,
    }, async () => undefined)).resolves.toMatchObject({
      lastActivity: '2026-05-05T16:53:22.000Z',
    });
  });
});
