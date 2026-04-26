// Daemon-backed TTS playback.
//
// The daemon terminates xAI TTS server-side and streams PCM16LE mono
// audio back over the PeerJS DataConnection as binary frames, framed by:
//
//   daemon → phone:
//     { t: "tts.start", sample_rate: number }
//     <binary>  // PCM16LE samples
//     ...
//     { t: "tts.done" | "tts.error", message? }
//
// The phone never touches an xAI API key or WebSocket. This file wires
// incoming binary frames into the Web Audio graph at the sample rate
// the daemon announces; playback paces itself via `nextStartTime` so
// small fragments are stitched into a continuous stream.

const DEFAULT_SAMPLE_RATE = 24000;

let sharedAudioCtx: AudioContext | null = null;

export interface TTSHandle {
  done: Promise<void>;
  stop(): void;
  readonly error?: string;
}

export interface TTSPlayerOptions {
  addControlListener: (fn: (msg: { t: string; [k: string]: unknown }) => void) => () => void;
  addBinaryListener: (fn: (bytes: ArrayBuffer) => void) => () => void;
  sendControl: (msg: { t: string; [k: string]: unknown }) => void;
  rate?: number;
}

// Mobile browsers only allow playback after the user has unlocked audio from a
// trusted gesture. Call this from the first tap/pointerdown path so the daemon's
// later async TTS stream reuses an already-unlocked context.
export function unlockDaemonTtsAudio(): Promise<void> {
  const audioCtx = getSharedAudioContext();
  if (!audioCtx) return Promise.resolve();

  // iOS Safari is most reliable when a source node is also started inside the
  // gesture. Keep it silent with a zero-gain node to avoid clicks.
  playSilentUnlockPulse(audioCtx);
  return resumeAudioContext(audioCtx);
}

// Start listening for a single TTS turn from the daemon. Resolves when
// the daemon emits `tts.done` (or on `tts.error`, settling with an
// error code on the handle). Caller should invoke this after it sees
// `reply.done` so the player is armed before the daemon emits
// `tts.start`.
export function playDaemonTts(opts: TTSPlayerOptions): TTSHandle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const state = {
    finished: false,
    stopped: false,
    error: undefined as string | undefined,
    audioCtx: null as AudioContext | null,
    gain: null as GainNode | null,
    sources: [] as AudioBufferSourceNode[],
    nextStartTime: 0,
    sampleRate: DEFAULT_SAMPLE_RATE,
    started: false,
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
    for (const s of state.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    state.sources = [];
    try {
      state.gain?.disconnect();
    } catch {
      // already disconnected
    }
    detachControl();
    detachBinary();
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
    state.drainTimer = setTimeout(() => finish(), remainingMs + 50);
  };

  const initAudio = (sampleRate: number) => {
    state.sampleRate = sampleRate;
    if (state.audioCtx) {
      void resumeAudioContext(state.audioCtx);
      return;
    }
    const audioCtx = getSharedAudioContext();
    if (!audioCtx) {
      finish('audio_unsupported');
      return;
    }
    const gain = audioCtx.createGain();
    gain.gain.value = 1;
    gain.connect(audioCtx.destination);
    state.audioCtx = audioCtx;
    state.gain = gain;
    void resumeAudioContext(audioCtx);
  };

  const detachControl = opts.addControlListener((msg) => {
    if (state.finished || state.stopped) return;
    if (msg.t === 'tts.start') {
      state.started = true;
      const sr = typeof msg.sample_rate === 'number' ? msg.sample_rate : DEFAULT_SAMPLE_RATE;
      initAudio(sr);
      return;
    }
    if (msg.t === 'tts.done') {
      scheduleDrainFinish();
      return;
    }
    if (msg.t === 'tts.error') {
      const message = typeof msg.message === 'string' ? msg.message : 'xai_tts_error';
      finish(message);
    }
  });

  const detachBinary = opts.addBinaryListener((bytes) => {
    if (state.finished || state.stopped) return;
    if (!state.audioCtx) initAudio(state.sampleRate);
    if (!state.audioCtx || !state.gain) return;
    schedulePcmChunk(state, bytes);
  });

  return {
    done,
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      try {
        opts.sendControl({ t: 'reply.cancel' });
      } catch {
        // ignore — connection may already be gone
      }
      finish();
    },
    get error() {
      return state.error;
    },
  };
}

function schedulePcmChunk(
  state: {
    stopped: boolean;
    audioCtx: AudioContext | null;
    gain: GainNode | null;
    sources: AudioBufferSourceNode[];
    nextStartTime: number;
    sampleRate: number;
    rate: number;
  },
  bytes: ArrayBuffer,
): void {
  if (state.stopped || !state.audioCtx || !state.gain) return;
  if (bytes.byteLength < 2) return;
  void resumeAudioContext(state.audioCtx);

  const sampleCount = bytes.byteLength >> 1;
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes);
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true);
    samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }

  const buffer = state.audioCtx.createBuffer(1, sampleCount, state.sampleRate);
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

function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') return sharedAudioCtx;

  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    sharedAudioCtx = new AudioCtor();
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

function resumeAudioContext(audioCtx: AudioContext): Promise<void> {
  if (audioCtx.state === 'closed' || audioCtx.state === 'running') return Promise.resolve();
  return audioCtx.resume().then(
    () => undefined,
    () => undefined,
  );
}

function playSilentUnlockPulse(audioCtx: AudioContext): void {
  try {
    const buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate || DEFAULT_SAMPLE_RATE);
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.onended = () => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
    source.start(0);
  } catch {
    // Unlock is best-effort; playDaemonTts will report audio_unsupported if
    // real playback setup fails later.
  }
}
