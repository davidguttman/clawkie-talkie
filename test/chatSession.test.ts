import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => {
  const fn = vi.fn();
  Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
    value: (cmd: string, opts?: unknown) => Promise.resolve(fn(cmd, opts)),
  });
  return fn;
});

vi.mock('node:child_process', () => ({ exec: execMock }));

import {
  ChatError,
  classifyOpenClawError,
  deriveDiscordMessageTarget,
  quoteTranscript,
  runChat,
} from '../daemon/src/chatSession';

describe('runChat OpenClaw CLI integration', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('posts the final transcript as a Discord quote before running the agent', async () => {
    execMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' });

    await runChat('Hello\nworld', {
      apiKey: 'test-key',
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const transcriptCommand = String(execMock.mock.calls[0]?.[0]);
    expect(transcriptCommand).toContain('openclaw "message" "send"');
    expect(transcriptCommand).toContain('"--channel" "discord"');
    expect(transcriptCommand).toContain('"--target" "channel:thread-1"');
    expect(transcriptCommand).toContain(
      `"--message" ${JSON.stringify('**User said:**\n> Hello\n> world')}`,
    );

    const agentCallIndex = execMock.mock.calls.findIndex(([cmd]) =>
      String(cmd).includes('openclaw "agent"'),
    );
    expect(agentCallIndex).toBeGreaterThan(0);
  });

  it('posts transcripts to the Discord target derived from the session key when threadId is absent', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { key: 'agent:main:discord:channel-1:thread-2', sessionId: 'stored-session-id' },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'reply\n', stderr: '' });

    await runChat('from session route', {
      apiKey: 'test-key',
      sessionId: 'agent:main:discord:channel-1:thread-2',
      deliver: true,
    });

    const transcriptCommand = String(execMock.mock.calls[0]?.[0]);
    expect(transcriptCommand).toContain('openclaw "message" "send"');
    expect(transcriptCommand).toContain('"--target" "channel:thread-2"');
    expect(transcriptCommand).toContain(
      `"--message" ${JSON.stringify('**User said:**\n> from session route')}`,
    );
  });

  it('targets the Discord reply thread when threadId is provided', async () => {
    execMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' });

    await expect(
      runChat('hello', {
        apiKey: 'test-key',
        sessionId: 'session-1',
        threadId: 'thread-1',
        deliver: true,
      }),
    ).resolves.toEqual({ text: 'ok', source: 'xai_via_openclaw' });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--session-id" "session-1"');
  });

  it('never invokes the agent with --deliver or an explicit reply target', async () => {
    execMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const agentCommand = findAgentCommand();
    expect(agentCommand).not.toContain('"--deliver"');
    expect(agentCommand).not.toContain('"--reply-channel"');
    expect(agentCommand).not.toContain('"--reply-to"');
  });

  it('does not post the agent reply text via openclaw message send (the agent does it)', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'hello back\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'ok\n', stderr: '' });

    const result = await runChat('hi', {
      apiKey: 'test-key',
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

  it('runs the turn even when no Discord target can be derived (no reply re-send)', async () => {
    execMock.mockResolvedValue({ stdout: 'plain reply\n', stderr: '' });

    const result = await runChat('hi', {
      apiKey: 'test-key',
      sessionId: 'session-1',
      deliver: true,
    });

    expect(result.text).toBe('plain reply');

    const sendCommands = execMock.mock.calls
      .map(([cmd]) => String(cmd))
      .filter((cmd) => cmd.includes('openclaw "message" "send"'));
    // No transcript (no Discord target) and no explicit reply send.
    expect(sendCommands).toHaveLength(0);
  });

  it('resolves OpenClaw session keys to stored session ids before agent runs', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { key: 'agent:main:discord:channel:thread-1', sessionId: 'stored-session-id' },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'reply\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
      sessionId: 'agent:main:discord:channel:thread-1',
      deliver: true,
    });

    expect(execMock.mock.calls[1]?.[0]).toContain('openclaw "sessions"');
    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--session-id" "stored-session-id"');
  });

  it('classifies missing OpenClaw CLI as unavailable', async () => {
    const err = Object.assign(new Error('/bin/sh: 1: openclaw: not found'), {
      stderr: '/bin/sh: 1: openclaw: not found',
    });
    execMock.mockRejectedValueOnce(err);

    await expect(
      runChat('hello', {
        apiKey: 'test-key',
        sessionId: 'session-1',
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
        apiKey: 'test-key',
        sessionId: 'session-1',
        signal: abort.signal,
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('Discord transcript formatting and target derivation', () => {
  it('labels and quotes the user transcript', () => {
    expect(quoteTranscript('one\ntwo')).toBe('**User said:**\n> one\n> two');
  });

  it('uses explicit threadId before session-derived IDs', () => {
    expect(
      deriveDiscordMessageTarget({
        threadId: 'explicit-thread',
        sessionId: 'agent:main:discord:channel-1:thread-2',
      }),
    ).toBe('explicit-thread');
  });

  it('derives the most specific Discord ID from agent session keys', () => {
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
  });
});

describe('classifyOpenClawError', () => {
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
});

function findAgentCommand(): string {
  const call = execMock.mock.calls.find(([cmd]) => String(cmd).includes('openclaw "agent"'));
  if (!call) throw new ChatError('missing agent command', 'test_failure');
  return String(call[0]);
}
