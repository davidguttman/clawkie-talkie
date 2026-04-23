// Client-side xAI streaming TTS.
//
// Protocol (query params, text.delta/text.done send, audio.delta/
// audio.done receive, pcm codec decoding) is verified against the
// official xAI streaming TTS docs. The handshake-auth side is blocked:
// xAI does not document a browser-compatible auth mechanism for
// `wss://api.x.ai/v1/tts` with a raw API key. Socket creation is routed
// through `openXaiVoiceSocket` which throws
// `BrowserAuthNotSupportedError` by default, so this file surfaces the
// blocker in one clearly-contained seam. Flow below is kept intact.

import {
  openXaiVoiceSocket,
  BrowserAuthNotSupportedError,
} from './xaiSocket';

export { BrowserAuthNotSupportedError };

const XAI_TTS_WS = 'wss://api.x.ai/v1/tts';
const DEFAULT_VOICE_ID = 'eve';
const DEFAULT_LANGUAGE = 'en';
const TTS_SAMPLE_RATE = 24000;

export interface TTSHandle {
  done: Promise<void>;
  stop(): void;
  readonly error?: string;
}

export interface TTSOptions {
  rate?: number;
  voiceId?: string;
  language?: string;
}

export interface TTSStartOptions extends TTSOptions {
  apiKey: string;
}

export function speakWithXaiTTS(text: string, opts: TTSStartOptions): TTSHandle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const state = {
    stopped: false,
    error: undefined as string | undefined,
    finished: false,
    ws: null as WebSocket | null,
    audioCtx: null as AudioContext | null,
    gain: null as GainNode | null,
    sources: [] as AudioBufferSourceNode[],
    nextStartTime: 0,
    audioDoneSeen: false,
    drainTimer: null as ReturnType<typeof setTimeout> | null,
    rate: opts.rate && Number.isFinite(opts.rate) ? Math.max(0.5, Math.min(2, opts.rate)) : 1,
  };

  const finish = (err?: string) => {
    if (state.finished) return;
    state.finished = true;
    if (err && !state.error) state.error = err;
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
    }
    try {
      state.ws?.close();
    } catch {
      // ignore
    }
    for (const s of state.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    state.sources = [];
    try {
      void state.audioCtx?.close();
    } catch {
      // ignore
    }
    resolveDone();
  };

  const scheduleDrainFinish = () => {
    if (state.finished || !state.audioCtx) {
      finish();
      return;
    }
    const now = state.audioCtx.currentTime;
    const remainingMs = Math.max(0, (state.nextStartTime - now) * 1000);
    if (state.drainTimer) clearTimeout(state.drainTimer);
    state.drainTimer = setTimeout(() => {
      finish();
    }, remainingMs + 50);
  };

  const handle: TTSHandle = {
    done,
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      finish();
    },
    get error() {
      return state.error;
    },
  };

  if (!opts.apiKey?.trim()) {
    state.error = 'missing_xai_api_key';
    state.finished = true;
    resolveDone();
    return handle;
  }
  if (!text.trim()) {
    state.finished = true;
    resolveDone();
    return handle;
  }

  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    state.error = 'audio_unsupported';
    state.finished = true;
    resolveDone();
    return handle;
  }

  const audioCtx = new AudioCtor({ sampleRate: TTS_SAMPLE_RATE });
  state.audioCtx = audioCtx;
  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  gain.connect(audioCtx.destination);
  state.gain = gain;

  const qs = new URLSearchParams({
    language: opts.language || DEFAULT_LANGUAGE,
    voice: opts.voiceId || DEFAULT_VOICE_ID,
    codec: 'pcm',
    sample_rate: String(TTS_SAMPLE_RATE),
  });
  let ws: WebSocket;
  try {
    // Routed through the centralized helper. By default this throws
    // BrowserAuthNotSupportedError — see xaiSocket.ts for the blocker.
    ws = openXaiVoiceSocket({ endpoint: XAI_TTS_WS, query: qs, apiKey: opts.apiKey });
  } catch (err) {
    state.error =
      err instanceof BrowserAuthNotSupportedError
        ? 'xai_browser_auth_blocked'
        : err instanceof Error
          ? err.message
          : 'xai_tts_open_failed';
    state.finished = true;
    resolveDone();
    return handle;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    if (state.stopped) return;
    try {
      ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
      ws.send(JSON.stringify({ type: 'text.done' }));
    } catch (err) {
      finish(err instanceof Error ? err.message : 'xai_tts_send_failed');
    }
  });

  ws.addEventListener('message', (ev) => {
    if (state.stopped || typeof ev.data !== 'string') return;
    let msg: { type?: string; delta?: string; message?: string };
    try {
      msg = JSON.parse(ev.data) as typeof msg;
    } catch {
      return;
    }

    if (msg.type === 'audio.delta' && typeof msg.delta === 'string') {
      schedulePcmChunk(state, msg.delta);
      return;
    }
    if (msg.type === 'audio.done') {
      state.audioDoneSeen = true;
      scheduleDrainFinish();
      return;
    }
    if (msg.type === 'error') {
      finish(`xai_tts_error: ${msg.message || 'unknown'}`);
    }
  });

  ws.addEventListener('close', (ev) => {
    if (state.stopped || state.finished) return;
    if (state.audioDoneSeen) {
      // Already scheduled drain finish — just let it fire.
      return;
    }
    finish(`xai_tts_ws_closed_${ev.code}`);
  });

  ws.addEventListener('error', () => {
    if (state.stopped || state.finished) return;
    finish('xai_tts_ws_error');
  });

  return handle;
}

function schedulePcmChunk(
  state: {
    stopped: boolean;
    audioCtx: AudioContext | null;
    gain: GainNode | null;
    sources: AudioBufferSourceNode[];
    nextStartTime: number;
    rate: number;
  },
  base64: string,
): void {
  if (state.stopped || !state.audioCtx || !state.gain) return;

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return;
  }
  if (bytes.byteLength < 2) return;

  const sampleCount = bytes.byteLength >> 1;
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true);
    samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }

  const buffer = state.audioCtx.createBuffer(1, sampleCount, state.audioCtx.sampleRate);
  buffer.getChannelData(0).set(samples);

  const source = state.audioCtx.createBufferSource();
  source.buffer = buffer;
  if (state.rate !== 1) source.playbackRate.value = state.rate;
  source.connect(state.gain);

  const now = state.audioCtx.currentTime;
  const startAt = Math.max(now, state.nextStartTime);
  state.nextStartTime = startAt + buffer.duration / (source.playbackRate.value || 1);

  state.sources.push(source);
  source.onended = () => {
    state.sources = state.sources.filter((s) => s !== source);
  };
  source.start(startAt);
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
