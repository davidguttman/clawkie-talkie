import { loadMusicSettings, saveMusicSettings, type MusicSettings } from '../storage';
import { getHoldMusicTracks, holdMusicTrackUrl } from './holdMusicCatalog';

const MUSIC_VOLUME = 0.15;
const HISS_VOLUME = 0.0045;
const CRACKLE_VOLUME = 0.0065;
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
  track: string;
  effects: boolean;
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
const desiredHoldMusicControllers = new Set<HoldMusicController>();

export function getActiveHoldMusicAnalyser(): AnalyserNode | null {
  return activeHoldMusicAnalyser;
}

let holdMusicMuted: boolean | null = null;
const muteListeners = new Set<(muted: boolean) => void>();
const activeMuteTargets = new Set<HoldMusicMuteTarget>();

interface HoldMusicMuteTarget {
  entries: readonly HoldMusicAudioEntry[];
  onMuteChanged?: (muted: boolean) => void;
}

function readMuteFromStorage(): boolean {
  return loadMusicSettings().muted;
}

function writeMuteToStorage(muted: boolean): void {
  saveMusicSettings({ ...loadMusicSettings(), muted });
}

function publishHoldMusicMuted(muted: boolean): void {
  const next = !!muted;
  if (holdMusicMuted === null) holdMusicMuted = readMuteFromStorage();
  if (holdMusicMuted === next) return;
  holdMusicMuted = next;
  for (const target of activeMuteTargets) {
    applyHoldMusicMute(target, next);
    try { target.onMuteChanged?.(next); } catch { /* target errors must not break audio */ }
  }
  for (const listener of muteListeners) {
    try { listener(next); } catch { /* listener errors must not break audio */ }
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
  writeMuteToStorage(next);
  publishHoldMusicMuted(next);
}

export function setHoldMusicSettings(settings: MusicSettings): void {
  const before = loadMusicSettings();
  if (holdMusicMuted === null) holdMusicMuted = before.muted;
  saveMusicSettings(settings);
  const after = loadMusicSettings();
  publishHoldMusicMuted(after.muted);

  if (!holdMusicPlaybackSettingsEqual(before, after)) {
    resetPreloadedHoldMusicTrackIfNeeded(after);
    for (const controller of Array.from(desiredHoldMusicControllers)) {
      controller.restartForSettingsChange();
    }
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
  private wantsPlayback = false;

  unlock(): Promise<void> {
    const audioCtx = getSharedHoldAudioContext();
    if (!audioCtx) return Promise.resolve();
    playSilentUnlockPulse(audioCtx);
    return resumeAudioContext(audioCtx);
  }

  start(): void {
    this.wantsPlayback = true;
    desiredHoldMusicControllers.add(this);
    this.stopActiveSession();

    if (typeof Audio === 'undefined') return;

    try {
      const audio = consumePreloadedHoldMusicAudio();
      if (!audio) return;
      audio.loop = true;
      audio.preload = 'auto';

      const musicSettings = loadMusicSettings();
      const layers = createHoldMusicLayerEntries(musicSettings);
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
    this.wantsPlayback = false;
    desiredHoldMusicControllers.delete(this);
    this.stopActiveSession();
  }

  restartForSettingsChange(): void {
    if (!this.wantsPlayback) return;
    this.stopActiveSession();
    this.start();
  }

  private stopActiveSession(): void {
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

export function pickHoldMusicUrl(
  random: () => number = Math.random,
  settings: MusicSettings = loadMusicSettings(),
): string {
  const tracks = enabledHoldMusicTracks(settings);
  if (tracks.length === 0) return '';
  const index = Math.min(
    tracks.length - 1,
    Math.floor(random() * tracks.length),
  );
  return holdMusicTrackUrl(tracks[index], settings.effects);
}

function consumePreloadedHoldMusicAudio(): HTMLAudioElement | null {
  const settings = loadMusicSettings();
  resetPreloadedHoldMusicTrackIfNeeded(settings);
  preloadNextHoldMusicTrack(settings);
  const preloaded = preloadedHoldMusicTrack;
  preloadedHoldMusicTrack = null;
  return preloaded?.audio ?? null;
}

function preloadNextHoldMusicTrack(settings: MusicSettings = loadMusicSettings()): void {
  if (preloadedHoldMusicTrack || typeof Audio === 'undefined') return;
  const track = takeNextHoldMusicTrack(settings);
  if (!track) return;

  try {
    const audio = new Audio(holdMusicTrackUrl(track, settings.effects));
    audio.preload = 'auto';
    audio.load();
    preloadedHoldMusicTrack = { audio, track, effects: settings.effects };
  } catch {
    // Preloading is opportunistic; playback can fail silently like the rest of the hold bed.
  }
}

function takeNextHoldMusicTrack(settings: MusicSettings = loadMusicSettings()): string | null {
  const tracks = enabledHoldMusicTracks(settings);
  if (tracks.length === 0) return null;
  if (shuffledHoldMusicDeck.length === 0 || shuffledHoldMusicDeck.some((track) => !tracks.includes(track))) {
    shuffledHoldMusicDeck = createShuffledHoldMusicDeck(tracks);
  }
  const track = shuffledHoldMusicDeck.shift() ?? null;
  if (track) lastHoldMusicTrack = track;
  return track;
}

function createShuffledHoldMusicDeck(tracks: readonly string[]): string[] {
  const deck = [...tracks];
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

function enabledHoldMusicTracks(settings: MusicSettings): string[] {
  const disabled = new Set(settings.disabledTracks);
  return getHoldMusicTracks().filter((track) => !disabled.has(track));
}

function resetPreloadedHoldMusicTrackIfNeeded(settings: MusicSettings): void {
  if (!preloadedHoldMusicTrack) return;
  if (
    preloadedHoldMusicTrack.effects === settings.effects
    && isTrackEnabled(preloadedHoldMusicTrack.track, settings)
  ) return;
  cleanupAudioElement(preloadedHoldMusicTrack.audio);
  preloadedHoldMusicTrack = null;
}

function isTrackEnabled(track: string, settings: MusicSettings): boolean {
  return !settings.disabledTracks.includes(track);
}

function holdMusicPlaybackSettingsEqual(a: MusicSettings, b: MusicSettings): boolean {
  return a.effects === b.effects && stringSetsEqual(a.disabledTracks, b.disabledTracks);
}

function stringSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

function createHoldMusicLayerEntries(settings: MusicSettings): HoldMusicAudioEntry[] {
  if (!settings.effects || typeof Audio === 'undefined') return [];
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
