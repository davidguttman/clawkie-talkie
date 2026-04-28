// Daemon-backed STT.
//
// PCM16LE mono 16 kHz frames captured on the phone are sent as binary
// frames on the `ct-control` DataChannel. The daemon terminates xAI's
// streaming STT WebSocket server-side (Authorization header auth) and
// relays transcript events back as JSON control frames:
//
//   daemon → phone:
//     { t: "stt.ready" }
//     { t: "stt.partial", text, is_final }
//     { t: "stt.done",    text }
//     { t: "stt.error",   message }
//     { t: "stt.closed" }
//
//   phone → daemon:
//     { t: "stt.start" }
//     (binary PCM16LE frames)
//     { t: "stt.audio.done" }
//     { t: "stt.cancel" }
//
// No xAI key ever lives in the browser on this path.
//
// Audio capture is behind the `AudioSource` boundary from
// `./audioSource`. Production default is mic; `?audio-fixture=<url>`
// on the join URL switches to a deterministic fixture source that goes
// through this exact same daemon path.

import type { ControlMessage } from '../rtc/client';
import {
  MIC_BUFFER_SIZE,
  MicPermissionError,
  SAMPLE_RATE,
  selectAudioSource,
  type AudioSource,
} from './audioSource';
import { phoneToDaemon } from './protocol';

export { MicPermissionError } from './audioSource';

export interface SttChunkConfig {
  chunkMs: number;
  chunkBytes: number;
}

// Parses `?sttChunkMs=` debug param. Returns null for missing/invalid
// values so callers fall back to default per-frame send.
export function parseSttChunkMs(raw: string | null | undefined): SttChunkConfig | null {
  if (raw == null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return null;
  const chunkBytes = Math.round((ms * SAMPLE_RATE * 2) / 1000);
  return { chunkMs: ms, chunkBytes };
}

export function readSttChunkConfigFromLocation(): SttChunkConfig | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('sttChunkMs');
  return parseSttChunkMs(raw);
}

export class DaemonNotConnectedError extends Error {
  constructor() {
    super('daemon_not_connected');
    this.name = 'DaemonNotConnectedError';
  }
}

export interface STTHandle {
  stop(): Promise<string>;
  cancel(): void;
}

export interface STTStartOptions {
  sendControl: (msg: ControlMessage) => void;
  sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  addControlListener: (fn: (msg: ControlMessage) => void) => () => void;
  isConnected: () => boolean;
  onPartial?: (text: string, isFinal: boolean) => void;
  onError?: (reason: string) => void;
  onAudioFrame?: (pcm: ArrayBuffer) => void;
  // Override the audio source. Defaults to `selectAudioSource()` which
  // picks mic or fixture from the `?audio-fixture=` query param.
  audioSource?: AudioSource;
  // Debug-only batching of PCM frames before forwarding. When omitted,
  // each PCM frame is sent individually (the production default). When
  // provided, frames are accumulated until total bytes >= chunkBytes,
  // then flushed as a single binary message. Read from `?sttChunkMs=`
  // by default; pass explicitly in tests.
  chunkConfig?: SttChunkConfig | null;
}

// Rolling cap on pre-ready frames — bounded memory, enough to preserve
// the first ~1 s of mic audio captured while the daemon's xAI WS is
// still handshaking. Fixture source doesn't emit pre-ready so this is
// effectively unused there.
export const PRE_READY_CAP_FRAMES = Math.ceil(
  1000 / ((MIC_BUFFER_SIZE / SAMPLE_RATE) * 1000),
);

export async function startDaemonSTT(opts: STTStartOptions): Promise<STTHandle> {
  if (!opts.isConnected()) throw new DaemonNotConnectedError();

  const audioSource = opts.audioSource ?? selectAudioSource();

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let resolveFinal!: (text: string) => void;
  let rejectFinal!: (err: Error) => void;
  const finalTranscript = new Promise<string>((res, rej) => {
    resolveFinal = res;
    rejectFinal = rej;
  });

  let serverReady = false;
  let settled = false;

  const detach = opts.addControlListener((msg) => {
    if (msg.t === 'stt.ready') {
      if (!serverReady) {
        serverReady = true;
        resolveReady();
      }
      return;
    }
    if (msg.t === 'stt.partial') {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const isFinal = !!(msg as { is_final?: boolean }).is_final;
      opts.onPartial?.(text, isFinal);
      return;
    }
    if (msg.t === 'stt.done') {
      if (!settled) {
        settled = true;
        resolveFinal(typeof msg.text === 'string' ? msg.text.trim() : '');
      }
      return;
    }
    if (msg.t === 'stt.error') {
      const reason = typeof msg.message === 'string' ? msg.message : 'stt_error';
      opts.onError?.(reason);
      if (!serverReady) rejectReady(new Error(reason));
      if (!settled) {
        settled = true;
        rejectFinal(new Error(reason));
      }
      return;
    }
    if (msg.t === 'stt.closed') {
      if (!serverReady) rejectReady(new Error('stt_closed_before_ready'));
      if (!settled) {
        settled = true;
        rejectFinal(new Error('stt_closed_before_done'));
      }
    }
  });

  const chunkConfig =
    opts.chunkConfig === undefined ? readSttChunkConfigFromLocation() : opts.chunkConfig;
  const batcher = chunkConfig ? createChunkBatcher(chunkConfig.chunkBytes, opts.sendBinary) : null;
  const sendOne = (pcm: ArrayBuffer) => {
    if (batcher) batcher.push(pcm);
    else opts.sendBinary(pcm);
  };

  let forwarding = false;
  const preReady: ArrayBuffer[] = [];
  const onFrame = (pcm: ArrayBuffer) => {
    opts.onAudioFrame?.(pcm);
    if (!forwarding) {
      preReady.push(pcm);
      while (preReady.length > PRE_READY_CAP_FRAMES) preReady.shift();
      return;
    }
    sendOne(pcm);
  };

  try {
    await audioSource.start(onFrame);
  } catch (err) {
    detach();
    throw err;
  }

  opts.sendControl(phoneToDaemon.sttStart());

  try {
    await ready;
  } catch (err) {
    await audioSource.stop();
    detach();
    opts.sendControl({ t: 'stt.cancel' });
    throw err instanceof Error ? err : new Error('stt_start_failed');
  }

  // Flush any frames captured between mic-arm and stt.ready (mic path),
  // then switch to live forwarding. Fixture path: preReady is empty
  // here, then `resume()` kicks off paced real-time emission that
  // arrives directly via the onFrame forwarding branch.
  for (const frame of preReady) sendOne(frame);
  preReady.length = 0;
  forwarding = true;
  audioSource.resume?.();

  const teardown = async () => {
    await audioSource.stop();
    detach();
  };

  return {
    async stop(): Promise<string> {
      batcher?.flush();
      opts.sendControl({ t: 'stt.audio.done' });
      try {
        return await finalTranscript;
      } finally {
        await teardown();
      }
    },
    cancel(): void {
      batcher?.discard();
      if (!settled) {
        settled = true;
        rejectFinal(new Error('stt_cancelled'));
      }
      opts.sendControl({ t: 'stt.cancel' });
      void teardown();
    },
  };
}

function createChunkBatcher(
  chunkBytes: number,
  sendBinary: (bytes: ArrayBuffer | Uint8Array) => void,
): { push(pcm: ArrayBuffer): void; flush(): void; discard(): void } {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pendingBytes === 0) {
      pending = [];
      return;
    }
    const out = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const part of pending) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    pending = [];
    pendingBytes = 0;
    sendBinary(out);
  };
  return {
    push(pcm) {
      const view = new Uint8Array(pcm);
      pending.push(view);
      pendingBytes += view.byteLength;
      if (pendingBytes >= chunkBytes) flush();
    },
    flush,
    discard() {
      pending = [];
      pendingBytes = 0;
    },
  };
}
