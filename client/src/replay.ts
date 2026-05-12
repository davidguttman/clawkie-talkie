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


export interface ReplayPlaybackHandle {
  done: Promise<void>;
  stop: () => void;
  analyser?: AnalyserNode | null;
}

export type ReplayNoneReason = Extract<ReplaySelection, { kind: 'none' }>['reason'];

export type ReplayStartResult =
  | { ok: true; mode: 'audio' | 'text'; text: string; done: Promise<void>; stop: () => void; analyser: AnalyserNode | null }
  | { ok: false; mode: 'none'; text: ''; reason: ReplayNoneReason; done: Promise<void>; stop: () => void; analyser: null };

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

export function startReplayAssistantReply({
  audio,
  text,
  canSpeakText,
  startAudio,
  startText,
}: ReplayRequest & {
  startAudio: (audio: BufferedReplyAudio) => ReplayPlaybackHandle;
  startText: (text: string) => ReplayPlaybackHandle;
}): ReplayStartResult {
  const selection = selectReplaySource({ audio, text, canSpeakText });
  if (selection.kind === 'audio') {
    try {
      const handle = startAudio(selection.audio);
      return {
        ok: true,
        mode: 'audio',
        text: text?.trim() ?? '',
        done: handle.done,
        stop: handle.stop,
        analyser: handle.analyser ?? null,
      };
    } catch (err) {
      return failedReplayStart('audio', text?.trim() ?? '', err);
    }
  }
  if (selection.kind === 'text') {
    try {
      const handle = startText(selection.text);
      return {
        ok: true,
        mode: 'text',
        text: selection.text,
        done: handle.done,
        stop: handle.stop,
        analyser: handle.analyser ?? null,
      };
    } catch (err) {
      return failedReplayStart('text', selection.text, err);
    }
  }
  return {
    ok: false,
    mode: 'none',
    text: '',
    reason: selection.reason,
    done: Promise.resolve(),
    stop: () => undefined,
    analyser: null,
  };
}

function failedReplayStart(mode: 'audio' | 'text', text: string, err: unknown): ReplayStartResult {
  return {
    ok: true,
    mode,
    text,
    done: Promise.reject(err),
    stop: () => undefined,
    analyser: null,
  };
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
  const replay = startReplayAssistantReply({
    audio,
    text,
    canSpeakText,
    startAudio: (selectedAudio) => ({
      done: playAudio(selectedAudio),
      stop: () => undefined,
      analyser: null,
    }),
    startText: (selectedText) => ({
      done: speakText(selectedText),
      stop: () => undefined,
      analyser: null,
    }),
  });
  await replay.done;
  return { ok: replay.ok, mode: replay.mode };
}
