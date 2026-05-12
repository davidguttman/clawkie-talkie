import { describe, expect, it, vi } from 'vitest';
import {
  canReplayAssistantReply,
  replayAssistantReply,
  selectReplaySource,
  startReplayAssistantReply,
  type BufferedReplyAudio,
} from '../client/src/replay';

const audio: BufferedReplyAudio = {
  kind: 'pcm',
  sampleRate: 24000,
  rate: 1,
  chunks: [new Uint8Array([0, 0]).buffer],
  byteLength: 2,
  createdAt: 1,
};

describe('replay selection', () => {
  it('prefers buffered audio over saved text', () => {
    expect(selectReplaySource({ audio, text: 'fallback text', canSpeakText: true })).toEqual({
      kind: 'audio',
      audio,
    });
  });

  it('uses local text playback only when available', () => {
    expect(selectReplaySource({ audio: null, text: 'repeat that', canSpeakText: true })).toEqual({
      kind: 'text',
      text: 'repeat that',
    });
    expect(selectReplaySource({ audio: null, text: 'repeat that', canSpeakText: false })).toEqual({
      kind: 'none',
      reason: 'text_playback_unavailable',
    });
  });

  it('accepts MediaRecorder blob audio as a replay source', () => {
    const blobAudio: BufferedReplyAudio = {
      kind: 'blob',
      blob: new Blob(['remote audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      byteLength: 12,
      createdAt: 1,
    };

    expect(selectReplaySource({ audio: blobAudio, text: null, canSpeakText: false })).toEqual({
      kind: 'audio',
      audio: blobAudio,
    });
  });

  it('rejects empty blob audio and falls back to text when available', () => {
    const blobAudio: BufferedReplyAudio = {
      kind: 'blob',
      blob: new Blob([], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      byteLength: 0,
      createdAt: 1,
    };

    expect(selectReplaySource({ audio: blobAudio, text: 'saved text', canSpeakText: true })).toEqual({
      kind: 'text',
      text: 'saved text',
    });
  });

  it('does not invent a replay source without audio or text', () => {
    expect(selectReplaySource({ audio: null, text: null, canSpeakText: true })).toEqual({
      kind: 'none',
      reason: 'no_audio_or_text',
    });
  });

  it('reports replayability only when a source can actually play', () => {
    expect(canReplayAssistantReply({ audio, text: null, canSpeakText: false })).toBe(true);
    expect(canReplayAssistantReply({ audio: null, text: 'saved text', canSpeakText: true })).toBe(true);
    expect(canReplayAssistantReply({ audio: null, text: 'saved text', canSpeakText: false })).toBe(false);
    expect(canReplayAssistantReply({ audio: null, text: null, canSpeakText: true })).toBe(false);
  });
});

describe('replay action', () => {


  it('starts audio replay with saved assistant text metadata and a silence handle', async () => {
    const stop = vi.fn();
    const startAudio = vi.fn(() => ({
      done: Promise.resolve(),
      stop,
      analyser: 'fake-analyser' as unknown as AnalyserNode,
    }));
    const startText = vi.fn();

    const replay = startReplayAssistantReply({
      audio,
      text: 'visible assistant reply',
      canSpeakText: true,
      startAudio,
      startText,
    });

    expect(replay).toMatchObject({ ok: true, mode: 'audio', text: 'visible assistant reply' });
    expect(replay.analyser).toBe('fake-analyser');
    expect(startAudio).toHaveBeenCalledWith(audio);
    expect(startText).not.toHaveBeenCalled();

    replay.stop();
    expect(stop).toHaveBeenCalled();
    await expect(replay.done).resolves.toBeUndefined();
  });

  it('starts text fallback replay with trimmed assistant text and a silence handle', () => {
    const stop = vi.fn();
    const startText = vi.fn(() => ({ done: Promise.resolve(), stop }));

    const replay = startReplayAssistantReply({
      audio: null,
      text: '  visible text fallback  ',
      canSpeakText: true,
      startAudio: vi.fn(),
      startText,
    });

    expect(replay).toMatchObject({ ok: true, mode: 'text', text: 'visible text fallback' });
    expect(startText).toHaveBeenCalledWith('visible text fallback');
    replay.stop();
    expect(stop).toHaveBeenCalled();
  });

  it('turns synchronous audio starter failures into a rejected replay handle', async () => {
    const boom = new Error('audio setup failed');
    let replay: ReturnType<typeof startReplayAssistantReply> | undefined;

    expect(() => {
      replay = startReplayAssistantReply({
        audio,
        text: 'visible assistant reply',
        canSpeakText: true,
        startAudio: () => {
          throw boom;
        },
        startText: vi.fn(),
      });
    }).not.toThrow();

    expect(replay).toMatchObject({ ok: true, mode: 'audio', text: 'visible assistant reply', analyser: null });
    replay!.stop();
    await expect(replay!.done).rejects.toBe(boom);
  });

  it('turns synchronous text starter failures into a rejected replay handle', async () => {
    const boom = new Error('text setup failed');
    let replay: ReturnType<typeof startReplayAssistantReply> | undefined;

    expect(() => {
      replay = startReplayAssistantReply({
        audio: null,
        text: '  visible text fallback  ',
        canSpeakText: true,
        startAudio: vi.fn(),
        startText: () => {
          throw boom;
        },
      });
    }).not.toThrow();

    expect(replay).toMatchObject({ ok: true, mode: 'text', text: 'visible text fallback', analyser: null });
    replay!.stop();
    await expect(replay!.done).rejects.toBe(boom);
  });
  it('plays audio without falling through to text', async () => {
    const playAudio = vi.fn(() => Promise.resolve());
    const speakText = vi.fn(() => Promise.resolve());

    await expect(
      replayAssistantReply({
        audio,
        text: 'fallback text',
        canSpeakText: true,
        playAudio,
        speakText,
      }),
    ).resolves.toMatchObject({ ok: true, mode: 'audio' });

    expect(playAudio).toHaveBeenCalledWith(audio);
    expect(speakText).not.toHaveBeenCalled();
  });
});
