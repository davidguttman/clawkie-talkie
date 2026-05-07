import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { execMock, execFileInvocations } = vi.hoisted(() => {
  const invocations: Array<{ file: string; args: string[]; opts?: unknown }> = [];
  const fn = vi.fn();
  const formatCommand = (file: string, args: string[]) => [file, ...args.map((arg) => JSON.stringify(arg))].join(' ');
  Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[] = [], opts?: unknown) => {
      invocations.push({ file, args, opts });
      return Promise.resolve(fn(formatCommand(file, args), opts, file, args));
    },
  });
  return { execMock: fn, execFileInvocations: invocations };
});

vi.mock('node:child_process', () => ({ execFile: execMock }));

import {
  buildAgentTurnMessage,
  ChatError,
  classifyOpenClawError,
  deriveDiscordMessageTarget,
  quoteTranscript,
  resolveOpenClawAgentSessionId,
  runChat,
} from '../daemon/src/chatSession';

function jsonAgentStdout(text: string, mediaUrls: string[] = []): string {
  return JSON.stringify({
    runId: 'run-1',
    status: 'ok',
    result: {
      payloads: [{ text, mediaUrls }],
    },
  }) + '\n';
}


const OPENCLAW_ENV_KEYS = ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'HOME', 'USERPROFILE'] as const;
const ORIGINAL_OPENCLAW_ENV = Object.fromEntries(OPENCLAW_ENV_KEYS.map((key) => [key, process.env[key]]));

async function writeOpenClawSessionStore(
  stateDir: string,
  agent: string,
  sessions: Record<string, { sessionId: string }>,
) {
  const sessionsDir = join(stateDir, 'agents', agent, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, 'sessions.json'), JSON.stringify(sessions, null, 2));
}

async function withOpenClawSessionStore(
  agent: string,
  sessions: Record<string, { sessionId: string }>,
  fn: () => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'clawkie-openclaw-state-'));
  await writeOpenClawSessionStore(root, agent, sessions);
  process.env.OPENCLAW_STATE_DIR = root;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_HOME;
  try {
    await fn();
  } finally {
    restoreOpenClawEnv();
    await rm(root, { recursive: true, force: true });
  }
}

function restoreOpenClawEnv() {
  for (const key of OPENCLAW_ENV_KEYS) {
    const value = ORIGINAL_OPENCLAW_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreOpenClawEnv();
  execFileInvocations.length = 0;
});

function mockExecRoutingAgentTo(stdoutForAgent: string) {
  execMock.mockImplementation((cmd) => {
    const command = String(cmd);
    if (command.includes('openclaw "agent"')) {
      return Promise.resolve({ stdout: stdoutForAgent, stderr: '' });
    }
    return Promise.resolve({ stdout: 'ok\n', stderr: '' });
  });
}

describe('runChat OpenClaw CLI integration', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('passes --json to openclaw agent and parses reply text from JSON payloads, ignoring stdout diagnostic noise', async () => {
    // Simulates the bug report: openclaw printed ANSI/auth-profile diagnostic
    // logs to stdout followed by the actual reply. With --json those logs go
    // to stderr and stdout is a pure JSON response object — and the daemon
    // must parse the JSON payload rather than returning raw stdout.
    const ansiNoise =
      '[2m[agents/auth-profiles][0m kept local oauth over external cli bootstrap-only provider\n';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({
          stdout: jsonAgentStdout('Testing one two three received. Clean and clear.'),
          stderr: ansiNoise,
        });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    const result = await runChat('hi', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--json"');
    expect(result.text).toBe('Testing one two three received. Clean and clear.');
    expect(result.text).not.toContain('auth-profiles');
    expect(result.text).not.toContain('[');
  });

  it('throws a structured error when openclaw agent stdout is not valid JSON, instead of leaking diagnostics', async () => {
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({
          stdout: '[agents/auth-profiles] noise\nnot valid json at all\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await expect(
      runChat('hi', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'openclaw_reply_unparseable' });
  });

  it('accepts top-level { payloads } JSON shape from the openclaw embedded fallback path', async () => {
    // When the gateway call fails, the openclaw CLI runs the agent locally
    // and emits the embedded run result directly — `{ payloads, meta }` —
    // rather than the gateway-shaped `{ result: { payloads } }`.
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            payloads: [{ text: 'fallback reply' }],
            meta: { transport: 'embedded', fallbackFrom: 'gateway' },
          }) + '\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    const result = await runChat('hi', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    expect(result).toEqual({ text: 'fallback reply', source: 'openclaw' });
  });

  it('posts the final transcript as a Discord quote before running the agent', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));

    await runChat('Hello\nworld', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const transcriptCommand = String(execMock.mock.calls[0]?.[0]);
    expect(transcriptCommand).toContain('openclaw "message" "send"');
    expect(transcriptCommand).toContain('"--channel" "discord"');
    expect(transcriptCommand).toContain('"--target" "channel:thread-1"');
    expect(transcriptCommand).toContain(
      `"--message" ${JSON.stringify('> Hello\n> world')}`,
    );

    const agentCallIndex = execMock.mock.calls.findIndex(([cmd]) =>
      String(cmd).includes('openclaw "agent"'),
    );
    expect(agentCallIndex).toBeGreaterThan(0);
  });

  it('passes transcript shell-substitution syntax as a literal execFile argv value', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));
    const dangerousTranscript = 'hello $(touch /tmp/clawkie-pwned) and `whoami`';

    await runChat(dangerousTranscript, {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const transcriptCall = findOpenClawExecFileInvocation('message', 'send');
    expect(transcriptCall.file).toBe('openclaw');
    expect(transcriptCall.args).toEqual([
      'message', 'send',
      '--channel', 'discord',
      '--target', 'channel:thread-1',
      '--message', `> ${dangerousTranscript}`,
    ]);
    expect(execFileInvocations.every((call) => call.file === 'openclaw' && Array.isArray(call.args))).toBe(true);
  });

  it('passes delivery metadata shell-substitution syntax as literal execFile argv values', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));
    const dangerousTarget = 'channel:$(touch /tmp/clawkie-target-pwned)`id`';
    const dangerousAccount = 'acct-$(touch /tmp/clawkie-account-pwned)`whoami`';

    await runChat('hello from metadata route', {
      sessionId: 'session-1',
      delivery: {
        channel: 'discord',
        target: dangerousTarget,
        accountId: dangerousAccount,
      },
    });

    const transcriptCall = findOpenClawExecFileInvocation('message', 'send');
    expect(transcriptCall.file).toBe('openclaw');
    expect(transcriptCall.args).toEqual([
      'message', 'send',
      '--channel', 'discord',
      '--target', dangerousTarget,
      '--account', dangerousAccount,
      '--message', '> hello from metadata route',
    ]);
    expect(execFileInvocations.every((call) => call.file === 'openclaw' && Array.isArray(call.args))).toBe(true);
  });

  it('posts transcripts to the Discord target derived from the session key when threadId is absent', async () => {
    await withOpenClawSessionStore('main', {
      'agent:main:discord:channel-1:thread-2': { sessionId: '019e0000-0000-7000-8000-000000000005' },
    }, async () => {
      execMock
        .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: jsonAgentStdout('reply'), stderr: '' });

      await runChat('from session route', {
        sessionId: 'agent:main:discord:channel-1:thread-2',
        deliver: true,
      });

      const transcriptCommand = String(execMock.mock.calls[0]?.[0]);
      expect(transcriptCommand).toContain('openclaw "message" "send"');
      expect(transcriptCommand).toContain('"--target" "channel:thread-2"');
      expect(transcriptCommand).toContain(
        `"--message" ${JSON.stringify('> from session route')}`,
      );
      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(false);
    });
  });

  it('best-effort posts transcripts to explicit handoff channel/target/accountId without changing agent session identity', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from explicit target', {
      sessionId,
      sessionKey: 'agent:main:discord:channel:thread-from-session-key',
      channel: 'discord',
      target: 'channel:explicit-thread',
      accountId: 'acct-1',
      deliver: true,
    });

    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(false);

    const transcriptCommand = String(
      execMock.mock.calls.find(([cmd]) => String(cmd).includes('openclaw "message" "send"'))?.[0],
    );
    expect(transcriptCommand).toContain('"--channel" "discord"');
    expect(transcriptCommand).toContain('"--target" "channel:explicit-thread"');
    expect(transcriptCommand).toContain('"--account" "acct-1"');
    expect(transcriptCommand).toContain(`"--message" ${JSON.stringify('> from explicit target')}`);

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain(`"--session-id" "${sessionId}"`);
  });

  it('delivers voice replies with the agent from sessionKey and explicit handoff reply target metadata', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from kamaji explicit target', {
      sessionId,
      sessionKey: 'agent:kamaji:discord:channel:1501983803436961932',
      channel: 'discord',
      target: 'channel:1501983803436961932',
      deliver: true,
    });

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--agent', 'kamaji',
      '--session-id', sessionId,
      '--deliver',
      '--reply-channel', 'discord',
      '--reply-to', 'channel:1501983803436961932',
    ]));
    expect(agentCall.args).not.toContain('main');
    expect(agentCall.args).not.toContain('--channel');
    expect(agentCall.args).not.toContain('last');
  });

  it('delivers voice replies with the agent from sessionKey and nested delivery metadata', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from kamaji delivery target', {
      sessionId,
      sessionKey: 'agent:kamaji:discord:channel:1501983803436961932',
      delivery: { channel: 'discord', target: 'channel:1501983803436961932' },
      deliver: true,
    });

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--agent', 'kamaji',
      '--session-id', sessionId,
      '--deliver',
      '--reply-channel', 'discord',
      '--reply-to', 'channel:1501983803436961932',
    ]));
    expect(agentCall.args).not.toContain('--channel');
    expect(agentCall.args).not.toContain('last');
  });

  it('fails loudly when mandatory voice reply delivery metadata is missing', async () => {
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await expect(
      runChat('hello without route', {
        sessionId: 'session-1',
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'openclaw_delivery_unresolved' });

    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "agent"'))).toBe(false);
  });

  it('best-effort posts transcripts from sessionKey while keeping UUID as the agent session identity', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from session key route', {
      sessionId,
      sessionKey: 'agent:main:discord:channel:thread-from-session-key',
      deliver: true,
    });

    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(false);

    const transcriptCommand = String(
      execMock.mock.calls.find(([cmd]) => String(cmd).includes('openclaw "message" "send"'))?.[0],
    );
    expect(transcriptCommand).toContain('"--target" "channel:thread-from-session-key"');
    expect(transcriptCommand).toContain(`"--message" ${JSON.stringify('> from session key route')}`);

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain(`"--session-id" "${sessionId}"`);
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"--reply-channel" "discord"');
    expect(agentCommand).toContain('"--reply-to" "channel:thread-from-session-key"');
    expect(agentCommand).not.toContain('"--channel" "last"');
  });

  it('best-effort posts transcripts for UUID session ids by reverse-resolving the OpenClaw session key when sessionKey is missing', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "sessions"')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId,
                key: 'agent:main:discord:channel:thread-from-session-list',
              },
            ],
          }),
          stderr: '',
        });
      }
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from uuid route', {
      sessionId,
      deliver: true,
    });

    await vi.waitFor(() =>
      expect(
        execMock.mock.calls.some(([cmd]) =>
          String(cmd).includes('openclaw "message" "send"') &&
          String(cmd).includes('"--target" "channel:thread-from-session-list"'),
        ),
      ).toBe(true),
    );

    const sessionsCommand = String(execMock.mock.calls.find(([cmd]) => String(cmd).includes('openclaw "sessions"'))?.[0]);
    expect(sessionsCommand).toContain('openclaw "sessions" "--json" "--all-agents" "--active" "10080"');

    const transcriptCommand = String(
      execMock.mock.calls.find(([cmd]) => String(cmd).includes('openclaw "message" "send"'))?.[0],
    );
    expect(transcriptCommand).toContain(`"--message" ${JSON.stringify('> from uuid route')}`);

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain(`"--session-id" "${sessionId}"`);
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"--reply-channel" "discord"');
    expect(agentCommand).toContain('"--reply-to" "channel:thread-from-session-list"');
    expect(agentCommand).not.toContain('"--channel" "last"');
  });

  it('uses the agent from a reverse-resolved UUID session key for mandatory reply delivery', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "sessions"')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId,
                key: 'agent:kamaji:discord:channel:thread-from-session-list',
              },
            ],
          }),
          stderr: '',
        });
      }
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from uuid kamaji route', {
      sessionId,
      deliver: true,
    });

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--agent', 'kamaji',
      '--session-id', sessionId,
      '--deliver',
      '--reply-channel', 'discord',
      '--reply-to', 'channel:thread-from-session-list',
    ]));
    expect(agentCall.args).not.toContain('--channel');
    expect(agentCall.args).not.toContain('last');
  });

  it('reverse-resolves UUID sessions from { id, sessionKey } rows', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "sessions"')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            sessions: [
              {
                id: sessionId,
                sessionKey: 'agent:kamaji:discord:channel:thread-from-id-session-key',
              },
            ],
          }),
          stderr: '',
        });
      }
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from id/sessionKey route', {
      sessionId,
      deliver: true,
    });

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--agent', 'kamaji',
      '--session-id', sessionId,
      '--deliver',
      '--reply-channel', 'discord',
      '--reply-to', 'channel:thread-from-id-session-key',
    ]));
  });

  it('routes Discord thread session keys to channel targets', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from thread session key', {
      sessionId,
      sessionKey: 'agent:main:discord:thread:5555555555',
      deliver: true,
    });

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--reply-channel', 'discord',
      '--reply-to', 'channel:5555555555',
    ]));
  });

  it('routes Discord direct session keys to user targets, not channel targets', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from direct session key', {
      sessionId,
      sessionKey: 'agent:main:discord:direct:1234567890',
      deliver: true,
    });

    const transcriptCall = findOpenClawExecFileInvocation('message', 'send');
    expect(transcriptCall.args).toEqual(expect.arrayContaining([
      '--channel', 'discord',
      '--target', 'user:1234567890',
    ]));
    expect(transcriptCall.args).not.toContain('channel:1234567890');

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--reply-channel', 'discord',
      '--reply-to', 'user:1234567890',
    ]));
    expect(agentCall.args).not.toContain('channel:1234567890');
  });

  it('routes Discord user session keys to user targets, not channel targets', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"')) {
        return Promise.resolve({ stdout: 'transcript posted\n', stderr: '' });
      }
      if (command.includes('openclaw "agent"')) {
        return Promise.resolve({ stdout: jsonAgentStdout('reply'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    await runChat('from user session key', {
      sessionId,
      sessionKey: 'agent:main:discord:user:9876543210',
      deliver: true,
    });

    const agentCall = findOpenClawExecFileInvocation('agent');
    expect(agentCall.args).toEqual(expect.arrayContaining([
      '--reply-channel', 'discord',
      '--reply-to', 'user:9876543210',
    ]));
    expect(agentCall.args).not.toContain('channel:9876543210');
  });

  it('classifies mandatory UUID delivery lookup failures instead of masking them as unresolved routes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      execMock.mockImplementation((cmd) => {
        const command = String(cmd);
        if (command.includes('openclaw "sessions"')) {
          return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18789'), {
            stderr: 'connect ECONNREFUSED 127.0.0.1:18789',
          }));
        }
        if (command.includes('openclaw "agent"')) {
          return Promise.resolve({ stdout: jsonAgentStdout('reply despite lookup failure'), stderr: '' });
        }
        return Promise.resolve({ stdout: 'ok\n', stderr: '' });
      });

      await expect(
        runChat('hi', {
          sessionId: 'c44d9502-ce71-46b1-9b15-5d548004544a',
          deliver: true,
        }),
      ).rejects.toMatchObject({ code: 'openclaw_gateway_unavailable' });

      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "message" "send"'))).toBe(false);
      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "agent"'))).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('targets the Discord reply thread when threadId is provided', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));

    await expect(
      runChat('hello', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        deliver: true,
      }),
    ).resolves.toEqual({ text: 'ok', source: 'openclaw' });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--session-id" "session-1"');
  });

  it('runs agent turns through explicit OpenClaw reply target delivery', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));

    await runChat('hello', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--agent" "main"');
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"--reply-channel" "discord"');
    expect(agentCommand).toContain('"--reply-to" "channel:thread-1"');
    expect(agentCommand).toContain('"-m"');
    expect(agentCommand).not.toContain('"--channel" "last"');
  });

  it('starts the agent turn without waiting for transcript posting to finish', async () => {
    let transcriptPending = false;
    let agentStartedWhileTranscriptPending = false;
    let resolveTranscript: ((value: { stdout: string; stderr: string }) => void) | undefined;

    execMock.mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes('openclaw "message" "send"') && command.includes('> hi')) {
        transcriptPending = true;
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          resolveTranscript = (value) => {
            transcriptPending = false;
            resolve(value);
          };
        });
      }
      if (command.includes('openclaw "agent"')) {
        agentStartedWhileTranscriptPending = transcriptPending;
        return Promise.resolve({ stdout: jsonAgentStdout('hello back'), stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    const resultPromise = runChat('hi', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    await vi.waitFor(() => expect(findAgentCommand()).toContain('"--reply-to" "channel:thread-1"'));
    expect(agentStartedWhileTranscriptPending).toBe(true);
    await expect(resultPromise).resolves.toEqual({ text: 'hello back', source: 'openclaw' });

    resolveTranscript?.({ stdout: 'transcript posted\n', stderr: '' });
  });

  it('logs transcript post rejection without failing the voice turn when the agent succeeds', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      execMock.mockImplementation((cmd) => {
        const command = String(cmd);
        if (command.includes('openclaw "message" "send"') && command.includes('> hi')) {
          return Promise.reject(
            Object.assign(
              new Error('Command failed: openclaw "message" "send" "--message" "> hi" xai_api_key=secret'),
              { stderr: 'bad --message "> hi" authorization: bearer token' },
            ),
          );
        }
        if (command.includes('openclaw "agent"')) {
          return Promise.resolve({ stdout: jsonAgentStdout('hello back'), stderr: '' });
        }
        return Promise.resolve({ stdout: 'ok\n', stderr: '' });
      });

      await expect(
        runChat('hi', {
          sessionId: 'session-1',
          threadId: 'thread-1',
          deliver: true,
        }),
      ).resolves.toEqual({ text: 'hello back', source: 'openclaw' });

      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('transcript_post_failed')));
      const logLine = String(errorSpy.mock.calls.find(([line]) => String(line).includes('transcript_post_failed'))?.[0]);
      expect(logLine).not.toContain('> hi');
      expect(logLine).not.toContain('secret');
      expect(logLine).not.toContain('token');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('wraps the agent input with raw STT transcript guidance', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));

    await runChat('turn left at the next light', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"-m"');
    expect(agentCommand).toContain('raw speech-to-text transcript');
    expect(agentCommand).toContain('mistranscriptions');
    expect(agentCommand).toContain('infer the user');
    expect(agentCommand).toContain('<raw-stt-transcript>\\nturn left at the next light\\n</raw-stt-transcript>');
    expect(agentCommand).not.toContain('Preserve the existing OpenClaw session agent identity and personality');
    expect(agentCommand).not.toContain('one or two short spoken sentences');
  });

  it('does not post the agent reply text via openclaw message send (the agent does it)', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: jsonAgentStdout('hello back'), stderr: '' })
      .mockResolvedValueOnce({ stdout: 'ok\n', stderr: '' });

    const result = await runChat('hi', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    expect(result.text).toBe('hello back');

    const sendCommands = execMock.mock.calls
      .map(([cmd]) => String(cmd))
      .filter((cmd) => cmd.includes('openclaw "message" "send"'));
    // No `message send` should ever carry the agent reply text — the
    // Discord-bound agent session posts the reply itself, and posting
    // again here is what was producing the doubled message in Discord.
    const replyEchoes = sendCommands.filter((cmd) =>
      cmd.includes('"--message" "hello back"'),
    );
    expect(replyEchoes).toHaveLength(0);

    // Debug notifications must not embed reply text either.
    for (const cmd of sendCommands) {
      expect(cmd).not.toContain('hello back');
    }
  });

  it('fails UUID session turns when delivery target lookup finds no match', async () => {
    const sessionId = 'c44d9502-ce71-46b1-9b15-5d548004544a';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockExecRoutingAgentTo(jsonAgentStdout('plain reply'));

      await expect(runChat('hi', {
        sessionId,
        deliver: true,
      })).rejects.toMatchObject({ code: 'openclaw_delivery_unresolved' });

      const sendCommands = execMock.mock.calls
        .map(([cmd]) => String(cmd))
        .filter((cmd) => cmd.includes('openclaw "message" "send"'));
      expect(sendCommands).toHaveLength(0);
      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "agent"'))).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });


  it('returns spoken reply text from mixed JSON payloads (text + media) without surfacing media URLs', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('spoken reply', ['/tmp/openclaw/tts-test/voice.opus']));

    const result = await runChat('hi', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    expect(result.text).toBe('spoken reply');
  });

  it('surfaces media-only OpenClaw replies instead of sending MEDIA paths to TTS', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('', ['/tmp/openclaw/tts-test/voice.opus']));

    await expect(
      runChat('hi', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'openclaw_media_reply_unavailable' });
  });

  it('resolves Discord session keys to the stored OpenClaw UUID before agent delivery', async () => {
    await withOpenClawSessionStore('main', {
      'agent:main:discord:channel:thread-1': { sessionId: '019e0000-0000-7000-8000-000000000001' },
    }, async () => {
      execMock
        .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: jsonAgentStdout('reply'), stderr: '' });

      await runChat('hello', {
        sessionId: 'agent:main:discord:channel:thread-1',
        deliver: true,
      });

      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(false);
      const agentCommand = findAgentCommand();
      expect(agentCommand).toContain('"--agent" "main"');
      expect(agentCommand).toContain('"--session-id" "019e0000-0000-7000-8000-000000000001"');
      expect(agentCommand).not.toContain('"--session-id" "agent:main:discord:channel:thread-1"');
      expect(agentCommand).toContain('"--deliver"');
      expect(agentCommand).toContain('"--reply-channel" "discord"');
      expect(agentCommand).toContain('"--reply-to" "channel:thread-1"');
      expect(agentCommand).not.toContain('"--channel" "last"');
    });
  });

  it('resolves non-delivered webchat fallback keys through the OpenClaw sessions store', async () => {
    await withOpenClawSessionStore('main', {
      'agent:main:main': { sessionId: '019e0000-0000-7000-8000-000000000002' },
    }, async () => {
      execMock.mockResolvedValueOnce({ stdout: jsonAgentStdout('reply'), stderr: '' });

      await runChat('hello', {
        sessionId: 'agent:main:main',
        deliver: false,
      });

      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(false);
      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "message" "send"'))).toBe(false);
      const agentCommand = findAgentCommand();
      expect(agentCommand).toContain('"--agent" "main"');
      expect(agentCommand).toContain('"--session-id" "019e0000-0000-7000-8000-000000000002"');
      expect(agentCommand).not.toContain('"--channel" "last"');
      expect(agentCommand).not.toContain('"--deliver"');
      expect(agentCommand).toContain('"-m"');
    });
  });

  it('normalizes legacy webchat base links before resolving the stored OpenClaw UUID', async () => {
    await withOpenClawSessionStore('main', {
      'agent:main:main': { sessionId: '019e0000-0000-7000-8000-000000000003' },
    }, async () => {
      execMock.mockResolvedValueOnce({ stdout: jsonAgentStdout('reply'), stderr: '' });

      await runChat('hello', {
        sessionId: 'agent:main:webchat',
        deliver: false,
      });

      const agentCommand = findAgentCommand();
      expect(agentCommand).toContain('"--session-id" "019e0000-0000-7000-8000-000000000003"');
      expect(agentCommand).not.toContain('agent:main:main');
      expect(agentCommand).not.toContain('"--channel" "last"');
      expect(agentCommand).not.toContain('"--deliver"');
      expect(agentCommand).toContain('"-m"');
    });
  });

  it('resolves session keys from OPENCLAW_STATE_DIR, expanding ~ against the effective home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clawkie-openclaw-home-'));
    try {
      await writeOpenClawSessionStore(join(home, 'custom-state'), 'main', {
        'agent:main:main': { sessionId: '019e0000-0000-7000-8000-000000000006' },
      });
      process.env.OPENCLAW_HOME = home;
      process.env.OPENCLAW_STATE_DIR = '~/custom-state';
      delete process.env.OPENCLAW_CONFIG_PATH;

      await expect(resolveOpenClawAgentSessionId('agent:main:main')).resolves.toBe(
        '019e0000-0000-7000-8000-000000000006',
      );
    } finally {
      restoreOpenClawEnv();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('resolves session keys from the OPENCLAW_CONFIG_PATH directory when state dir is unset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clawkie-openclaw-config-home-'));
    try {
      await writeOpenClawSessionStore(join(home, 'config-dir'), 'main', {
        'agent:main:main': { sessionId: '019e0000-0000-7000-8000-000000000007' },
      });
      process.env.OPENCLAW_HOME = home;
      delete process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_CONFIG_PATH = '~/config-dir/openclaw.json';

      await expect(resolveOpenClawAgentSessionId('agent:main:main')).resolves.toBe(
        '019e0000-0000-7000-8000-000000000007',
      );
    } finally {
      restoreOpenClawEnv();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('treats OPENCLAW_HOME as the home directory, not the state directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clawkie-openclaw-effective-home-'));
    try {
      await writeOpenClawSessionStore(join(home, '.openclaw'), 'main', {
        'agent:main:main': { sessionId: '019e0000-0000-7000-8000-000000000008' },
      });
      await writeOpenClawSessionStore(home, 'main', {
        'agent:main:main': { sessionId: '019e0000-0000-7000-8000-000000000009' },
      });
      process.env.OPENCLAW_HOME = home;
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_CONFIG_PATH;

      await expect(resolveOpenClawAgentSessionId('agent:main:main')).resolves.toBe(
        '019e0000-0000-7000-8000-000000000008',
      );
    } finally {
      restoreOpenClawEnv();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves safe stored UUID/session-id passthrough without reading the sessions store', async () => {
    await expect(resolveOpenClawAgentSessionId('019e0000-0000-7000-8000-000000000004')).resolves.toBe(
      '019e0000-0000-7000-8000-000000000004',
    );
  });

  it('fails unresolved colon-containing session keys instead of passing them to --session-id', async () => {
    await withOpenClawSessionStore('main', {}, async () => {
      execMock.mockResolvedValueOnce({ stdout: jsonAgentStdout('reply'), stderr: '' });

      await expect(
        runChat('hello', {
          sessionId: 'agent:main:discord',
          deliver: true,
        }),
      ).rejects.toMatchObject({ code: 'openclaw_session_unresolved' });

      expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "agent"'))).toBe(false);
    });
  });

  it('classifies missing OpenClaw CLI as unavailable', async () => {
    const err = Object.assign(new Error('/bin/sh: 1: openclaw: not found'), {
      stderr: '/bin/sh: 1: openclaw: not found',
    });
    execMock.mockRejectedValue(err);

    await expect(
      runChat('hello', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'openclaw_unavailable' });
  });

  it('preserves abort classification', async () => {
    const abort = new AbortController();
    abort.abort();
    execMock.mockRejectedValueOnce(new Error('aborted'));

    await expect(
      runChat('hello', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        signal: abort.signal,
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('runChat with explicit delivery target', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('routes the transcript through the explicit delivery channel/target', async () => {
    mockExecRoutingAgentTo(jsonAgentStdout('ok'));

    await runChat('hello', {
      sessionId: 'session-1',
      delivery: { channel: 'slack', target: 'channel:C123' },
    });

    const transcriptCommand = String(execMock.mock.calls[0]?.[0]);
    expect(transcriptCommand).toContain('openclaw "message" "send"');
    expect(transcriptCommand).toContain('"--channel" "slack"');
    expect(transcriptCommand).toContain('"--target" "channel:C123"');
    expect(transcriptCommand).toContain(`"--message" ${JSON.stringify('> hello')}`);
  });

  it('does not mirror the assistant reply through message send because agent delivery handles it', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: jsonAgentStdout('hello back'), stderr: '' });

    const result = await runChat('hi', {
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    expect(result.text).toBe('hello back');

    const sendCommands = execMock.mock.calls
      .map(([cmd]) => String(cmd))
      .filter((cmd) => cmd.includes('openclaw "message" "send"'));

    expect(sendCommands).toHaveLength(1);
    expect(sendCommands[0]).toContain('"--channel" "discord"');
    expect(sendCommands[0]).toContain('"--target" "channel:thread-1"');
    expect(sendCommands[0]).toContain(`"--message" ${JSON.stringify('> hi')}`);
    expect(sendCommands[0]).not.toContain('hello back');

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--agent" "main"');
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"--reply-channel" "discord"');
    expect(agentCommand).toContain('"--reply-to" "channel:thread-1"');
    expect(agentCommand).not.toContain('"--channel" "last"');
  });

  it('does not post a reply when the agent turn fails', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18789'), {
          stderr: 'connect ECONNREFUSED 127.0.0.1:18789',
        }),
      );

    await expect(
      runChat('hi', {
        sessionId: 'session-1',
        delivery: { channel: 'discord', target: 'channel:thread-1' },
      }),
    ).rejects.toMatchObject({ code: 'openclaw_gateway_unavailable' });

    const sendCommands = execMock.mock.calls
      .map(([cmd]) => String(cmd))
      .filter((cmd) => cmd.includes('openclaw "message" "send"'));
    // Only the transcript post should have happened — no reply send.
    expect(sendCommands).toHaveLength(1);
    expect(sendCommands[0]).toContain(`"--message" ${JSON.stringify('> hi')}`);
  });

  it('classifies and surfaces an agent delivery failure', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18789'), {
          stderr: 'connect ECONNREFUSED 127.0.0.1:18789',
        }),
      );

    await expect(
      runChat('hi', {
        sessionId: 'session-1',
        delivery: { channel: 'discord', target: 'channel:thread-1' },
      }),
    ).rejects.toMatchObject({ code: 'openclaw_gateway_unavailable' });
  });
});

describe('Discord transcript formatting and target derivation', () => {
  it('builds agent input from raw STT text plus interpretation guidance', () => {
    const message = buildAgentTurnMessage('hello world');

    expect(message).toBe(
      'The following is a raw speech-to-text transcript from the user. It may contain ' +
        "mistranscriptions, missing punctuation, or incorrect words. Use your best judgment to infer the user's " +
        'intended meaning and actual spoken words before replying.\n\n' +
        '<raw-stt-transcript>\n' +
        'hello world\n' +
        '</raw-stt-transcript>\n\n' +
        'Your reply will be turned back into a voice message for the user, so keep it concise ' +
        'by default but complete enough when needed, and read-aloud friendly. Return text only; ' +
        'do not call TTS/media tools, emit MEDIA directives, or return media paths. Avoid markdown, lists, and code blocks.',
    );
    expect(message.indexOf('<raw-stt-transcript>')).toBeLessThan(message.indexOf('hello world'));
    expect(message.indexOf('hello world')).toBeLessThan(message.indexOf('</raw-stt-transcript>'));
    expect(message.indexOf('</raw-stt-transcript>')).toBeLessThan(
      message.indexOf('Your reply will be turned back into a voice message'),
    );
    expect(message).not.toContain('Preserve the existing OpenClaw session agent identity and personality');
    expect(message).not.toContain('one or two short spoken sentences');
    expect(message).not.toContain('You are Clawkie');
    expect(message).not.toContain('Reply as Clawkie');
    expect(message).toContain('Return text only');
    expect(message).toContain('do not call TTS/media tools');
    expect(message).toContain('emit MEDIA directives');
  });

  it('block-quotes each line of the user transcript without a header', () => {
    expect(quoteTranscript('one\ntwo')).toBe('> one\n> two');
  });

  it('uses explicit threadId before session-derived IDs', () => {
    expect(
      deriveDiscordMessageTarget({
        threadId: 'explicit-thread',
        sessionId: 'agent:main:discord:channel-1:thread-2',
      }),
    ).toBe('explicit-thread');
  });

  it('derives the most specific Discord channel/thread ID from agent session keys', () => {
    expect(
      deriveDiscordMessageTarget({
        sessionId: 'agent:main:discord:channel-1:thread-2',
      }),
    ).toBe('thread-2');
    expect(
      deriveDiscordMessageTarget({
        sessionId: 'agent:main:discord:channel:1497851727846576159',
      }),
    ).toBe('1497851727846576159');
    expect(
      deriveDiscordMessageTarget({
        sessionId: 'agent:main:discord:thread:1497851727846576160',
      }),
    ).toBe('1497851727846576160');
    expect(
      deriveDiscordMessageTarget({
        sessionId: 'agent:main:discord:direct:1497851727846576161',
      }),
    ).toBeUndefined();
  });
});

describe('classifyOpenClawError', () => {
  const authProfileNoise = '[agents/auth-profiles] kept local oauth over external cli bootstrap-only provider';

  it('uses precise OpenClaw runtime failure codes', () => {
    expect(classifyOpenClawError(new Error('EROFS: read-only file system, open device-auth.json'))).toBe(
      'openclaw_auth_unavailable',
    );
    expect(classifyOpenClawError(new Error('connect ECONNREFUSED 127.0.0.1:18789'))).toBe(
      'openclaw_gateway_unavailable',
    );
    expect(classifyOpenClawError(new Error('delivery channel is required'))).toBe(
      'openclaw_delivery_unavailable',
    );
  });

  it('ignores benign auth-profile diagnostics when classifying failures', () => {
    expect(classifyOpenClawError(new Error(authProfileNoise))).toBe('openclaw_failed');
    expect(
      classifyOpenClawError(
        Object.assign(new Error('Command failed'), {
          stderr: authProfileNoise,
        }),
      ),
    ).toBe('openclaw_failed');
  });

  it('keeps concrete gateway and delivery errors ahead of auth-profile noise', () => {
    expect(
      classifyOpenClawError(
        Object.assign(new Error(`Command failed\n${authProfileNoise}`), {
          stderr: `${authProfileNoise}\nconnect ECONNREFUSED 127.0.0.1:18789`,
        }),
      ),
    ).toBe('openclaw_gateway_unavailable');

    expect(
      classifyOpenClawError(
        Object.assign(new Error(`delivery channel is required\n${authProfileNoise}`), {
          stderr: authProfileNoise,
        }),
      ),
    ).toBe('openclaw_delivery_unavailable');
  });

  it('keeps real auth failures classified as auth unavailable', () => {
    expect(classifyOpenClawError(new Error(`EROFS: read-only file system, open device-auth.json\n${authProfileNoise}`))).toBe(
      'openclaw_auth_unavailable',
    );
    expect(classifyOpenClawError(new Error(`device-auth bootstrap failed: unauthorized\n${authProfileNoise}`))).toBe(
      'openclaw_auth_unavailable',
    );
  });
});

function findAgentCommand(): string {
  const call = execMock.mock.calls.find(([cmd]) => String(cmd).includes('openclaw "agent"'));
  if (!call) throw new ChatError('missing agent command', 'test_failure');
  return String(call[0]);
}

function findOpenClawExecFileInvocation(...prefix: string[]): { file: string; args: string[]; opts?: unknown } {
  const call = execFileInvocations.find((invocation) =>
    invocation.file === 'openclaw' && prefix.every((part, index) => invocation.args[index] === part),
  );
  if (!call) throw new ChatError(`missing openclaw execFile invocation: ${prefix.join(' ')}`, 'test_failure');
  return call;
}
