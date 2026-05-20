import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMocks.execFile,
}));
import {
  buildFallbackDisplayLabel,
  buildRecentSessionsFromRows,
  createRecentSessionsCache,
  extractDiscordChannelName,
  extractDiscordMemberName,
  getRecentSessionsWithOpenClaw,
  parseOpenClawSessionKey,
  resolveDiscordChannelLabel,
  resolveDiscordDirectLabel,
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

  it('parses Discord direct session keys as user targets with DM fallback labels', async () => {
    const userId = '367727560869675018';
    const snapshot = await buildRecentSessionsFromRows(
      [
        {
          key: `agent:spec:discord:direct:${userId}`,
          sessionId: 'dm-session',
          updatedAt: '2026-05-05T19:26:00.000Z',
        },
      ],
      { generatedAt: 'now' },
    );

    expect(snapshot.sessions[0]).toMatchObject({
      agent: 'spec',
      channel: 'discord',
      target: `user:${userId}`,
      displayLabel: `DM ${userId}`,
    });
  });

  it('resolves Discord DM labels through member info username lookup', async () => {
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
                key: 'agent:spec:discord:direct:367727560869675018',
                sessionId: 'dm-session',
                updatedAt: '2026-05-05T19:26:00.000Z',
              },
            ],
          }),
          '',
        );
        return {};
      }
      if (args[0] === 'message' && args[1] === 'member' && args[2] === 'info') {
        callback(null, JSON.stringify({ payload: { user: { username: 'foxbarrington' }, member: { nick: 'Fox' } } }), '');
        return {};
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions[0]).toMatchObject({
      target: 'user:367727560869675018',
      displayLabel: 'DM foxbarrington',
    });
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      ['message', 'member', 'info', '--channel', 'discord', '--user-id', '367727560869675018', '--json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
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

  it('enriches recent sessions with one batched sessions.preview Gateway call', async () => {
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
                key: 'agent:alpha:main',
                sessionId: 'alpha-session',
                updatedAt: '2026-05-05T19:26:00.000Z',
              },
              {
                key: 'agent:beta:main',
                sessionId: 'beta-session',
                updatedAt: '2026-05-05T19:25:00.000Z',
              },
            ],
          }),
          '',
        );
        return {};
      }
      if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.preview') {
        const params = JSON.parse(args[args.indexOf('--params') + 1] ?? '{}');
        expect(params).toEqual({ keys: ['agent:alpha:main', 'agent:beta:main'] });
        callback(
          null,
          JSON.stringify({
            previews: [
              {
                key: 'agent:alpha:main',
                status: 'ok',
                items: [
                  { role: 'user', text: 'Can you make the dashboard feel hydrated?' },
                  { role: 'assistant', text: 'Added the hydrated session preview line.' },
                ],
              },
              {
                key: 'agent:beta:main',
                status: 'ok',
                items: [
                  { role: 'user', text: 'Only the latest user note is available.' },
                ],
              },
            ],
          }),
          '',
        );
        return {};
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions).toMatchObject([
      {
        sessionKey: 'agent:alpha:main',
        lastMessageRole: 'assistant',
        lastMessagePreview: 'Added the hydrated session preview line.',
        lastAssistantPreview: 'Added the hydrated session preview line.',
      },
      {
        sessionKey: 'agent:beta:main',
        lastMessageRole: 'user',
        lastMessagePreview: 'Only the latest user note is available.',
      },
    ]);
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
  });

  it('keeps recent sessions usable when sessions.preview lookup fails', async () => {
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
                key: 'agent:alpha:main',
                sessionId: 'alpha-session',
                updatedAt: '2026-05-05T19:26:00.000Z',
              },
            ],
          }),
          '',
        );
        return {};
      }
      if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.preview') {
        callback(new Error('gateway unavailable'), '', '');
        return {};
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const snapshot = await getRecentSessionsWithOpenClaw();

    expect(snapshot.sessions[0]).not.toHaveProperty('lastMessagePreview');
    expect(snapshot.sessions[0]).not.toHaveProperty('lastAssistantPreview');
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

  it('falls back to prefix-stripped session labels when generic label lookup is unavailable or has no target', async () => {
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
      'room one',
      'webchat',
    ]);
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(3);
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

  it('falls back to the prefix-stripped session label when label lookup returns empty', async () => {
    const snapshot = await buildRecentSessionsFromRows(
      [{ key: 'agent:main:discord:channel:t1', sessionId: 's1' }],
      { generatedAt: 'now', resolveDisplayLabel: async () => '   ' },
    );

    expect(snapshot.sessions[0].displayLabel).toBe('channel t1');
  });

  it('extracts Discord member usernames before global names and nicknames', () => {
    expect(
      extractDiscordMemberName(
        JSON.stringify({ payload: { user: { username: 'foxbarrington', global_name: 'Fox Global' }, member: { nick: 'Fox Nick' } } }),
      ),
    ).toBe('foxbarrington');
    expect(extractDiscordMemberName(JSON.stringify({ user: { global_name: 'Fox Global' }, member: { nick: 'Fox Nick' } }))).toBe('Fox Global');
    expect(extractDiscordMemberName(JSON.stringify({ member: { nick: 'Fox Nick' } }))).toBe('Fox Nick');
  });

  it('resolves direct Discord labels to DM names and gracefully falls back on lookup failure', async () => {
    childProcessMocks.execFile.mockImplementationOnce((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, JSON.stringify({ user: { username: 'foxbarrington' } }), '');
      return {};
    });

    await expect(resolveDiscordDirectLabel('user:367727560869675018')).resolves.toBe('DM foxbarrington');
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'openclaw',
      ['message', 'member', 'info', '--channel', 'discord', '--user-id', '367727560869675018', '--json'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );

    childProcessMocks.execFile.mockImplementationOnce((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error('guild id required'), '', '');
      return {};
    });
    await expect(resolveDiscordDirectLabel('user:367727560869675018')).resolves.toBeUndefined();
  });

  it('builds prefix-stripped fallback labels for agent session keys', () => {
    expect(buildFallbackDisplayLabel('agent:spec:discord:direct:367727560869675018')).toBe('DM 367727560869675018');
    expect(buildFallbackDisplayLabel('agent:kamaji:discord:channel:1501301184101617886')).toBe('channel 1501301184101617886');
    expect(buildFallbackDisplayLabel('agent:kamaji:webchat:session:web-1')).toBe('session web-1');
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
    expect(parseOpenClawSessionKey('agent:spec:discord:direct:367727560869675018')).toEqual({
      agent: 'spec',
      channel: 'discord',
      target: 'user:367727560869675018',
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

  it('shares one in-flight refresh across concurrent cache misses', async () => {
    let resolveLoad!: (snapshot: { generatedAt: string; sessions: [] }) => void;
    const loadSessions = vi.fn(
      () => new Promise<{ generatedAt: string; sessions: [] }>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const cache = createRecentSessionsCache({ ttlMs: 60_000, now: () => 1_000, loadSessions });

    const first = cache.get();
    const second = cache.get();

    expect(loadSessions).toHaveBeenCalledTimes(1);
    resolveLoad({ generatedAt: 'loaded', sessions: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { generatedAt: 'loaded', sessions: [] },
      { generatedAt: 'loaded', sessions: [] },
    ]);
  });

  it('can start the first refresh immediately and lets get await that refresh', async () => {
    let resolveLoad!: (snapshot: { generatedAt: string; sessions: [] }) => void;
    const loadSessions = vi.fn(
      () => new Promise<{ generatedAt: string; sessions: [] }>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const cache = createRecentSessionsCache({
      ttlMs: 60_000,
      now: () => 1_000,
      loadSessions,
      refreshOnCreate: true,
    });
    const pendingGet = cache.get();

    expect(loadSessions).toHaveBeenCalledTimes(1);
    resolveLoad({ generatedAt: 'boot-refresh', sessions: [] });
    await expect(pendingGet).resolves.toEqual({ generatedAt: 'boot-refresh', sessions: [] });
  });
});
