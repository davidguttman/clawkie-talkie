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
}

export const REPLAY_AVAILABILITY_CHANGED_EVENT = 'clawkie:replay-availability-changed';

export function selectReplaySource(request: ReplayRequest): ReplaySelection {
  if (hasReplayAudio(request.audio)) {
    return { kind: 'audio', audio: request.audio };
  }
  const text = request.text?.trim();
  if (!text) return { kind: 'none', reason: 'no_audio_or_text' };
  if (request.canSpeakText) return { kind: 'text', text };
  return { kind: 'none', reason: 'text_playback_unavailable' };
}

export function canReplayAssistantReply(request: ReplayRequest): boolean {
  return selectReplaySource(request).kind !== 'none';
}

export function notifyReplayAvailabilityChanged(): void {
  if (typeof window === 'undefined') return;
  if (typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(REPLAY_AVAILABILITY_CHANGED_EVENT));
}

export function subscribeReplayAvailabilityChanges(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(REPLAY_AVAILABILITY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(REPLAY_AVAILABILITY_CHANGED_EVENT, listener);
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
    return { ok: true, mode: 'audio' };
  }
  if (selection.kind === 'text') {
    await speakText(selection.text);
    return { ok: true, mode: 'text' };
  }
  return {
    ok: false,
    mode: 'none',
  };
}
