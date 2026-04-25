import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => {
  const fn = vi.fn();
  Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
    value: (cmd: string, opts: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        fn(cmd, opts, (error: Error | null, stdout = '', stderr = '') => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      }),
  });
  return fn;
});

vi.mock('node:child_process', () => ({
  exec: execMock,
}));

const { runChat } = await import('../daemon/src/chatSession');

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function completeExec(error: Error | null, stdout = '') {
  execMock.mockImplementation((_cmd: string, _opts: unknown, cb?: ExecCallback) => {
    if (!cb) throw new Error('missing exec callback');
    cb(error, stdout, '');
    return {};
  });
}

function mockXaiReply(text: string) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: text } }],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
}

describe('runChat', () => {
  beforeEach(() => {
    execMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the OpenClaw reply when the CLI succeeds', async () => {
    completeExec(null, 'OpenClaw reply\n');

    await expect(
      runChat('hello', {
        apiKey: 'test-key',
        sessionId: 'agent:main:discord:channel:123',
      }),
    ).resolves.toEqual({ text: 'OpenClaw reply', source: 'xai_via_openclaw' });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to xAI chat completions when OpenClaw fails', async () => {
    completeExec(Object.assign(new Error('spawn openclaw ENOENT'), { code: 'ENOENT' }));
    mockXaiReply('Fallback reply');

    const result = await runChat('hello fallback', {
      apiKey: 'test-key',
      sessionId: 'agent:main:discord:channel:123',
    });

    expect(result).toEqual({ text: 'Fallback reply', source: 'xai' });
    expect(fetch).toHaveBeenCalledTimes(1);

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hello fallback' });
  });

  it('surfaces the xAI error code when both OpenClaw and fallback fail', async () => {
    completeExec(new Error('gateway unavailable'));
    vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(
      runChat('hello', {
        apiKey: 'test-key',
        sessionId: 'agent:main:discord:channel:123',
      }),
    ).rejects.toMatchObject({ code: 'xai_http_401' });
  });

  it('preserves aborts instead of falling back to xAI', async () => {
    completeExec(new Error('operation aborted'));
    const abort = new AbortController();
    abort.abort();

    await expect(
      runChat('hello', {
        apiKey: 'test-key',
        sessionId: 'agent:main:discord:channel:123',
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });

    expect(fetch).not.toHaveBeenCalled();
  });
});
