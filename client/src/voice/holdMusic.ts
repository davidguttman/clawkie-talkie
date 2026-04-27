import { HOLD_MUSIC_TRACKS } from 'virtual:hold-music-tracks';

const MUSIC_GAIN = 0.15;
const NOISE_TO_MUSIC_RATIO = 0.04;
const NOISE_GAIN = MUSIC_GAIN * NOISE_TO_MUSIC_RATIO;
const MUSIC_HIGHPASS_HZ = 300;
const MUSIC_LOWPASS_HZ = 4500;
const MUSIC_MIDRANGE_HZ = 1500;
const MUSIC_MIDRANGE_GAIN_DB = 5;
const MUSIC_MIDRANGE_Q = 1.2;
const MUSIC_SATURATION_DRIVE = 0.35;
const MUSIC_WOBBLE_HZ = 0.4;
const MUSIC_WOBBLE_DEPTH = 0.05;
const NOISE_FREQ_HZ = 2000;
const NOISE_BUFFER_SECONDS = 2;
const CRACKLES_PER_SECOND = 5;
const CRACKLE_MIN_AMPLITUDE = 0.28;
const CRACKLE_EXTRA_AMPLITUDE = 0.22;
const BITCRUSHER_WORKLET_URL = '/audio/bitcrusher-processor.js';
const BITCRUSHER_PROCESSOR_NAME = 'hold-music-bitcrusher';
const BITCRUSHER_BITS = 8;
const BITCRUSHER_NORM_FREQ = 0.4;
const HOLD_MUSIC_FFT_SIZE = 512;
const HOLD_MUSIC_SMOOTHING = 0.45;

let sharedAudioCtx: AudioContext | null = null;
let activeHoldMusicAnalyser: AnalyserNode | null = null;

export function getActiveHoldMusicAnalyser(): AnalyserNode | null {
  return activeHoldMusicAnalyser;
}

interface HoldMusicSession {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  musicHighpass: BiquadFilterNode;
  musicBitcrusher: AudioNode;
  musicLowpass: BiquadFilterNode;
  musicMidPeak: BiquadFilterNode;
  musicSaturation: WaveShaperNode;
  musicCompressor: DynamicsCompressorNode;
  musicWobble: GainNode;
  musicWobbleOscillator: OscillatorNode;
  musicWobbleDepth: GainNode;
  musicGain: GainNode;
  musicAnalyser: AnalyserNode | null;
  hissSource: AudioBufferSourceNode;
  crackleSource: AudioBufferSourceNode;
  noiseHighpass: BiquadFilterNode;
  noiseLowpass: BiquadFilterNode;
  noiseMidPeak: BiquadFilterNode;
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
      const musicBitcrusher = audioCtx.createGain();
      const musicLowpass = audioCtx.createBiquadFilter();
      const musicMidPeak = audioCtx.createBiquadFilter();
      const musicSaturation = audioCtx.createWaveShaper();
      const musicCompressor = audioCtx.createDynamicsCompressor();
      const musicWobble = audioCtx.createGain();
      const musicWobbleOscillator = audioCtx.createOscillator();
      const musicWobbleDepth = audioCtx.createGain();
      const musicGain = audioCtx.createGain();
      const hissSource = createHissSource(audioCtx);
      const crackleSource = createCrackleSource(audioCtx);
      const noiseHighpass = audioCtx.createBiquadFilter();
      const noiseLowpass = audioCtx.createBiquadFilter();
      const noiseMidPeak = audioCtx.createBiquadFilter();
      const noiseGain = audioCtx.createGain();
      let session: HoldMusicSession;

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

      musicSaturation.curve = createAmifySaturationCurve();
      musicSaturation.oversample = '4x';

      musicCompressor.threshold.value = -24;
      musicCompressor.knee.value = 18;
      musicCompressor.ratio.value = 8;
      musicCompressor.attack.value = 0.003;
      musicCompressor.release.value = 0.1;

      musicWobble.gain.value = 1;
      musicWobbleOscillator.type = 'sine';
      musicWobbleOscillator.frequency.value = MUSIC_WOBBLE_HZ;
      musicWobbleDepth.gain.value = MUSIC_WOBBLE_DEPTH;
      musicGain.gain.value = MUSIC_GAIN;

      noiseHighpass.type = 'highpass';
      noiseHighpass.frequency.value = MUSIC_HIGHPASS_HZ;
      noiseHighpass.Q.value = 0.8;

      noiseLowpass.type = 'lowpass';
      noiseLowpass.frequency.value = MUSIC_LOWPASS_HZ;
      noiseLowpass.Q.value = 0.7;

      noiseMidPeak.type = 'peaking';
      noiseMidPeak.frequency.value = NOISE_FREQ_HZ;
      noiseMidPeak.Q.value = MUSIC_MIDRANGE_Q;
      noiseMidPeak.gain.value = MUSIC_MIDRANGE_GAIN_DB;

      noiseGain.gain.value = NOISE_GAIN;

      source.connect(musicHighpass);
      musicHighpass.connect(musicBitcrusher);
      musicBitcrusher.connect(musicLowpass);
      musicLowpass.connect(musicMidPeak);
      musicMidPeak.connect(musicSaturation);
      musicSaturation.connect(musicCompressor);
      musicCompressor.connect(musicWobble);
      musicWobble.connect(musicGain);
      musicGain.connect(audioCtx.destination);
      const musicAnalyser = createHoldMusicAnalyser(audioCtx);
      if (musicAnalyser) {
        try {
          musicGain.connect(musicAnalyser);
        } catch {
          // analyser tap is best-effort; never block playback
        }
      }
      musicWobbleOscillator.connect(musicWobbleDepth);
      musicWobbleDepth.connect(musicWobble.gain);

      hissSource.connect(noiseHighpass);
      crackleSource.connect(noiseHighpass);
      noiseHighpass.connect(noiseLowpass);
      noiseLowpass.connect(noiseMidPeak);
      noiseMidPeak.connect(noiseGain);
      noiseGain.connect(audioCtx.destination);

      void installBitcrusherWorklet(
        audioCtx,
        musicHighpass,
        musicBitcrusher,
        musicLowpass,
        () => this.session === session && !session.stopped,
      ).then((workletNode) => {
        if (workletNode && this.session === session && !session.stopped) {
          session.musicBitcrusher = workletNode;
        }
      });

      session = {
        audio,
        source,
        musicHighpass,
        musicBitcrusher,
        musicLowpass,
        musicMidPeak,
        musicSaturation,
        musicCompressor,
        musicWobble,
        musicWobbleOscillator,
        musicWobbleDepth,
        musicGain,
        musicAnalyser,
        hissSource,
        crackleSource,
        noiseHighpass,
        noiseLowpass,
        noiseMidPeak,
        noiseGain,
        started: false,
        stopped: false,
        onMetadata: () => {
          this.beginSession(session);
        },
      };
      this.session = session;
      activeHoldMusicAnalyser = musicAnalyser;

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
    if (session.musicAnalyser && activeHoldMusicAnalyser === session.musicAnalyser) {
      activeHoldMusicAnalyser = null;
    }

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
      session.hissSource.stop();
    } catch {
      // already stopped or never started
    }

    try {
      session.crackleSource.stop();
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
      session.musicBitcrusher,
      session.musicLowpass,
      session.musicMidPeak,
      session.musicSaturation,
      session.musicCompressor,
      session.musicWobble,
      session.musicWobbleOscillator,
      session.musicWobbleDepth,
      session.musicGain,
      session.musicAnalyser,
      session.hissSource,
      session.crackleSource,
      session.noiseHighpass,
      session.noiseLowpass,
      session.noiseMidPeak,
      session.noiseGain,
    ]) {
      if (!node) continue;
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
    session.hissSource.start(0);
    session.crackleSource.start(0);
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
    return analyser;
  } catch {
    return null;
  }
}

function createHissSource(audioCtx: AudioContext): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor((audioCtx.sampleRate || 48000) * NOISE_BUFFER_SECONDS));
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate || 48000);
  const samples = buffer.getChannelData(0);
  samples.set(generateRadioHissSamples({ sampleRate: audioCtx.sampleRate || 48000 }));
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

function createCrackleSource(audioCtx: AudioContext): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor((audioCtx.sampleRate || 48000) * NOISE_BUFFER_SECONDS));
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate || 48000);
  const samples = buffer.getChannelData(0);
  samples.set(generateRadioCrackleSamples({ sampleRate: audioCtx.sampleRate || 48000 }));
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

async function installBitcrusherWorklet(
  audioCtx: AudioContext,
  upstream: AudioNode,
  fallback: AudioNode,
  downstream: AudioNode,
  shouldInstall: () => boolean,
): Promise<AudioWorkletNode | null> {
  if (!audioCtx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;

  try {
    await audioCtx.audioWorklet.addModule(BITCRUSHER_WORKLET_URL);
    if (!shouldInstall()) return null;

    const workletNode = new AudioWorkletNode(audioCtx, BITCRUSHER_PROCESSOR_NAME);
    workletNode.parameters.get('bits')?.setValueAtTime(BITCRUSHER_BITS, audioCtx.currentTime);
    workletNode.parameters
      .get('normFreq')
      ?.setValueAtTime(BITCRUSHER_NORM_FREQ, audioCtx.currentTime);

    upstream.disconnect(fallback);
    fallback.disconnect(downstream);
    upstream.connect(workletNode);
    workletNode.connect(downstream);
    return workletNode;
  } catch {
    return null;
  }
}
