import { describe, expect, it, vi } from 'vitest';
import {
  replayAssistantReply,
  selectReplaySource,
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
