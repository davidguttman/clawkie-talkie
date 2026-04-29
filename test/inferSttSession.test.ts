import { describe, expect, it, vi } from 'vitest';
import { OpenClawInferError } from '../daemon/src/openclawInfer';
import { OpenClawInferSttSession } from '../daemon/src/inferSttSession';

function callbacks() {
  return {
    onReady: vi.fn(),
    onPartial: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
  };
}

function makePcm(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

function makePcmSamples(sampleCount: number, marker = 0): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  if (bytes.length > 0) bytes[0] = marker;
  return bytes;
}

function makeFilledPcmSamples(sampleCount: number, marker: number): Uint8Array {
  return new Uint8Array(sampleCount * 2).fill(marker);
}

describe('OpenClawInferSttSession', () => {
  it('fires onReady promptly when constructed', () => {
    const cb = callbacks();

    new OpenClawInferSttSession({ transcribe: async () => 'unused' }, cb);

    expect(cb.onReady).toHaveBeenCalledTimes(1);
  });

  it('uses an injected speech detector for phrase chunking and destroys it on close', async () => {
    const cb = callbacks();
    const speechDetector = {
      isSpeech: vi.fn(() => true),
      destroy: vi.fn(),
    };
    const phraseChunker = {
      push: vi.fn(() => []),
      flush: vi.fn(() => []),
    };

    const session = new OpenClawInferSttSession(
      {
        phraseChunker,
        speechDetector,
        transcribe: async () => 'unused',
      },
      cb,
    );

    const frame = Buffer.from(makePcmSamples(320, 1));

    session.sendAudio(frame);
    session.close();
    session.close();

    expect(speechDetector.isSpeech).toHaveBeenCalledWith(frame);
    expect(phraseChunker.push).toHaveBeenCalledWith(frame, true);
    expect(speechDetector.destroy).toHaveBeenCalledTimes(1);
  });

  it('reframes 1024-sample browser PCM chunks into valid 20ms VAD windows', () => {
    const cb = callbacks();
    const speechDetector = {
      isSpeech: vi.fn(() => true),
    };
    const phraseChunker = {
      push: vi.fn(() => []),
      flush: vi.fn(() => []),
    };
    const session = new OpenClawInferSttSession(
      { phraseChunker, speechDetector, transcribe: async () => 'unused' },
      cb,
    );

    expect(() => session.sendAudio(makePcmSamples(1024, 1))).not.toThrow();

    expect(speechDetector.isSpeech).toHaveBeenCalledTimes(3);
    for (const call of speechDetector.isSpeech.mock.calls) {
      expect(call[0]).toBeInstanceOf(Buffer);
      expect(call[0]).toHaveLength(320 * 2);
    }
    expect(phraseChunker.push).toHaveBeenCalledTimes(3);
  });

  it('reframes 1600-sample fixture PCM chunks into valid 20ms VAD windows', () => {
    const cb = callbacks();
    const speechDetector = {
      isSpeech: vi.fn(() => true),
    };
    const phraseChunker = {
      push: vi.fn(() => []),
      flush: vi.fn(() => []),
    };
    const session = new OpenClawInferSttSession(
      { phraseChunker, speechDetector, transcribe: async () => 'unused' },
      cb,
    );

    expect(() => session.sendAudio(makePcmSamples(1600, 1))).not.toThrow();

    expect(speechDetector.isSpeech).toHaveBeenCalledTimes(5);
    for (const call of speechDetector.isSpeech.mock.calls) {
      expect(call[0]).toBeInstanceOf(Buffer);
      expect(call[0]).toHaveLength(320 * 2);
    }
    expect(phraseChunker.push).toHaveBeenCalledTimes(5);
  });

  it('buffers VAD remainders across unaligned incoming PCM chunks', () => {
    const cb = callbacks();
    const speechDetector = {
      isSpeech: vi.fn(() => true),
    };
    const phraseChunker = {
      push: vi.fn(() => []),
      flush: vi.fn(() => []),
    };
    const session = new OpenClawInferSttSession(
      { phraseChunker, speechDetector, transcribe: async () => 'unused' },
      cb,
    );
    const first = Buffer.from(makePcmSamples(200, 1));
    const second = Buffer.from(makePcmSamples(200, 2));
    const third = Buffer.from(makePcmSamples(240, 3));
    const combined = Buffer.concat([first, second, third]);

    session.sendAudio(first);
    expect(speechDetector.isSpeech).not.toHaveBeenCalled();

    session.sendAudio(second);
    expect(speechDetector.isSpeech).toHaveBeenCalledTimes(1);
    expect(speechDetector.isSpeech.mock.calls[0]?.[0]).toEqual(combined.subarray(0, 320 * 2));

    session.sendAudio(third);
    expect(speechDetector.isSpeech).toHaveBeenCalledTimes(2);
    expect(speechDetector.isSpeech.mock.calls[1]?.[0]).toEqual(combined.subarray(320 * 2, 640 * 2));
  });

  it('treats VAD detector failures as unvoiced without throwing from sendAudio', async () => {
    const cb = callbacks();
    const speechDetector = {
      isSpeech: vi.fn(() => {
        throw new Error('vad failed');
      }),
    };
    const phraseChunker = {
      push: vi.fn(() => []),
      flush: vi.fn(() => []),
    };
    const session = new OpenClawInferSttSession(
      {
        phraseChunker,
        speechDetector,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribe: async () => 'final',
      },
      cb,
    );

    expect(() => session.sendAudio(makePcmSamples(320, 1))).not.toThrow();
    expect(phraseChunker.push).toHaveBeenCalledWith(expect.any(Buffer), false);

    await session.signalAudioDone();
    expect(cb.onDone).toHaveBeenCalledWith('final');
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('buffers multiple PCM chunks exactly in order before writing the full-turn WAV', async () => {
    const cb = callbacks();
    const wavInputs: Buffer[] = [];

    const session = new OpenClawInferSttSession(
      {
        createTempDir: async () => '/tmp/openclaw-stt-test',
        pcmToWav: (pcm) => {
          wavInputs.push(Buffer.from(pcm));
          return Buffer.from('fake-wav');
        },
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribe: async () => 'ordered transcript',
      },
      cb,
    );

    session.sendAudio(makePcm([1, 2]));
    session.sendAudio(makePcm([3, 4, 5]));
    await session.signalAudioDone();

    expect(wavInputs).toHaveLength(1);
    expect([...wavInputs[0]]).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps final full-turn infer PCM exactly as received when VAD reframes chunks', async () => {
    const cb = callbacks();
    const wavInputs: Buffer[] = [];
    const input = Buffer.from(makePcmSamples(1024, 7));
    const speechDetector = {
      isSpeech: vi.fn(() => true),
    };
    const phraseChunker = {
      push: vi.fn(() => []),
      flush: vi.fn(() => []),
    };

    const session = new OpenClawInferSttSession(
      {
        phraseChunker,
        speechDetector,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        pcmToWav: (pcm) => {
          wavInputs.push(Buffer.from(pcm));
          return Buffer.from('fake-wav');
        },
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribe: async () => 'ordered transcript',
      },
      cb,
    );

    session.sendAudio(input);
    await session.signalAudioDone();

    expect(speechDetector.isSpeech).toHaveBeenCalledTimes(3);
    expect(wavInputs).toHaveLength(1);
    expect(wavInputs[0]).toEqual(input);
  });

  it('writes one full-turn WAV and calls infer once with language', async () => {
    const cb = callbacks();
    const writes: Array<{ path: string; data: Buffer }> = [];
    const inferCalls: Array<{ wavPath: string; language?: string; signal?: AbortSignal }> = [];

    const session = new OpenClawInferSttSession(
      {
        language: 'en',
        createTempDir: async () => '/tmp/openclaw-stt-test',
        pcmToWav: (pcm) => Buffer.concat([Buffer.from('wav:'), pcm]),
        writeFile: async (path, data) => {
          writes.push({ path, data: Buffer.from(data) });
        },
        cleanupTempDir: async () => undefined,
        transcribe: async (request) => {
          inferCalls.push(request);
          return 'hello world';
        },
      },
      cb,
    );

    session.sendAudio(makePcm([10, 11]));
    await session.signalAudioDone();

    expect(writes).toEqual([
      { path: '/tmp/openclaw-stt-test/turn.wav', data: Buffer.from([119, 97, 118, 58, 10, 11]) },
    ]);
    expect(inferCalls).toHaveLength(1);
    expect(inferCalls[0]).toMatchObject({ wavPath: '/tmp/openclaw-stt-test/turn.wav', language: 'en' });
    expect(inferCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('calls onDone(text) and then onClosed after successful infer', async () => {
    const cb = callbacks();
    const lifecycle: string[] = [];
    cb.onDone.mockImplementation((text: string) => lifecycle.push(`done:${text}`));
    cb.onClosed.mockImplementation(() => lifecycle.push('closed'));

    const session = new OpenClawInferSttSession(
      {
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribe: async () => 'final words',
      },
      cb,
    );

    await session.signalAudioDone();

    expect(cb.onDone).toHaveBeenCalledWith('final words');
    expect(lifecycle).toEqual(['done:final words', 'closed']);
  });

  it.each(['', '   '])(
    'propagates empty/whitespace transcript %j via onDone so runReplyTurn can emit empty_transcript',
    async (transcript) => {
      const cb = callbacks();

      const session = new OpenClawInferSttSession(
        {
          createTempDir: async () => '/tmp/openclaw-stt-test',
          writeFile: async () => undefined,
          cleanupTempDir: async () => undefined,
          transcribe: async () => transcript,
        },
        cb,
      );

      await session.signalAudioDone();

      expect(cb.onDone).toHaveBeenCalledWith(transcript);
      expect(cb.onError).not.toHaveBeenCalled();
    },
  );

  it("calls onError('openclaw_infer_stt_failed') and closes when infer fails", async () => {
    const cb = callbacks();
    const lifecycle: string[] = [];
    cb.onError.mockImplementation((code: string) => lifecycle.push(`error:${code}`));
    cb.onClosed.mockImplementation(() => lifecycle.push('closed'));

    const session = new OpenClawInferSttSession(
      {
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribe: async () => {
          throw new OpenClawInferError('openclaw_infer_stt_failed: provider failed');
        },
      },
      cb,
    );

    await session.signalAudioDone();

    expect(cb.onError).toHaveBeenCalledWith('openclaw_infer_stt_failed');
    expect(lifecycle).toEqual(['error:openclaw_infer_stt_failed', 'closed']);
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('close aborts in-flight infer and suppresses later callbacks', async () => {
    const cb = callbacks();
    let inferSignal: AbortSignal | undefined;
    let resolveInfer: ((text: string) => void) | undefined;

    const session = new OpenClawInferSttSession(
      {
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribe: async ({ signal }) => {
          inferSignal = signal;
          return new Promise<string>((resolve) => {
            resolveInfer = resolve;
          });
        },
      },
      cb,
    );

    const done = session.signalAudioDone();
    await vi.waitFor(() => expect(inferSignal).toBeDefined());

    session.close();
    expect(inferSignal?.aborted).toBe(true);

    resolveInfer?.('late transcript');
    await done;

    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onClosed).not.toHaveBeenCalled();
  });


  it('transcribes completed phrase chunks through the injected chunk transcriber', async () => {
    const cb = callbacks();
    const chunkTranscripts: string[] = [];
    const writes: Array<{ path: string; data: Buffer }> = [];
    const phraseChunker = {
      push: vi.fn((pcm: Buffer) => (pcm[0] === 2 ? [{ pcm: Buffer.from([9, 8]) }] : [])),
      flush: vi.fn(() => []),
    };

    const session = new OpenClawInferSttSession(
      {
        createTempDir: async () => '/tmp/openclaw-stt-test',
        pcmToWav: (pcm) => Buffer.concat([Buffer.from('wav:'), pcm]),
        writeFile: async (path, data) => {
          writes.push({ path, data: Buffer.from(data) });
        },
        cleanupTempDir: async () => undefined,
        phraseChunker,
        detectSpeech: () => true,
        transcribeChunk: async (request) => {
          chunkTranscripts.push(request.wavPath);
          return 'chunk words';
        },
        transcribe: async () => 'final words',
      },
      cb,
    );

    session.sendAudio(makePcmSamples(320, 1));
    session.sendAudio(makePcmSamples(320, 2));

    await vi.waitFor(() => expect(cb.onPartial).toHaveBeenCalledWith('chunk words', true));
    expect(chunkTranscripts).toEqual(['/tmp/openclaw-stt-test/chunk-1.wav']);
    expect(writes).toContainEqual({
      path: '/tmp/openclaw-stt-test/chunk-1.wav',
      data: Buffer.from([119, 97, 118, 58, 9, 8]),
    });
  });

  it('emits completed chunk transcripts as final partials', async () => {
    const cb = callbacks();
    const phraseChunker = {
      push: vi.fn(() => [{ pcm: Buffer.from([1, 2]) }]),
      flush: vi.fn(() => []),
    };

    const session = new OpenClawInferSttSession(
      {
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        phraseChunker,
        detectSpeech: () => true,
        transcribeChunk: async () => 'near live',
        transcribe: async () => 'final',
      },
      cb,
    );

    session.sendAudio(makePcmSamples(320, 1));

    await vi.waitFor(() => expect(cb.onPartial).toHaveBeenCalledWith('near live', true));
  });

  it('emits fixed-cadence chunks during continuous speech without waiting for VAD phrase end', async () => {
    const cb = callbacks();
    const chunkPaths: string[] = [];

    const session = new OpenClawInferSttSession(
      {
        sampleRate: 1000,
        enablePhraseChunks: true,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribeChunk: async ({ wavPath }) => {
          chunkPaths.push(wavPath);
          return `chunk ${chunkPaths.length}`;
        },
        transcribe: async () => 'final',
      },
      cb,
    );

    session.sendAudio(makeFilledPcmSamples(15_000, 1));

    await vi.waitFor(() => expect(chunkPaths).toEqual([
      '/tmp/openclaw-stt-test/chunk-1.wav',
      '/tmp/openclaw-stt-test/chunk-2.wav',
      '/tmp/openclaw-stt-test/chunk-3.wav',
    ]));
    await vi.waitFor(() => expect(cb.onPartial).toHaveBeenCalledTimes(3));
  });

  it('includes prior overlap context in fixed-cadence chunk windows', async () => {
    const cb = callbacks();
    const chunkPcms: Buffer[] = [];

    const session = new OpenClawInferSttSession(
      {
        sampleRate: 1000,
        enablePhraseChunks: true,
        partialChunkCadenceMs: 5000,
        partialChunkOverlapMs: 500,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        pcmToWav: (pcm) => {
          chunkPcms.push(Buffer.from(pcm));
          return Buffer.from(pcm);
        },
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribeChunk: async () => 'chunk',
        transcribe: async () => 'final',
      },
      cb,
    );

    session.sendAudio(makeFilledPcmSamples(5_000, 1));
    await vi.waitFor(() => expect(chunkPcms).toHaveLength(1));

    session.sendAudio(makeFilledPcmSamples(5_000, 2));
    await vi.waitFor(() => expect(chunkPcms).toHaveLength(2));

    expect(chunkPcms[0]).toHaveLength(5_000 * 2);
    expect(chunkPcms[0]?.[0]).toBe(1);
    expect(chunkPcms[0]?.at(-1)).toBe(1);
    expect(chunkPcms[1]).toHaveLength(5_500 * 2);
    expect(chunkPcms[1]?.[0]).toBe(1);
    expect(chunkPcms[1]?.at(-1)).toBe(2);
  });

  it('bounds fixed-cadence chunk transcription concurrency without serializing all chunks', async () => {
    const cb = callbacks();
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const resolvers = new Map<number, (text: string) => void>();

    const session = new OpenClawInferSttSession(
      {
        sampleRate: 1000,
        enablePhraseChunks: true,
        maxConcurrentChunkTranscripts: 2,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribeChunk: async ({ wavPath }) => {
          const id = Number(wavPath.match(/chunk-(\d+)\.wav/)?.[1]);
          started.push(id);
          active += 1;
          maxActive = Math.max(maxActive, active);
          return new Promise<string>((resolve) => {
            resolvers.set(id, (text) => {
              active -= 1;
              resolve(text);
            });
          });
        },
        transcribe: async () => 'final',
      },
      cb,
    );

    session.sendAudio(makeFilledPcmSamples(15_000, 1));

    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1, 2]);
    expect(maxActive).toBe(2);

    resolvers.get(2)?.('second');
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    expect(active).toBe(2);
    expect(maxActive).toBe(2);

    resolvers.get(1)?.('first');
    resolvers.get(3)?.('third');
    await vi.waitFor(() => expect(cb.onPartial).toHaveBeenCalledWith('third', true));
  });

  it('keeps the final full-turn infer authoritative for onDone', async () => {
    const cb = callbacks();
    const transcribeChunk = vi.fn(async () => 'chunk guess');

    const session = new OpenClawInferSttSession(
      {
        sampleRate: 1000,
        enablePhraseChunks: true,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribeChunk,
        transcribe: async () => 'authoritative final',
      },
      cb,
    );

    session.sendAudio(makeFilledPcmSamples(5_000, 1));
    await vi.waitFor(() => expect(cb.onPartial).toHaveBeenCalledWith('chunk guess', true));
    await session.signalAudioDone();

    expect(transcribeChunk).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledWith('authoritative final');
    expect(cb.onDone).not.toHaveBeenCalledWith('chunk guess');
  });



  it('ignores partial results after close', async () => {
    const cb = callbacks();
    let resolveChunk: ((text: string) => void) | undefined;
    let chunkSignal: AbortSignal | undefined;
    const transcribeChunk = vi.fn(({ signal }) => {
      chunkSignal = signal;
      return new Promise<string>((resolve) => {
        resolveChunk = resolve;
      });
    });

    const session = new OpenClawInferSttSession(
      {
        sampleRate: 1000,
        enablePhraseChunks: true,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribeChunk,
        transcribe: async () => 'final',
      },
      cb,
    );

    session.sendAudio(makeFilledPcmSamples(5_000, 1));
    await vi.waitFor(() => expect(transcribeChunk).toHaveBeenCalledTimes(1));

    session.close();
    expect(chunkSignal?.aborted).toBe(true);

    resolveChunk?.('stale chunk');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cb.onPartial).not.toHaveBeenCalled();
    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onClosed).not.toHaveBeenCalled();
  });

  it('ignores partial results after final starts and does not let them block final infer', async () => {
    const cb = callbacks();
    let resolveChunk: ((text: string) => void) | undefined;
    let chunkSignal: AbortSignal | undefined;
    const transcribeChunk = vi.fn(
      ({ signal }) => {
        chunkSignal = signal;
        return new Promise<string>((resolve) => {
          resolveChunk = resolve;
        });
      },
    );
    const transcribe = vi.fn(async () => 'authoritative final');

    const session = new OpenClawInferSttSession(
      {
        sampleRate: 1000,
        enablePhraseChunks: true,
        createTempDir: async () => '/tmp/openclaw-stt-test',
        writeFile: async () => undefined,
        cleanupTempDir: async () => undefined,
        transcribeChunk,
        transcribe,
      },
      cb,
    );

    session.sendAudio(makeFilledPcmSamples(5_000, 1));
    await vi.waitFor(() => expect(transcribeChunk).toHaveBeenCalledTimes(1));

    const done = session.signalAudioDone();
    await expect(
      Promise.race([
        done.then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]),
    ).resolves.toBe('done');

    expect(chunkSignal?.aborted).toBe(true);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledWith('authoritative final');

    resolveChunk?.('stale chunk');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cb.onPartial).not.toHaveBeenCalledWith('stale chunk', true);
  });
});
