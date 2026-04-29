import { describe, expect, it, vi } from 'vitest';
import { OpenClawInferTtsSession, TTS_SAMPLE_RATE } from '../daemon/src/ttsSession';

function makeCallbacks() {
  const events: string[] = [];
  return {
    events,
    cb: {
      onOpen: vi.fn(() => events.push('open')),
      onAudio: vi.fn((pcm: Uint8Array) => events.push(`audio:${Buffer.from(pcm).toString('hex')}`)),
      onDone: vi.fn(() => events.push('done')),
      onError: vi.fn((message: string) => events.push(`error:${message}`)),
    },
  };
}

describe('OpenClawInferTtsSession', () => {
  it('synthesizes with OpenClaw infer, converts MP3 to PCM, and emits audio lifecycle callbacks', async () => {
    const { cb, events } = makeCallbacks();
    const synthesize = vi.fn(async () => undefined);
    const convertMp3ToPcm = vi.fn(async () => Buffer.from([1, 2, 3, 4]));
    const cleanupTempDir = vi.fn(async () => undefined);

    new OpenClawInferTtsSession(
      {
        text: 'spoken reply',
        voice: 'rex',
        model: 'openai/gpt-4o-mini-tts',
        synthesize,
        convertMp3ToPcm,
        createTempDir: async () => '/tmp/clawkie-tts-test',
        cleanupTempDir,
      },
      cb,
    );

    await vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledTimes(1));

    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'spoken reply',
        outputPath: '/tmp/clawkie-tts-test/reply.mp3',
        voice: 'rex',
        model: 'openai/gpt-4o-mini-tts',
      }),
    );
    expect(convertMp3ToPcm).toHaveBeenCalledWith(
      expect.objectContaining({
        mp3Path: '/tmp/clawkie-tts-test/reply.mp3',
        sampleRate: TTS_SAMPLE_RATE,
      }),
    );
    expect(events).toEqual(['open', 'audio:01020304', 'done']);
    expect(cleanupTempDir).toHaveBeenCalledWith('/tmp/clawkie-tts-test');
  });

  it('emits stable OpenClaw infer TTS error and not audio callbacks when synth fails', async () => {
    const { cb, events } = makeCallbacks();

    new OpenClawInferTtsSession(
      {
        text: 'spoken reply',
        synthesize: async () => {
          throw new Error('provider failed');
        },
        convertMp3ToPcm: vi.fn(async () => Buffer.from([1, 2])),
        createTempDir: async () => '/tmp/clawkie-tts-test',
        cleanupTempDir: async () => undefined,
      },
      cb,
    );

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledTimes(1));

    expect(events).toEqual(['error:openclaw_infer_tts_failed']);
    expect(cb.onOpen).not.toHaveBeenCalled();
    expect(cb.onAudio).not.toHaveBeenCalled();
    expect(cb.onDone).not.toHaveBeenCalled();
  });
});
