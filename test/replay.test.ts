import { describe, expect, it, vi } from 'vitest';
import {
  replayAssistantReply,
  selectReplaySource,
  type BufferedReplyAudio,
} from '../client/src/replay';

const audio: BufferedReplyAudio = {
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

  it('does not invent a replay source without audio or text', () => {
    expect(selectReplaySource({ audio: null, text: null, canSpeakText: true })).toEqual({
      kind: 'none',
      reason: 'no_audio_or_text',
    });
  });
});

describe('replay action', () => {
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
