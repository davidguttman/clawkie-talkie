import { HOLD_MUSIC_TRACKS } from 'virtual:hold-music-tracks';

const MUSIC_VOLUME = 0.15;
const HISS_VOLUME = 0.018;
const CRACKLE_VOLUME = 0.026;
const HOLD_MUSIC_LAYER_TRACKS: readonly HoldMusicLayerSpec[] = [
  { url: '/music-layers/hiss.mp3', volume: HISS_VOLUME },
  { url: '/music-layers/crackle.mp3', volume: CRACKLE_VOLUME },
];
const MUSIC_SATURATION_DRIVE = 0.35;
const NOISE_BUFFER_SECONDS = 2;
const CRACKLES_PER_SECOND = 5;
const CRACKLE_MIN_AMPLITUDE = 0.28;
const CRACKLE_EXTRA_AMPLITUDE = 0.22;
const HOLD_MUSIC_FFT_SIZE = 64;
const HOLD_MUSIC_SMOOTHING = 0.1;
const HOLD_MUSIC_MIN_DECIBELS = -90;
const HOLD_MUSIC_MAX_DECIBELS = -10;

let sharedAudioCtx: AudioContext | null = null;
let activeHoldMusicAnalyser: AnalyserNode | null = null;

interface PreloadedHoldMusicTrack {
  audio: HTMLAudioElement;
}

interface HoldMusicLayerSpec {
  url: string;
  volume: number;
}

interface HoldMusicAudioEntry {
  audio: HTMLAudioElement;
  volume: number;
}

let shuffledHoldMusicDeck: string[] = [];
let lastHoldMusicTrack: string | null = null;
let preloadedHoldMusicTrack: PreloadedHoldMusicTrack | null = null;

export function getActiveHoldMusicAnalyser(): AnalyserNode | null {
  return activeHoldMusicAnalyser;
}

const HOLD_MUSIC_MUTE_STORAGE_KEY = 'clawkie.holdMusic.muted.v1';

let holdMusicMuted: boolean | null = null;
const muteListeners = new Set<(muted: boolean) => void>();
const activeMuteTargets = new Set<HoldMusicMuteTarget>();

interface HoldMusicMuteTarget {
  entries: readonly HoldMusicAudioEntry[];
  onMuteChanged?: (muted: boolean) => void;
}

function readMuteFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(HOLD_MUSIC_MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuteToStorage(muted: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (muted) localStorage.setItem(HOLD_MUSIC_MUTE_STORAGE_KEY, '1');
    else localStorage.removeItem(HOLD_MUSIC_MUTE_STORAGE_KEY);
  } catch {
    // storage disabled — preference reverts to default on reload
  }
}

export function getHoldMusicMuted(): boolean {
  if (holdMusicMuted === null) holdMusicMuted = readMuteFromStorage();
  return holdMusicMuted;
}

export function setHoldMusicMuted(muted: boolean): void {
  const next = !!muted;
  if (holdMusicMuted === null) holdMusicMuted = readMuteFromStorage();
  if (holdMusicMuted === next) return;
  holdMusicMuted = next;
  writeMuteToStorage(next);
  for (const target of activeMuteTargets) {
    applyHoldMusicMute(target, next);
    try { target.onMuteChanged?.(next); } catch { /* target errors must not break audio */ }
  }
  for (const listener of muteListeners) {
    try { listener(next); } catch { /* listener errors must not break audio */ }
  }
}

export function subscribeHoldMusicMuted(listener: (muted: boolean) => void): () => void {
  muteListeners.add(listener);
  return () => { muteListeners.delete(listener); };
}

function applyHoldMusicMute(target: HoldMusicMuteTarget, muted: boolean): void {
  for (const entry of target.entries) {
    try {
      entry.audio.muted = muted;
      entry.audio.volume = muted ? 0 : entry.volume;
    } catch {
      // Element volume/mute can fail in unusual browser states; keep the rest of the bed alive.
    }
  }
}

interface HoldMusicAnalyserSession {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
}

interface HoldMusicSession {
  audio: HTMLAudioElement;
  layers: HoldMusicAudioEntry[];
  muteTarget: HoldMusicMuteTarget;
  analyserSession: HoldMusicAnalyserSession | null;
  started: boolean;
  stopped: boolean;
  onMetadata: () => void;
}

export class HoldMusicController {
  private session: HoldMusicSession | null = null;

  unlock(): Promise<void> {
    const audioCtx = getSharedHoldAudioContext();
    if (!audioCtx) return Promise.resolve();
    playSilentUnlockPulse(audioCtx);
    return resumeAudioContext(audioCtx);
  }

  start(): void {
    this.stop();

    if (typeof Audio === 'undefined') return;

    try {
      const audio = consumePreloadedHoldMusicAudio();
      if (!audio) return;
      audio.loop = true;
      audio.preload = 'auto';

      const layers = createHoldMusicLayerEntries();
      const entries = [{ audio, volume: MUSIC_VOLUME }, ...layers];
      const muteTarget: HoldMusicMuteTarget = { entries };

      const session: HoldMusicSession = {
        audio,
        layers,
        muteTarget,
        analyserSession: null,
        started: false,
        stopped: false,
        onMetadata: () => {
          this.beginSession(session);
        },
      };
      muteTarget.onMuteChanged = (muted) => {
        this.handleSessionMuteChange(session, muted);
      };
      applyHoldMusicMute(muteTarget, getHoldMusicMuted());
      this.session = session;
      activeMuteTargets.add(muteTarget);

      if (hasKnownDuration(audio)) {
        this.beginSession(session);
      } else {
        audio.addEventListener('loadedmetadata', session.onMetadata);
        audio.addEventListener('durationchange', session.onMetadata);
        audio.load();
      }
    } catch {
      this.stop();
    }
  }

  stop(): void {
    const session = this.session;
    this.session = null;
    if (!session) {
      preloadNextHoldMusicTrack();
      return;
    }
    session.stopped = true;
    activeMuteTargets.delete(session.muteTarget);
    cleanupAnalyserSession(session.analyserSession);
    session.analyserSession = null;

    try {
      session.audio.removeEventListener('loadedmetadata', session.onMetadata);
      session.audio.removeEventListener('durationchange', session.onMetadata);
    } catch {
      // best-effort cleanup
    }
    cleanupAudioElement(session.audio);

    for (const layer of session.layers) cleanupAudioElement(layer.audio);

    preloadNextHoldMusicTrack();
  }

  private beginSession(session: HoldMusicSession): void {
    if (this.session !== session || session.stopped || session.started) return;
    if (!hasKnownDuration(session.audio)) return;

    session.started = true;
    const startTime = pickRandomStartTime(session.audio.duration);
    try {
      session.audio.currentTime = startTime;
    } catch {
      // Some browsers reject seeks until more data is buffered; starting at zero is acceptable.
    }

    if (!getHoldMusicMuted()) {
      const analyserSession = createBestEffortAnalyserSession(session.audio.src, startTime);
      session.analyserSession = analyserSession;
      if (analyserSession) activeHoldMusicAnalyser = analyserSession.analyser;
    }

    const playMain = session.audio.play();
    void playMain.catch(() => {
      if (this.session === session && !session.stopped) {
        this.stop();
      }
    });

    for (const layer of session.layers) {
      try {
        layer.audio.currentTime = 0;
      } catch {
        // best-effort layer alignment
      }
      void layer.audio.play().catch(() => {
        // Static layers are decorative; main hold music should keep playing without them.
      });
    }

    if (session.analyserSession) {
      const analyserSession = session.analyserSession;
      try {
        analyserSession.audio.currentTime = startTime;
      } catch {
        // analyser is non-essential
      }
      void analyserSession.audio.play().catch(() => {
        if (this.session === session && session.analyserSession === analyserSession) {
          cleanupAnalyserSession(analyserSession);
          session.analyserSession = null;
        }
      });
    }
  }

  private handleSessionMuteChange(session: HoldMusicSession, muted: boolean): void {
    if (!muted || this.session !== session || session.stopped || !session.analyserSession) return;
    cleanupAnalyserSession(session.analyserSession);
    session.analyserSession = null;
  }
}

export function pickHoldMusicUrl(random: () => number = Math.random): string {
  if (HOLD_MUSIC_TRACKS.length === 0) return '';
  const index = Math.min(
    HOLD_MUSIC_TRACKS.length - 1,
    Math.floor(random() * HOLD_MUSIC_TRACKS.length),
  );
  return holdMusicTrackUrl(HOLD_MUSIC_TRACKS[index]);
}

function consumePreloadedHoldMusicAudio(): HTMLAudioElement | null {
  preloadNextHoldMusicTrack();
  const preloaded = preloadedHoldMusicTrack;
  preloadedHoldMusicTrack = null;
  return preloaded?.audio ?? null;
}

function preloadNextHoldMusicTrack(): void {
  if (preloadedHoldMusicTrack || typeof Audio === 'undefined') return;
  const track = takeNextHoldMusicTrack();
  if (!track) return;

  try {
    const audio = new Audio(holdMusicTrackUrl(track));
    audio.preload = 'auto';
    audio.load();
    preloadedHoldMusicTrack = { audio };
  } catch {
    // Preloading is opportunistic; playback can fail silently like the rest of the hold bed.
  }
}

function takeNextHoldMusicTrack(): string | null {
  if (HOLD_MUSIC_TRACKS.length === 0) return null;
  if (shuffledHoldMusicDeck.length === 0) {
    shuffledHoldMusicDeck = createShuffledHoldMusicDeck();
  }
  const track = shuffledHoldMusicDeck.shift() ?? null;
  if (track) lastHoldMusicTrack = track;
  return track;
}

function createShuffledHoldMusicDeck(): string[] {
  const deck = [...HOLD_MUSIC_TRACKS];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  if (deck.length > 1 && deck[0] === lastHoldMusicTrack) {
    const swapIndex = deck.findIndex((track, index) => index > 0 && track !== lastHoldMusicTrack);
    if (swapIndex > 0) {
      [deck[0], deck[swapIndex]] = [deck[swapIndex], deck[0]];
    }
  }

  return deck;
}

function holdMusicTrackUrl(track: string): string {
  return `/music/${encodeURIComponent(track)}`;
}

function createHoldMusicLayerEntries(): HoldMusicAudioEntry[] {
  if (typeof Audio === 'undefined') return [];
  const entries: HoldMusicAudioEntry[] = [];
  for (const layer of HOLD_MUSIC_LAYER_TRACKS) {
    try {
      const audio = new Audio(layer.url);
      audio.loop = true;
      audio.preload = 'auto';
      audio.load();
      entries.push({ audio, volume: layer.volume });
    } catch {
      // Static layers are nice-to-have; do not block the music track.
    }
  }
  return entries;
}

preloadNextHoldMusicTrack();

export function pickRandomStartTime(duration: number, random: () => number = Math.random): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.001;
  const fraction = 0.15 + random() * 0.35;
  return Math.max(0.001, Math.min(duration - 0.001, duration * fraction));
}

function hasKnownDuration(audio: HTMLAudioElement): boolean {
  return Number.isFinite(audio.duration) && audio.duration > 0;
}

function cleanupAudioElement(audio: HTMLAudioElement): void {
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {
    // best-effort cleanup
  }
}

function createBestEffortAnalyserSession(
  trackUrl: string,
  startTime: number,
): HoldMusicAnalyserSession | null {
  if (typeof Audio === 'undefined') return null;
  const audioCtx = getSharedHoldAudioContext();
  if (!audioCtx) return null;
  void resumeAudioContext(audioCtx);

  try {
    const audio = new Audio(trackUrl);
    audio.loop = true;
    audio.preload = 'auto';
    const source = audioCtx.createMediaElementSource(audio);
    const analyser = createHoldMusicAnalyser(audioCtx);
    if (!analyser) {
      source.disconnect();
      return null;
    }
    source.connect(analyser);
    try {
      audio.currentTime = startTime;
    } catch {
      // analyser is non-essential
    }
    return { audio, source, analyser };
  } catch {
    return null;
  }
}

function cleanupAnalyserSession(session: HoldMusicAnalyserSession | null): void {
  if (!session) return;
  if (activeHoldMusicAnalyser === session.analyser) activeHoldMusicAnalyser = null;
  cleanupAudioElement(session.audio);
  for (const node of [session.source, session.analyser]) {
    try {
      node.disconnect();
    } catch {
      // already disconnected
    }
  }
}

function getSharedHoldAudioContext(): AudioContext | null {
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
    const buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate || 48000);
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
    // Unlock is best-effort; the hold bed can fail silently.
  }
}

export interface RadioStaticOptions {
  sampleRate: number;
  durationSeconds?: number;
  random?: () => number;
}

export function generateRadioHissSamples({
  sampleRate,
  durationSeconds = NOISE_BUFFER_SECONDS,
  random = Math.random,
}: RadioStaticOptions): Float32Array {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const length = Math.max(1, Math.floor(safeSampleRate * Math.max(0.001, durationSeconds)));
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = random() * 2 - 1;
  }
  return samples;
}

export function generateRadioCrackleSamples({
  sampleRate,
  durationSeconds = NOISE_BUFFER_SECONDS,
  random = Math.random,
}: RadioStaticOptions): Float32Array {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const length = Math.max(1, Math.floor(safeSampleRate * Math.max(0.001, durationSeconds)));
  const samples = new Float32Array(length);
  const crackleChance = CRACKLES_PER_SECOND / safeSampleRate;

  for (let i = 0; i < length; i += 1) {
    if (random() >= crackleChance) continue;
    const polarity = random() < 0.5 ? -1 : 1;
    samples[i] = polarity * (CRACKLE_MIN_AMPLITUDE + random() * CRACKLE_EXTRA_AMPLITUDE);
  }

  return samples;
}

export function createAmifySaturationCurve(
  length = 256,
  drive = MUSIC_SATURATION_DRIVE,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(Math.max(2, length));
  const amount = Math.max(0, drive) * 100;
  const degrees = Math.PI / 180;
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = ((3 + amount) * x * 20 * degrees) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function createHoldMusicAnalyser(audioCtx: AudioContext): AnalyserNode | null {
  if (typeof audioCtx.createAnalyser !== 'function') return null;
  try {
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = HOLD_MUSIC_FFT_SIZE;
    analyser.smoothingTimeConstant = HOLD_MUSIC_SMOOTHING;
    analyser.minDecibels = HOLD_MUSIC_MIN_DECIBELS;
    analyser.maxDecibels = HOLD_MUSIC_MAX_DECIBELS;
    return analyser;
  } catch {
    return null;
  }
}
