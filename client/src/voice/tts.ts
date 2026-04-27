// Daemon-backed TTS playback.
//
// Two paths, in priority order:
//
//   1) Outbound WebRTC media track (matches the Rambly CLI). The daemon
//      attaches an audio MediaStreamTrack to the peer connection and
//      pushes 48 kHz / 10 ms frames during TTS. The phone gets the
//      stream via `peer.on('stream')`, hands it to a hidden
//      HTMLAudioElement, and `play()`s it from the user's PTT gesture
//      so mobile autoplay rules are satisfied. Survives backgrounding
//      and ICE keepalive better than data-channel buffer playback.
//
//   2) Data-channel PCM fallback. If the daemon couldn't open an
//      RTCAudioSource (or the phone never saw `peer.on('stream')`), it
//      falls back to PCM16LE binary frames over the data channel,
//      stitched together via Web Audio buffer sources. Same shape as
//      before:
//
//        daemon → phone:
//          { t: "tts.start", sample_rate: number }
//          <binary>  // PCM16LE samples
//          ...
//          { t: "tts.done" | "tts.error", message? }
//
// The phone never touches an xAI API key or WebSocket either way.

import { startMediaSessionKeeper } from './mediaSessionKeeper';

const DEFAULT_SAMPLE_RATE = 24000;
const VISUALIZER_FFT_SIZE = 512;
const VISUALIZER_SMOOTHING = 0.45;

let sharedAudioCtx: AudioContext | null = null;
let sharedAudioElement: HTMLAudioElement | null = null;
let attachedRemoteStream: MediaStream | null = null;
let backgroundStaticState: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
let backgroundStaticAnalyser: AnalyserNode | null = null;
let remoteStreamAnalyserState: {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  sink: GainNode;
} | null = null;

// Pink-shaped noise sits below the agent voice in the mix; this
// multiplier is intentionally low and was halved from the previous
// 0.04 white-noise tuning after pink shaping made the bed audibly
// warmer at the same nominal level.
export const BACKGROUND_STATIC_GAIN = 0.02;
const BACKGROUND_STATIC_BUFFER_SECONDS = 2;

export interface PinkNoiseOptions {
  // Base amplitude applied to the filtered pink output before
  // crackle pops are mixed in. ~0.18 keeps peaks near ±0.5 with the
  // Kellet coefficients below; the gain node attenuates further.
  amplitude?: number;
  // Per-sample probability of a crackle pop. Kept rare so the bed
  // sounds like vinyl warmth rather than overt static.
  crackleProbability?: number;
  // Crackle pop amplitude (added on top of the pink sample).
  crackleAmplitude?: number;
  // Injectable RNG for deterministic tests.
  random?: () => number;
}

// Paul Kellet's pink-noise filter (public domain). Cheap, stable,
// and produces a perceptually warm 1/f spectrum from a white-noise
// driver without needing an AudioWorklet or BiquadFilter chain.
export function generatePinkNoiseSamples(
  count: number,
  opts: PinkNoiseOptions = {},
): Float32Array {
  const amplitude = opts.amplitude ?? 0.18;
  const crackleProbability = opts.crackleProbability ?? 0.0004;
  const crackleAmplitude = opts.crackleAmplitude ?? 0.6;
  const rand = opts.random ?? Math.random;

  const out = new Float32Array(Math.max(0, count));
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    let s = pink * amplitude;
    if (rand() < crackleProbability) {
      s += (rand() * 2 - 1) * crackleAmplitude;
    }
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s;
  }
  return out;
}

export interface TTSHandle {
  done: Promise<void>;
  stop(): void;
  readonly error?: string;
  readonly analyser?: AnalyserNode | null;
}

export interface TTSPlayerOptions {
  addControlListener: (fn: (msg: { t: string; [k: string]: unknown }) => void) => () => void;
  addBinaryListener: (fn: (bytes: ArrayBuffer) => void) => () => void;
  sendControl: (msg: { t: string; [k: string]: unknown }) => void;
  rate?: number;
}

// Mobile browsers only allow playback after the user has unlocked audio from a
// trusted gesture. Call this from the first tap/pointerdown path so the daemon's
// later async TTS stream reuses an already-unlocked context AND so the hidden
// HTMLAudioElement is permitted to play the daemon's outbound MediaStream.
export function unlockDaemonTtsAudio(): Promise<void> {
  // Prime the HTMLAudioElement used for the WebRTC remote-track path
  // so it has a play() call inside the user gesture even if the
  // daemon's stream hasn't arrived yet. Once srcObject is assigned
  // later, mobile browsers will treat playback as gesture-authorized.
  primeRemoteAudioElement();

  // Light up the silent media-session keeper so iOS keeps an active
  // media session after this gesture — that's what makes AirPods /
  // lock-screen play-pause buttons reach our setActionHandler
  // callbacks while the app is otherwise idle. Imported lazily inline
  // to avoid pulling DOM-only code into SSR/import-time evaluation.
  startMediaSessionKeeper();

  const audioCtx = getSharedAudioContext();
  if (!audioCtx) return Promise.resolve();

  // iOS Safari is most reliable when a source node is also started inside the
  // gesture. Keep it silent with a zero-gain node to avoid clicks.
  playSilentUnlockPulse(audioCtx);
  return resumeAudioContext(audioCtx);
}

// Hand the daemon's outbound audio MediaStream to the hidden audio
// element. Called from the RTC layer's `peer.on('stream')` handler.
// Idempotent on the same stream; replacing the stream reattaches.
export function attachDaemonRemoteStream(stream: MediaStream): void {
  if (typeof document === 'undefined') return;
  attachedRemoteStream = stream;
  attachRemoteStreamAnalyser(stream);
  const el = ensureRemoteAudioElement();
  if (!el) return;
  if (el.srcObject !== stream) {
    try {
      el.srcObject = stream;
    } catch {
      // Some browsers reject reassignment if the element is mid-load.
      // Best-effort: clear and retry.
      try {
        el.srcObject = null;
        el.srcObject = stream;
      } catch {
        // Nothing to do — playback will simply not start until the
        // next stream attachment succeeds.
      }
    }
  }
  void playRemoteAudioElement(el);
}

export function detachDaemonRemoteStream(stream?: MediaStream): void {
  if (stream && attachedRemoteStream !== stream) return;
  attachedRemoteStream = null;
  if (sharedAudioElement) {
    try {
      sharedAudioElement.pause();
      sharedAudioElement.srcObject = null;
    } catch {
      // best-effort
    }
  }
  detachRemoteStreamAnalyser();
}

// True once a daemon stream has been attached AND playback has been
// started (or attempted) on the audio element. The data-channel PCM
// fallback consults this to know when to stay out of the way.
export function isRemoteAudioActive(): boolean {
  return !!attachedRemoteStream && !!sharedAudioElement;
}

export function getActiveOutputAnalysers(): AnalyserNode[] {
  const out: AnalyserNode[] = [];
  if (backgroundStaticAnalyser) out.push(backgroundStaticAnalyser);
  if (remoteStreamAnalyserState?.stream.getTracks().some((t) => t.readyState === 'live')) {
    out.push(remoteStreamAnalyserState.analyser);
  }
  return out;
}

function ensureRemoteAudioElement(): HTMLAudioElement | null {
  if (sharedAudioElement) return sharedAudioElement;
  if (typeof document === 'undefined') return null;
  try {
    const el = document.createElement('audio');
    el.autoplay = true;
    // Keep it off-screen but in the DOM so iOS schedules playback.
    el.setAttribute('playsinline', 'true');
    el.setAttribute('aria-hidden', 'true');
    el.style.position = 'absolute';
    el.style.width = '0';
    el.style.height = '0';
    el.style.opacity = '0';
    document.body.appendChild(el);
    sharedAudioElement = el;
    return el;
  } catch {
    return null;
  }
}

function primeRemoteAudioElement(): void {
  const el = ensureRemoteAudioElement();
  if (!el) return;
  // If a stream has already been attached, kick off playback inside
  // the gesture. If not, calling play() on an empty element is a
  // no-op but still records the gesture context for later assignment.
  if (attachedRemoteStream && el.srcObject !== attachedRemoteStream) {
    try {
      el.srcObject = attachedRemoteStream;
    } catch {
      // best-effort
    }
  }
  void playRemoteAudioElement(el);
}

function playRemoteAudioElement(el: HTMLAudioElement): Promise<void> {
  try {
    const result = el.play();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => undefined,
        () => undefined,
      );
    }
  } catch {
    // ignore
  }
  return Promise.resolve();
}

// Audible PTT confirmation tone. Doubles as proof that the audio path works
// from inside the user's tap gesture — if the user can hear this, mobile
// playback is unlocked and the daemon TTS stream should be reachable too.
export function playPttPressTone(): void {
  const audioCtx = getSharedAudioContext();
  if (!audioCtx) return;
  void resumeAudioContext(audioCtx);
  try {
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
  } catch {
    // best-effort — silent failure is fine, the tone is just a UX hint
  }
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
    analyser: null as AnalyserNode | null,
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
      state.analyser?.disconnect();
    } catch {
      // already disconnected
    }
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
    const analyser = createVisualizerAnalyser(audioCtx);
    gain.gain.value = 1;
    gain.connect(analyser);
    analyser.connect(audioCtx.destination);
    state.audioCtx = audioCtx;
    state.gain = gain;
    state.analyser = analyser;
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
    // When the daemon's WebRTC audio track is attached, the remote
    // audio element is the source of truth. Ignore PCM frames so we
    // don't double-play with subtle drift.
    if (isRemoteAudioActive()) return;
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
    get analyser() {
      return state.analyser;
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

// Low-volume background static + occasional crackle — used as an
// audible "system is alive" signal during the `thinking` and `ai`
// phases. Mixed at a much lower gain than TTS so it sits behind the
// agent voice without masking it. Idempotent start; cleans up its own
// nodes on stop. Reuses the same shared/unlocked AudioContext as the
// PTT cue, so iOS lets it run after the user's first tap.
export function startBackgroundStatic(): void {
  if (backgroundStaticState) return;
  const audioCtx = getSharedAudioContext();
  if (!audioCtx) return;
  void resumeAudioContext(audioCtx);
  try {
    const sr = audioCtx.sampleRate || DEFAULT_SAMPLE_RATE;
    const samples = Math.max(1, Math.floor(sr * BACKGROUND_STATIC_BUFFER_SECONDS));
    const buffer = audioCtx.createBuffer(1, samples, sr);
    const ch = buffer.getChannelData(0);
    ch.set(generatePinkNoiseSamples(samples));
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    (source as AudioBufferSourceNode & { loop: boolean }).loop = true;
    const gain = audioCtx.createGain();
    const analyser = createVisualizerAnalyser(audioCtx);
    gain.gain.value = BACKGROUND_STATIC_GAIN;
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(audioCtx.destination);
    source.start(0);
    backgroundStaticState = { source, gain };
    backgroundStaticAnalyser = analyser;
  } catch {
    backgroundStaticState = null;
    backgroundStaticAnalyser = null;
  }
}

export function stopBackgroundStatic(): void {
  const s = backgroundStaticState;
  backgroundStaticState = null;
  if (!s) return;
  try {
    s.source.stop();
  } catch {
    // already stopped
  }
  try {
    s.source.disconnect();
  } catch {
    // already disconnected
  }
  try {
    s.gain.disconnect();
  } catch {
    // already disconnected
  }
  try {
    backgroundStaticAnalyser?.disconnect();
  } catch {
    // already disconnected
  }
  backgroundStaticAnalyser = null;
}

export function isBackgroundStaticActive(): boolean {
  return !!backgroundStaticState;
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

function createVisualizerAnalyser(audioCtx: AudioContext): AnalyserNode {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = VISUALIZER_FFT_SIZE;
  analyser.smoothingTimeConstant = VISUALIZER_SMOOTHING;
  return analyser;
}

function attachRemoteStreamAnalyser(stream: MediaStream): void {
  const audioCtx = getSharedAudioContext();
  if (!audioCtx) return;
  if (remoteStreamAnalyserState?.stream === stream) return;
  detachRemoteStreamAnalyser();
  try {
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = createVisualizerAnalyser(audioCtx);
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(audioCtx.destination);
    remoteStreamAnalyserState = { stream, source, analyser, sink };
    void resumeAudioContext(audioCtx);
  } catch {
    remoteStreamAnalyserState = null;
  }
}

function detachRemoteStreamAnalyser(): void {
  const state = remoteStreamAnalyserState;
  remoteStreamAnalyserState = null;
  if (!state) return;
  try {
    state.source.disconnect();
  } catch {
    // already disconnected
  }
  try {
    state.analyser.disconnect();
  } catch {
    // already disconnected
  }
  try {
    state.sink.disconnect();
  } catch {
    // already disconnected
  }
}
