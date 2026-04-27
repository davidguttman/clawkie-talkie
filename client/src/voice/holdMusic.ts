const HOLD_MUSIC_TRACKS = [
  'Dial Tone Reverie.mp3',
  'Dockside Hold.mp3',
  'Looped Hold Tone.mp3',
  'Pixel Queue.mp3',
  'Rotary Hush.mp3',
  'Soft Hold Tone.mp3',
] as const;

const MUSIC_GAIN = 0.15;
const NOISE_GAIN = 0.035;
const MUSIC_HIGHPASS_HZ = 320;
const MUSIC_LOWPASS_HZ = 3600;
const MUSIC_MIDRANGE_HZ = 1500;
const MUSIC_MIDRANGE_GAIN_DB = 6;
const MUSIC_MIDRANGE_Q = 1.2;
const MUSIC_WOBBLE_HZ = 0.13;
const MUSIC_WOBBLE_DEPTH = 0.045;
const NOISE_BANDPASS_HZ = 2000;
const NOISE_BANDPASS_Q = 0.5;
const NOISE_BUFFER_SECONDS = 2;
const STATIC_LOW_CUT_HZ = 650;
const STATIC_HIGH_CUT_HZ = 4600;
const STATIC_CRACKLES_PER_SECOND = 11;
const STATIC_FLUTTER_DEPTH = 0.26;
const STATIC_GAIN = 0.56;

let sharedAudioCtx: AudioContext | null = null;

interface HoldMusicSession {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  musicHighpass: BiquadFilterNode;
  musicLowpass: BiquadFilterNode;
  musicMidPeak: BiquadFilterNode;
  musicSaturation: WaveShaperNode;
  musicCompressor: DynamicsCompressorNode;
  musicWobble: GainNode;
  musicWobbleOscillator: OscillatorNode;
  musicWobbleDepth: GainNode;
  musicGain: GainNode;
  noiseSource: AudioBufferSourceNode;
  noiseBandpass: BiquadFilterNode;
  noiseGain: GainNode;
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

    const audioCtx = getSharedHoldAudioContext();
    if (!audioCtx || typeof Audio === 'undefined') return;
    void resumeAudioContext(audioCtx);

    try {
      const audio = new Audio(pickHoldMusicUrl());
      audio.loop = true;
      audio.preload = 'auto';

      const source = audioCtx.createMediaElementSource(audio);
      const musicHighpass = audioCtx.createBiquadFilter();
      const musicLowpass = audioCtx.createBiquadFilter();
      const musicMidPeak = audioCtx.createBiquadFilter();
      const musicSaturation = audioCtx.createWaveShaper();
      const musicCompressor = audioCtx.createDynamicsCompressor();
      const musicWobble = audioCtx.createGain();
      const musicWobbleOscillator = audioCtx.createOscillator();
      const musicWobbleDepth = audioCtx.createGain();
      const musicGain = audioCtx.createGain();
      const noiseSource = createNoiseSource(audioCtx);
      const noiseBandpass = audioCtx.createBiquadFilter();
      const noiseGain = audioCtx.createGain();

      musicHighpass.type = 'highpass';
      musicHighpass.frequency.value = MUSIC_HIGHPASS_HZ;
      musicHighpass.Q.value = 0.8;

      musicLowpass.type = 'lowpass';
      musicLowpass.frequency.value = MUSIC_LOWPASS_HZ;
      musicLowpass.Q.value = 0.7;

      musicMidPeak.type = 'peaking';
      musicMidPeak.frequency.value = MUSIC_MIDRANGE_HZ;
      musicMidPeak.Q.value = MUSIC_MIDRANGE_Q;
      musicMidPeak.gain.value = MUSIC_MIDRANGE_GAIN_DB;

      musicSaturation.curve = createGentleSaturationCurve();
      musicSaturation.oversample = '2x';

      musicCompressor.threshold.value = -24;
      musicCompressor.knee.value = 18;
      musicCompressor.ratio.value = 3;
      musicCompressor.attack.value = 0.012;
      musicCompressor.release.value = 0.32;

      musicWobble.gain.value = 1;
      musicWobbleOscillator.type = 'sine';
      musicWobbleOscillator.frequency.value = MUSIC_WOBBLE_HZ;
      musicWobbleDepth.gain.value = MUSIC_WOBBLE_DEPTH;
      musicGain.gain.value = MUSIC_GAIN;

      noiseBandpass.type = 'bandpass';
      noiseBandpass.frequency.value = NOISE_BANDPASS_HZ;
      noiseBandpass.Q.value = NOISE_BANDPASS_Q;
      noiseGain.gain.value = NOISE_GAIN;

      source.connect(musicHighpass);
      musicHighpass.connect(musicLowpass);
      musicLowpass.connect(musicMidPeak);
      musicMidPeak.connect(musicSaturation);
      musicSaturation.connect(musicCompressor);
      musicCompressor.connect(musicWobble);
      musicWobble.connect(musicGain);
      musicGain.connect(audioCtx.destination);
      musicWobbleOscillator.connect(musicWobbleDepth);
      musicWobbleDepth.connect(musicWobble.gain);

      noiseSource.connect(noiseBandpass);
      noiseBandpass.connect(noiseGain);
      noiseGain.connect(audioCtx.destination);

      const session: HoldMusicSession = {
        audio,
        source,
        musicHighpass,
        musicLowpass,
        musicMidPeak,
        musicSaturation,
        musicCompressor,
        musicWobble,
        musicWobbleOscillator,
        musicWobbleDepth,
        musicGain,
        noiseSource,
        noiseBandpass,
        noiseGain,
        started: false,
        stopped: false,
        onMetadata: () => {
          this.beginSession(session);
        },
      };
      this.session = session;

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
    if (!session) return;
    session.stopped = true;

    try {
      session.audio.removeEventListener('loadedmetadata', session.onMetadata);
      session.audio.removeEventListener('durationchange', session.onMetadata);
      session.audio.pause();
      session.audio.removeAttribute('src');
      session.audio.load();
    } catch {
      // best-effort cleanup
    }

    try {
      session.noiseSource.stop();
    } catch {
      // already stopped or never started
    }

    try {
      session.musicWobbleOscillator.stop();
    } catch {
      // already stopped or never started
    }

    for (const node of [
      session.source,
      session.musicHighpass,
      session.musicLowpass,
      session.musicMidPeak,
      session.musicSaturation,
      session.musicCompressor,
      session.musicWobble,
      session.musicWobbleOscillator,
      session.musicWobbleDepth,
      session.musicGain,
      session.noiseSource,
      session.noiseBandpass,
      session.noiseGain,
    ]) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
  }

  private beginSession(session: HoldMusicSession): void {
    if (this.session !== session || session.stopped || session.started) return;
    if (!hasKnownDuration(session.audio)) return;

    session.started = true;
    session.audio.currentTime = pickRandomStartTime(session.audio.duration);
    session.musicWobbleOscillator.start(0);
    session.noiseSource.start(0);
    void session.audio.play().catch(() => {
      this.stop();
    });
  }
}

export function pickHoldMusicUrl(random: () => number = Math.random): string {
  const index = Math.min(
    HOLD_MUSIC_TRACKS.length - 1,
    Math.floor(random() * HOLD_MUSIC_TRACKS.length),
  );
  return `/music/${encodeURIComponent(HOLD_MUSIC_TRACKS[index])}`;
}

export function pickRandomStartTime(duration: number, random: () => number = Math.random): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.001;
  const fraction = 0.15 + random() * 0.35;
  return Math.max(0.001, Math.min(duration - 0.001, duration * fraction));
}

function hasKnownDuration(audio: HTMLAudioElement): boolean {
  return Number.isFinite(audio.duration) && audio.duration > 0;
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

export function generateRadioStaticSamples({
  sampleRate,
  durationSeconds = NOISE_BUFFER_SECONDS,
  random = Math.random,
}: RadioStaticOptions): Float32Array {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const length = Math.max(1, Math.floor(safeSampleRate * Math.max(0.001, durationSeconds)));
  const samples = new Float32Array(length);
  const lowCutCoeff = 1 - Math.exp((-2 * Math.PI * STATIC_LOW_CUT_HZ) / safeSampleRate);
  const highCutCoeff = 1 - Math.exp((-2 * Math.PI * STATIC_HIGH_CUT_HZ) / safeSampleRate);
  const crackleChance = STATIC_CRACKLES_PER_SECOND / safeSampleRate;
  const flutterPhaseA = random() * Math.PI * 2;
  const flutterPhaseB = random() * Math.PI * 2;

  let lowCutState = 0;
  let highCutState = 0;
  let crackle = 0;

  for (let i = 0; i < length; i += 1) {
    const t = i / safeSampleRate;
    const white = random() * 2 - 1;
    lowCutState += lowCutCoeff * (white - lowCutState);
    highCutState += highCutCoeff * (white - lowCutState - highCutState);

    if (random() < crackleChance) {
      const polarity = random() < 0.5 ? -1 : 1;
      crackle += polarity * (0.42 + random() * 0.5);
    }
    crackle *= 0.82;

    const flutter =
      1 -
      STATIC_FLUTTER_DEPTH * 0.5 +
      Math.sin(t * Math.PI * 2 * 0.19 + flutterPhaseA) * STATIC_FLUTTER_DEPTH * 0.34 +
      Math.sin(t * Math.PI * 2 * 0.071 + flutterPhaseB) * STATIC_FLUTTER_DEPTH * 0.16;
    const sample = (highCutState * 0.82 + crackle * 0.18) * flutter * STATIC_GAIN;
    samples[i] = clamp(sample, -0.92, 0.92);
  }

  return samples;
}

export function createGentleSaturationCurve(
  length = 256,
  amount = 1.8,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(Math.max(2, length));
  const normalizer = Math.tanh(amount);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / normalizer;
  }
  return curve;
}

function createNoiseSource(audioCtx: AudioContext): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor((audioCtx.sampleRate || 48000) * NOISE_BUFFER_SECONDS));
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate || 48000);
  const samples = buffer.getChannelData(0);
  samples.set(generateRadioStaticSamples({ sampleRate: audioCtx.sampleRate || 48000 }));
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
