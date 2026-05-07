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

import { notifyReplayAvailabilityChanged, type BufferedReplyAudio } from '../replay';

const DEFAULT_SAMPLE_RATE = 24000;
const VISUALIZER_FFT_SIZE = 512;
const VISUALIZER_SMOOTHING = 0.45;

let sharedAudioCtx: AudioContext | null = null;
let sharedAudioElement: HTMLAudioElement | null = null;
let attachedRemoteStream: MediaStream | null = null;
let remoteAudioSuppressed = false;
let lastBufferedReplyAudio: BufferedReplyAudio | null = null;
let remoteStreamAnalyserState: {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  sink: GainNode;
} | null = null;

export interface RemoteTtsAudioDebugSnapshot {
  present: boolean;
  paused: boolean | null;
  currentTime: number | null;
  readyState: number | null;
  src: string | null;
  srcObject: {
    present: boolean;
    type: string;
    audioTrackCount: number | null;
    liveAudioTrackCount: number | null;
    audioTrackStates: string[];
  } | null;
}

export function getRemoteTtsAudioDebugSnapshot(): RemoteTtsAudioDebugSnapshot {
  const el = sharedAudioElement;
  const srcObject = el?.srcObject ?? null;
  const stream =
    typeof MediaStream !== 'undefined' && srcObject instanceof MediaStream ? srcObject : null;
  return {
    present: !!el,
    paused: el ? el.paused : null,
    currentTime: el ? el.currentTime : null,
    readyState: el ? el.readyState : null,
    src: el ? el.currentSrc || el.src || null : null,
    srcObject: srcObject
      ? {
          present: true,
          type: srcObject.constructor?.name || typeof srcObject,
          audioTrackCount: stream ? stream.getAudioTracks().length : null,
          liveAudioTrackCount: stream
            ? stream.getAudioTracks().filter((track) => track.readyState === 'live').length
            : null,
          audioTrackStates: stream
            ? stream.getAudioTracks().map((track) => `${track.kind}:${track.readyState}`)
            : [],
        }
      : null,
  };
}

export interface TTSHandle {
  done: Promise<void>;
  stop(options?: { cancelRemote?: boolean }): void;
  readonly error?: string;
  readonly analyser?: AnalyserNode | null;
}

export function getLastBufferedReplyAudio(): BufferedReplyAudio | null {
  if (!lastBufferedReplyAudio) return null;
  if (lastBufferedReplyAudio.kind === 'blob') return lastBufferedReplyAudio;
  return {
    ...lastBufferedReplyAudio,
    chunks: lastBufferedReplyAudio.chunks.map((chunk) => chunk.slice(0)),
  };
}

export function canSpeakReplayText(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

export function speakReplayText(text: string): Promise<void> {
  if (!canSpeakReplayText()) return Promise.reject(new Error('speech_synthesis_unavailable'));
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve();
    }
  });
}

export function playBufferedReplyAudio(audio: BufferedReplyAudio): Promise<void> {
  if (audio.kind === 'blob') return playBufferedBlobAudio(audio.blob, audio.mimeType);
  return playBufferedPcmAudio(audio);
}

function playBufferedBlobAudio(blob: Blob, mimeType: string): Promise<void> {
  if (typeof Audio === 'undefined' || typeof URL === 'undefined') {
    return Promise.reject(new Error('audio_unsupported'));
  }
  return new Promise((resolve, reject) => {
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([blob], { type: mimeType || blob.type }));
      const el = new Audio(url);
      el.setAttribute('playsinline', 'true');
      el.onended = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('audio_replay_failed'));
      };
      const result = el.play();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          URL.revokeObjectURL(url);
          reject(err);
        });
      }
    } catch (err) {
      if (url) URL.revokeObjectURL(url);
      reject(err);
    }
  });
}

function playBufferedPcmAudio(audio: Extract<BufferedReplyAudio, { kind: 'pcm' }>): Promise<void> {
  const audioCtx = getSharedAudioContext();
  if (!audioCtx || audio.chunks.length === 0) return Promise.reject(new Error('audio_unsupported'));
  void resumeAudioContext(audioCtx);
  try {
    const gain = audioCtx.createGain();
    gain.gain.value = 1;
    gain.connect(audioCtx.destination);
    let nextStartTime = audioCtx.currentTime;
    let remaining = 0;
    return new Promise((resolve) => {
      const finishOne = (source: AudioBufferSourceNode) => {
        remaining -= 1;
        try {
          source.disconnect();
        } catch {
          // already disconnected
        }
        if (remaining === 0) {
          try {
            gain.disconnect();
          } catch {
            // already disconnected
          }
          resolve();
        }
      };

      for (const chunk of audio.chunks) {
        if (chunk.byteLength < 2) continue;
        const source = createPcmBufferSource(audioCtx, chunk, audio.sampleRate);
        if (!source) continue;
        source.connect(gain);
        const startAt = Math.max(audioCtx.currentTime, nextStartTime);
        nextStartTime = startAt + source.buffer!.duration / (source.playbackRate.value || 1);
        remaining += 1;
        source.onended = () => finishOne(source);
        source.start(startAt);
      }

      if (remaining === 0) {
        try {
          gain.disconnect();
        } catch {
          // already disconnected
        }
        resolve();
      }
    });
  } catch {
    return Promise.reject(new Error('audio_unsupported'));
  }
}

export interface TTSPlayerOptions {
  addControlListener: (fn: (msg: { t: string; [k: string]: unknown }) => void) => () => void;
  addBinaryListener: (fn: (bytes: ArrayBuffer) => void) => () => void;
  sendControl: (msg: { t: string; [k: string]: unknown }) => void;
  initialControlMessage?: { t: string; [k: string]: unknown };
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
  applyRemoteAudioSuppression(el);
  if (!remoteAudioSuppressed) void playRemoteAudioElement(el);
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
    el.muted = remoteAudioSuppressed;
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
  applyRemoteAudioSuppression(el);
  void playRemoteAudioElement(el);
}

function setRemoteAudioSuppressed(suppressed: boolean): void {
  remoteAudioSuppressed = suppressed;
  const el = sharedAudioElement;
  if (!el) return;
  applyRemoteAudioSuppression(el);
  if (suppressed) return;
  if (attachedRemoteStream && el.srcObject !== attachedRemoteStream) {
    try {
      el.srcObject = attachedRemoteStream;
    } catch {
      // best-effort
    }
  }
  if (attachedRemoteStream) void playRemoteAudioElement(el);
}

function applyRemoteAudioSuppression(el: HTMLAudioElement): void {
  try {
    el.muted = remoteAudioSuppressed;
  } catch {
    // best-effort
  }
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
    remoteRecorder: null as RemoteReplyRecorder | null,
    replayChunks: [] as ArrayBuffer[],
    replayBytes: 0,
    forcePcmPlayback: false,
  };

  const finishCleanup = () => {
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

  const finish = (err?: string) => {
    if (state.finished) return;
    state.finished = true;
    if (err && !state.error) state.error = err;
    const remoteRecorder = state.remoteRecorder;
    state.remoteRecorder = null;
    if (remoteRecorder && (err || state.stopped)) {
      remoteRecorder.cancel();
    }
    if (!err && !state.stopped && remoteRecorder) {
      remoteRecorder.stop().then(
        (audio) => {
          if (audio) {
            lastBufferedReplyAudio = audio;
            notifyReplayAvailabilityChanged();
          }
          finishCleanup();
        },
        () => finishCleanup(),
      );
      return;
    }
    if (!err && !state.stopped && state.replayChunks.length > 0) {
      lastBufferedReplyAudio = {
        kind: 'pcm',
        sampleRate: state.sampleRate,
        rate: 1,
        chunks: state.replayChunks.map((chunk) => chunk.slice(0)),
        byteLength: state.replayBytes,
        createdAt: Date.now(),
      };
      notifyReplayAvailabilityChanged();
    }
    finishCleanup();
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

  const handleControl = (msg: { t: string; [k: string]: unknown }) => {
    if (state.finished || state.stopped) return;
    if (msg.t === 'tts.start') {
      state.started = true;
      setRemoteAudioSuppressed(false);
      state.replayChunks = [];
      state.replayBytes = 0;
      state.forcePcmPlayback = msg.buffered === true;
      state.remoteRecorder?.cancel();
      state.remoteRecorder = state.forcePcmPlayback ? null : startRemoteReplyRecorder(attachedRemoteStream);
      const sr = typeof msg.sample_rate === 'number' ? msg.sample_rate : DEFAULT_SAMPLE_RATE;
      initAudio(sr);
      return;
    }
    if (msg.t === 'tts.done') {
      scheduleDrainFinish();
      return;
    }
    if (msg.t === 'tts.error') {
      const message = typeof msg.message === 'string' ? msg.message : 'openclaw_infer_tts_failed';
      finish(message);
    }
  };

  const detachControl = opts.addControlListener(handleControl);
  if (opts.initialControlMessage) handleControl(opts.initialControlMessage);

  const detachBinary = opts.addBinaryListener((bytes) => {
    if (state.finished || state.stopped) return;
    // When the daemon's WebRTC audio track is attached, the remote
    // audio element is the source of truth. Ignore PCM frames so we
    // don't double-play with subtle drift.
    if (isRemoteAudioActive() && !state.forcePcmPlayback) return;
    if (!state.audioCtx) initAudio(state.sampleRate);
    if (!state.audioCtx || !state.gain) return;
    state.replayChunks.push(bytes.slice(0));
    state.replayBytes += bytes.byteLength;
    schedulePcmChunk(state, bytes);
  });

  return {
    done,
    stop(options?: { cancelRemote?: boolean }) {
      if (state.stopped) return;
      state.stopped = true;
      setRemoteAudioSuppressed(true);
      if (options?.cancelRemote !== false) {
        try {
          opts.sendControl({ t: 'reply.cancel' });
        } catch {
          // ignore — connection may already be gone
        }
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

interface RemoteReplyRecorder {
  stop(): Promise<BufferedReplyAudio | null>;
  cancel(): void;
}

function startRemoteReplyRecorder(stream: MediaStream | null): RemoteReplyRecorder | null {
  if (!stream || typeof MediaRecorder === 'undefined') return null;
  if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) return null;
  try {
    const mimeType = preferredRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    let stopped = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();
    return {
      stop() {
        if (stopped) return Promise.resolve(null);
        stopped = true;
        return new Promise((resolve) => {
          recorder.onstop = () => {
            const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
            resolve(
              blob.size > 0
                ? {
                    kind: 'blob',
                    blob,
                    mimeType: blob.type,
                    byteLength: blob.size,
                    createdAt: Date.now(),
                  }
                : null,
            );
          };
          try {
            recorder.stop();
          } catch {
            resolve(null);
          }
        });
      },
      cancel() {
        if (stopped) return;
        stopped = true;
        try {
          recorder.ondataavailable = null;
          recorder.onstop = null;
          recorder.stop();
        } catch {
          // already stopped or unsupported
        }
      },
    };
  } catch {
    return null;
  }
}

function preferredRecordingMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const candidate of candidates) {
    if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

function schedulePcmChunk(
  state: {
    stopped: boolean;
    audioCtx: AudioContext | null;
    gain: GainNode | null;
    sources: AudioBufferSourceNode[];
    nextStartTime: number;
    sampleRate: number;
  },
  bytes: ArrayBuffer,
): void {
  if (state.stopped || !state.audioCtx || !state.gain) return;
  if (bytes.byteLength < 2) return;
  void resumeAudioContext(state.audioCtx);

  const source = createPcmBufferSource(state.audioCtx, bytes, state.sampleRate);
  if (!source) return;
  source.connect(state.gain);

  const now = state.audioCtx.currentTime;
  const startAt = Math.max(now, state.nextStartTime);
  state.nextStartTime = startAt + source.buffer!.duration / (source.playbackRate.value || 1);

  state.sources.push(source);
  source.onended = () => {
    state.sources = state.sources.filter((s) => s !== source);
  };
  source.start(startAt);
}

function createPcmBufferSource(
  audioCtx: AudioContext,
  bytes: ArrayBuffer,
  sampleRate: number,
): AudioBufferSourceNode | null {
  if (bytes.byteLength < 2) return null;
  const sampleCount = bytes.byteLength >> 1;
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes);
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true);
    samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }

  const buffer = audioCtx.createBuffer(1, sampleCount, sampleRate);
  buffer.getChannelData(0).set(samples);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  return source;
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
