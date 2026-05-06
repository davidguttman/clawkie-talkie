import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMocks.execFile,
}));
import {
  buildRecentSessionsFromRows,
  createRecentSessionsCache,
  extractDiscordChannelName,
  getRecentSessionsWithOpenClaw,
  parseOpenClawSessionKey,
  resolveDiscordChannelLabel,
} from '../daemon/src/recentSessions';

beforeEach(() => {
  childProcessMocks.execFile.mockReset();
});

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

  it('resolves display labels concurrently while preserving sorted session order', async () => {
    const rows = [
      {
        key: 'agent:main:discord:channel:first',
        sessionId: 'first-session',
        updatedAt: '2026-05-05T19:03:00.000Z',
      },
      {
        key: 'agent:main:discord:channel:second',
        sessionId: 'second-session',
        updatedAt: '2026-05-05T19:02:00.000Z',
      },
      {
        key: 'agent:main:discord:channel:third',
        sessionId: 'third-session',
        updatedAt: '2026-05-05T19:01:00.000Z',
      },
    ];
    const resolvers: Array<(value: string) => void> = [];
    const calls: string[] = [];

    const pending = buildRecentSessionsFromRows(rows, {
      generatedAt: 'now',
      resolveDisplayLabel: (session) => {
        calls.push(session.sessionId);
        return new Promise<string>((resolve) => {
          resolvers.push(resolve);
        });
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(['first-session', 'second-session', 'third-session']);
    expect(resolvers).toHaveLength(3);

    resolvers[2]('Third label');
    resolvers[0]('First label');
    resolvers[1]('Second label');

    await expect(pending).resolves.toMatchObject({
      sessions: [
        { sessionId: 'first-session', displayLabel: 'First label' },
        { sessionId: 'second-session', displayLabel: 'Second label' },
        { sessionId: 'third-session', displayLabel: 'Third label' },
      ],
    });
  });

  it('runs OpenClaw session and Discord label lookups with argv, not shell strings', async () => {
    const dangerousTarget = 'channel:abc$(touch /tmp/clawkie-pwned)"; echo owned #';
    childProcessMocks.execFile.mockImplementation((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file !== 'openclaw') throw new Error(`unexpected command: ${file}`);
      if (args[0] === 'sessions') {
        callback(
          null,
          JSON.stringify({
            sessions: [
              {
                key: 'agent:kamaji:discord:channel:dangerous',
                sessionId: 'dangerous-session',
                agentId: 'kamaji',
                channel: 'discord',
                target: dangerousTarget,
                accountId: 'acct-1',
                updatedAt: '2026-05-05T19:26:00.000Z',
              },
            ],
          }),
          '',
        );
        return {};
      }
      if (args[0] === 'message') {
        callback(null, JSON.stringify({ payload: { channel: { name: 'danger label' } } }), '');
        return {};
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: 'dangerous-session',
      target: dangerousTarget,
      accountId: 'acct-1',
      displayLabel: 'danger label',
    });
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      1,
      'openclaw',
      ['sessions', '--json', '--all-agents', '--active', '10080', '--limit', '30'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      ['message', 'channel', 'info', '--channel', 'discord', '--target', dangerousTarget, '--json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('returns undefined for failed Discord label lookups without shelling through dangerous targets', async () => {
    const dangerousTarget = 'channel:$(printf exploited)';
    childProcessMocks.execFile.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error('lookup failed'), '', '');
      return {};
    });

    await expect(resolveDiscordChannelLabel(dangerousTarget)).resolves.toBeUndefined();
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'openclaw',
      ['message', 'channel', 'info', '--channel', 'discord', '--target', dangerousTarget, '--json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('uses generic OpenClaw channel-info lookups for non-Discord session labels', async () => {
    childProcessMocks.execFile.mockImplementation((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file !== 'openclaw') throw new Error(`unexpected command: ${file}`);
      if (args[0] === 'sessions') {
        callback(
          null,
          JSON.stringify({
            sessions: [
              {
                key: 'agent:kamaji:signal:chat:alice',
                sessionId: 'signal-session',
                updatedAt: '2026-05-05T19:26:00.000Z',
              },
            ],
          }),
          '',
        );
        return {};
      }
      if (args[0] === 'message') {
        callback(null, JSON.stringify({ payload: { channel: { name: 'Alice on Signal' } } }), '');
        return {};
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: 'signal-session',
      channel: 'signal',
      target: 'chat:alice',
      displayLabel: 'Alice on Signal',
    });
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      ['message', 'channel', 'info', '--channel', 'signal', '--target', 'chat:alice', '--json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('falls back to raw session keys when generic label lookup is unavailable or has no target', async () => {
    childProcessMocks.execFile.mockImplementation((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file !== 'openclaw') throw new Error(`unexpected command: ${file}`);
      if (args[0] === 'sessions') {
        callback(
          null,
          JSON.stringify({
            sessions: [
              {
                key: 'agent:kamaji:unsupported:room:one',
                sessionId: 'unsupported-session',
                updatedAt: '2026-05-05T19:27:00.000Z',
              },
              {
                key: 'agent:kamaji:webchat',
                sessionId: 'no-target-session',
                updatedAt: '2026-05-05T19:26:00.000Z',
              },
            ],
          }),
          '',
        );
        return {};
      }
      callback(new Error(`unsupported channel: ${args[4]}`), '', '');
      return {};
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions.map((session) => session.displayLabel)).toEqual([
      'agent:kamaji:unsupported:room:one',
      'agent:kamaji:webchat',
    ]);
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      ['message', 'channel', 'info', '--channel', 'unsupported', '--target', 'room:one', '--json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
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

  it('oversamples OpenClaw sessions so filtered top rows do not reduce the final 10-session cap', async () => {
    const validRows = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:discord:channel:valid-${index}`,
      sessionId: `valid-${index}`,
      updatedAt: `2026-05-05T19:${String(50 - index).padStart(2, '0')}:00.000Z`,
    }));

    childProcessMocks.execFile.mockImplementation((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file !== 'openclaw') throw new Error(`unexpected command: ${file}`);
      if (args[0] === 'sessions') {
        callback(
          null,
          JSON.stringify({
            sessions: [
              {
                key: 'agent:main:cron:f51c6f38-6081-487c-b880-75fdfe0f891d',
                sessionId: 'cron-newest',
                updatedAt: '2026-05-05T19:59:00.000Z',
              },
              {
                key: 'agent:main:subagent:3f6b8b82-8c94-4c80-83fd-2dfe395050e8',
                sessionId: 'subagent-newer',
                updatedAt: '2026-05-05T19:58:00.000Z',
              },
              {
                key: 'opaque-cron-channel-row',
                sessionId: 'cron-channel-new',
                channel: 'cron',
                updatedAt: '2026-05-05T19:57:00.000Z',
              },
              ...validRows,
            ],
          }),
          '',
        );
        return {};
      }
      callback(new Error('label lookup unavailable'), '', '');
      return {};
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions).toHaveLength(10);
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(validRows.map((row) => row.sessionId));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      1,
      'openclaw',
      ['sessions', '--json', '--all-agents', '--active', '10080', '--limit', '30'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('excludes sub-agent sessions while keeping user-facing group, webchat, and Discord sessions', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: 'agent:kamaji:subagent:3f6b8b82-8c94-4c80-83fd-2dfe395050e8',
          sessionId: 'subagent-from-key',
          updatedAt: '2026-05-05T19:33:00.000Z',
        },
        {
          key: 'agent:kamaji:discord:channel:1501301184101617886',
          sessionId: 'discord-session',
          updatedAt: '2026-05-05T19:32:00.000Z',
        },
        {
          key: 'agent:kamaji:webchat:session:web-1',
          sessionId: 'webchat-session',
          updatedAt: '2026-05-05T19:31:00.000Z',
        },
        {
          key: 'agent:kamaji:group:room:group-1',
          sessionId: 'group-session',
          updatedAt: '2026-05-05T19:30:00.000Z',
        },
        {
          key: 'opaque-subagent-row',
          sessionId: 'subagent-from-kind',
          kind: 'subagent',
          updatedAt: '2026-05-05T19:34:00.000Z',
        },
      ],
      { generatedAt: 'now' },
    );

    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      'discord-session',
      'webchat-session',
      'group-session',
    ]);
  });

  it('excludes cron sessions while keeping user-facing group, webchat, and Discord sessions', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: 'agent:kamaji:cron:f51c6f38-6081-487c-b880-75fdfe0f891d',
          sessionId: 'cron-from-key',
          updatedAt: '2026-05-05T19:36:00.000Z',
        },
        {
          key: 'opaque-cron-kind-row',
          sessionId: 'cron-from-kind',
          kind: 'cron',
          updatedAt: '2026-05-05T19:35:00.000Z',
        },
        {
          key: 'opaque-cron-channel-row',
          sessionId: 'cron-from-channel',
          channel: 'cron',
          updatedAt: '2026-05-05T19:34:00.000Z',
        },
        {
          key: 'agent:kamaji:discord:channel:1501301184101617886',
          sessionId: 'discord-session',
          updatedAt: '2026-05-05T19:33:00.000Z',
        },
        {
          key: 'agent:kamaji:webchat:session:web-1',
          sessionId: 'webchat-session',
          updatedAt: '2026-05-05T19:32:00.000Z',
        },
        {
          key: 'agent:kamaji:group:room:group-1',
          sessionId: 'group-session',
          updatedAt: '2026-05-05T19:31:00.000Z',
        },
      ],
      { generatedAt: 'now' },
    );

    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      'discord-session',
      'webchat-session',
      'group-session',
    ]);
  });

  it('preserves accountId from OpenClaw rows for reconnect routing', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: 'agent:kamaji:discord:channel:1501301184101617886',
          sessionId: 'uuid-1',
          updatedAt: '2026-05-05T19:26:00.000Z',
          accountId: 'discord-account-1',
        },
      ],
      { generatedAt: 'now' },
    );

    expect(snapshot.sessions[0].accountId).toBe('discord-account-1');
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
