export type BufferedReplyAudio = BufferedPcmReplyAudio | BufferedBlobReplyAudio;

export interface BufferedPcmReplyAudio {
  kind: 'pcm';
  sampleRate: number;
  rate: number;
  chunks: ArrayBuffer[];
  byteLength: number;
  createdAt: number;
}

export interface BufferedBlobReplyAudio {
  kind: 'blob';
  blob: Blob;
  mimeType: string;
  byteLength: number;
  createdAt: number;
}

export type ReplaySelection =
  | { kind: 'audio'; audio: BufferedReplyAudio }
  | { kind: 'text'; text: string }
  | { kind: 'none'; reason: 'no_audio_or_text' | 'text_playback_unavailable' };

export interface ReplayRequest {
  audio: BufferedReplyAudio | null;
  text: string | null;
  canSpeakText: boolean;
}

export interface ReplayResult {
  ok: boolean;
  mode: 'audio' | 'text' | 'none';
  message: string;
}

export function selectReplaySource(request: ReplayRequest): ReplaySelection {
  if (hasReplayAudio(request.audio)) {
    return { kind: 'audio', audio: request.audio };
  }
  const text = request.text?.trim();
  if (!text) return { kind: 'none', reason: 'no_audio_or_text' };
  if (request.canSpeakText) return { kind: 'text', text };
  return { kind: 'none', reason: 'text_playback_unavailable' };
}

function hasReplayAudio(audio: BufferedReplyAudio | null): audio is BufferedReplyAudio {
  if (!audio || audio.byteLength <= 0) return false;
  if (audio.kind === 'blob') return audio.blob.size > 0;
  return audio.chunks.length > 0;
}

export async function replayAssistantReply({
  audio,
  text,
  canSpeakText,
  playAudio,
  speakText,
}: ReplayRequest & {
  playAudio: (audio: BufferedReplyAudio) => Promise<void>;
  speakText: (text: string) => Promise<void>;
}): Promise<ReplayResult> {
  const selection = selectReplaySource({ audio, text, canSpeakText });
  if (selection.kind === 'audio') {
    await playAudio(selection.audio);
    return { ok: true, mode: 'audio', message: 'Replaying last spoken reply' };
  }
  if (selection.kind === 'text') {
    await speakText(selection.text);
    return { ok: true, mode: 'text', message: 'Replaying from saved text' };
  }
  return {
    ok: false,
    mode: 'none',
    message:
      selection.reason === 'no_audio_or_text'
        ? 'Nothing to replay yet'
        : 'Replay unavailable on this browser',
  };
}
