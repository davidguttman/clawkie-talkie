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
  buildAgentTurnMessage,
  ChatError,
  extractOpenClawReplyText,
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
      `"--message" ${JSON.stringify('> Hello\n> world')}`,
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
      `"--message" ${JSON.stringify('> from session route')}`,
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

  it('runs agent turns through OpenClaw channel-last delivery without an explicit reply target', async () => {
    execMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--agent" "main"');
    expect(agentCommand).toContain('"--channel" "last"');
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"-m"');
    expect(agentCommand).not.toContain('"--reply-channel"');
    expect(agentCommand).not.toContain('"--reply-to"');
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
        return Promise.resolve({ stdout: 'hello back\n', stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    });

    const resultPromise = runChat('hi', {
      apiKey: 'test-key',
      sessionId: 'session-1',
      threadId: 'thread-1',
      deliver: true,
    });

    await vi.waitFor(() => expect(findAgentCommand()).toContain('"--channel" "last"'));
    expect(agentStartedWhileTranscriptPending).toBe(true);
    await expect(resultPromise).resolves.toEqual({ text: 'hello back', source: 'xai_via_openclaw' });

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
          return Promise.resolve({ stdout: 'hello back\n', stderr: '' });
        }
        return Promise.resolve({ stdout: 'ok\n', stderr: '' });
      });

      await expect(
        runChat('hi', {
          apiKey: 'test-key',
          sessionId: 'session-1',
          threadId: 'thread-1',
          deliver: true,
        }),
      ).resolves.toEqual({ text: 'hello back', source: 'xai_via_openclaw' });

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
    execMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' });

    await runChat('turn left at the next light', {
      apiKey: 'test-key',
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

  it('strips OpenClaw MEDIA directives from mixed agent stdout before TTS', async () => {
    execMock.mockResolvedValue({
      stdout: 'spoken reply\nMEDIA:/tmp/openclaw/tts-test/voice.opus\n',
      stderr: '',
    });

    const result = await runChat('hi', {
      apiKey: 'test-key',
      sessionId: 'session-1',
      deliver: true,
    });

    expect(result.text).toBe('spoken reply');
  });

  it('surfaces media-only OpenClaw replies instead of sending MEDIA paths to TTS', async () => {
    execMock.mockResolvedValue({
      stdout: 'MEDIA:/tmp/openclaw/tts-test/voice.opus\n',
      stderr: '',
    });

    await expect(
      runChat('hi', {
        apiKey: 'test-key',
        sessionId: 'session-1',
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'openclaw_media_reply_unavailable' });
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
    expect(agentCommand).toContain('"--agent" "main"');
    expect(agentCommand).toContain('"--session-id" "stored-session-id"');
    expect(agentCommand).toContain('"--channel" "last"');
    expect(agentCommand).toContain('"--deliver"');
  });

  it('runs session-only webchat through OpenClaw channel last delivery', async () => {
    execMock.mockResolvedValueOnce({ stdout: 'reply\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
      sessionId: 'agent:main:main',
      deliver: true,
    });

    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(false);
    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "message" "send"'))).toBe(false);
    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--agent" "main"');
    expect(agentCommand).toContain('"--session-id" "agent:main:main"');
    expect(agentCommand).toContain('"--channel" "last"');
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"-m"');
  });

  it('normalizes legacy webchat base links to the channel-last webchat session', async () => {
    execMock.mockResolvedValueOnce({ stdout: 'reply\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
      sessionId: 'agent:main:webchat',
      deliver: true,
    });

    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--session-id" "agent:main:main"');
    expect(agentCommand).toContain('"--channel" "last"');
    expect(agentCommand).toContain('"--deliver"');
    expect(agentCommand).toContain('"-m"');
  });

  it('keeps exact session resolution for webchat when an explicit external delivery is present', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'transcript posted\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { key: 'agent:main:webchat', sessionId: 'base-session-id' },
          { key: 'agent:main:webchat:browser-1', sessionId: 'concrete-session-id' },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'reply\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
      sessionId: 'agent:main:webchat',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "sessions"'))).toBe(true);
    const agentCommand = findAgentCommand();
    expect(agentCommand).toContain('"--agent" "main"');
    expect(agentCommand).toContain('"--session-id" "base-session-id"');
    expect(agentCommand).toContain('"--channel" "last"');
    expect(agentCommand).toContain('"--deliver"');
  });

  it('does not apply webchat fallback to non-webchat base keys', async () => {
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { key: 'agent:main:discord:channel:thread-1', sessionId: 'discord-session-id' },
      ]),
      stderr: '',
    });

    await expect(
      runChat('hello', {
        apiKey: 'test-key',
        sessionId: 'agent:main:discord',
        deliver: true,
      }),
    ).rejects.toMatchObject({ code: 'openclaw_session_not_found' });

    expect(execMock.mock.calls.some(([cmd]) => String(cmd).includes('openclaw "agent"'))).toBe(false);
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

describe('runChat with explicit delivery target', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('routes the transcript through the explicit delivery channel/target', async () => {
    execMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' });

    await runChat('hello', {
      apiKey: 'test-key',
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
      .mockResolvedValueOnce({ stdout: 'hello back\n', stderr: '' });

    const result = await runChat('hi', {
      apiKey: 'test-key',
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
    expect(agentCommand).toContain('"--channel" "last"');
    expect(agentCommand).toContain('"--deliver"');
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
        apiKey: 'test-key',
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
        apiKey: 'test-key',
        sessionId: 'session-1',
        delivery: { channel: 'discord', target: 'channel:thread-1' },
      }),
    ).rejects.toMatchObject({ code: 'openclaw_gateway_unavailable' });
  });
});

describe('extractOpenClawReplyText', () => {
  it('removes MEDIA lines and preserves spoken text', () => {
    expect(extractOpenClawReplyText('hello\nMEDIA:/tmp/openclaw/voice.opus\nworld')).toBe('hello\nworld');
  });

  it('returns an empty string for media-only stdout', () => {
    expect(extractOpenClawReplyText('  MEDIA:/tmp/openclaw/voice.opus  \n')).toBe('');
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
