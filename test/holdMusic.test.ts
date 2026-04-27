import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeAudioParam {
  value = 0;
}

class FakeAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  gain = new FakeAudioParam();
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam();
  knee = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  start = vi.fn();
  stop = vi.fn();
}

class FakeMediaElementSourceNode extends FakeAudioNode {}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioBuffer {
  private channel: Float32Array;

  constructor(length: number) {
    this.channel = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.channel;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'suspended';
  sampleRate = 48000;
  destination = {};
  mediaElementSources: FakeMediaElementSourceNode[] = [];
  biquads: FakeBiquadFilterNode[] = [];
  gains: FakeGainNode[] = [];
  waveShapers: FakeWaveShaperNode[] = [];
  compressors: FakeDynamicsCompressorNode[] = [];
  oscillators: FakeOscillatorNode[] = [];
  bufferSources: FakeAudioBufferSourceNode[] = [];
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaElementSource(): FakeMediaElementSourceNode {
    const source = new FakeMediaElementSourceNode();
    this.mediaElementSources.push(source);
    return source;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const filter = new FakeBiquadFilterNode();
    this.biquads.push(filter);
    return filter;
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createWaveShaper(): FakeWaveShaperNode {
    const shaper = new FakeWaveShaperNode();
    this.waveShapers.push(shaper);
    return shaper;
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    const compressor = new FakeDynamicsCompressorNode();
    this.compressors.push(compressor);
    return compressor;
  }

  createOscillator(): FakeOscillatorNode {
    const oscillator = new FakeOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBuffer(_channels: number, length: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length);
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    const source = new FakeAudioBufferSourceNode();
    this.bufferSources.push(source);
    return source;
  }
}

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];

  currentTime = 0;
  duration = Number.NaN;
  loop = false;
  preload = '';
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  private listeners = new Map<string, Set<() => void>>();

  constructor(public src: string) {
    FakeAudioElement.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeAudioContext.instances = [];
  FakeAudioElement.instances = [];
});

describe('hold music selection', () => {
  it('uses encoded public music URLs and never picks an out-of-range track', async () => {
    const { pickHoldMusicUrl } = await import('../client/src/voice/holdMusic');

    expect(pickHoldMusicUrl(() => 0)).toBe('/music/Dial%20Tone%20Reverie.mp3');
    expect(pickHoldMusicUrl(() => 0.999)).toBe('/music/Soft%20Hold%20Tone.mp3');
  });

  it('starts between 15% and 50% of the track duration', async () => {
    const { pickRandomStartTime } = await import('../client/src/voice/holdMusic');

    expect(pickRandomStartTime(100, () => 0)).toBe(15);
    expect(pickRandomStartTime(100, () => 1)).toBe(50);
    expect(pickRandomStartTime(100, () => 0.5)).toBeCloseTo(32.5);
  });
});

describe('radio static generation', () => {
  it('creates deterministic fluttering static with bounded crackles', async () => {
    const { generateRadioStaticSamples } = await import('../client/src/voice/holdMusic');
    const random = seededRandom(12345);
    const samples = generateRadioStaticSamples({
      sampleRate: 8000,
      durationSeconds: 2,
      random,
    });

    expect(samples).toHaveLength(16000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.92);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-0.92);
    expect(countSamplesAbove(samples, 0.35)).toBeGreaterThan(0);

    const windowRms = [
      rms(samples.slice(0, 2000)),
      rms(samples.slice(2000, 4000)),
      rms(samples.slice(4000, 6000)),
      rms(samples.slice(6000, 8000)),
    ];
    expect(Math.max(...windowRms) - Math.min(...windowRms)).toBeGreaterThan(0.01);
  });

  it('builds a symmetrical gentle saturation curve', async () => {
    const { createGentleSaturationCurve } = await import('../client/src/voice/holdMusic');

    const curve = createGentleSaturationCurve(9, 1.8);

    expect(curve).toHaveLength(9);
    expect(curve[0]).toBeCloseTo(-1);
    expect(curve[4]).toBeCloseTo(0);
    expect(curve[8]).toBeCloseTo(1);
    expect(curve[2]).toBeCloseTo(-curve[6]);
  });
});

describe('HoldMusicController', () => {
  it('waits for metadata, seeks into the middle of the track, loops, and routes through Web Audio', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');

    const controller = new HoldMusicController();
    controller.start();

    const ctx = FakeAudioContext.instances[0];
    const audio = FakeAudioElement.instances[0];
    expect(audio.loop).toBe(true);
    expect(audio.preload).toBe('auto');
    expect(audio.play).not.toHaveBeenCalled();

    audio.duration = 100;
    audio.dispatch('loadedmetadata');

    expect(audio.currentTime).toBeGreaterThanOrEqual(15);
    expect(audio.currentTime).toBeLessThanOrEqual(50);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(ctx.mediaElementSources).toHaveLength(1);
    expect(ctx.biquads[0].type).toBe('highpass');
    expect(ctx.biquads[0].frequency.value).toBe(320);
    expect(ctx.biquads[1].type).toBe('lowpass');
    expect(ctx.biquads[1].frequency.value).toBe(3600);
    expect(ctx.biquads[2].type).toBe('peaking');
    expect(ctx.biquads[2].frequency.value).toBe(1500);
    expect(ctx.biquads[2].gain.value).toBe(6);
    expect(ctx.biquads[2].Q.value).toBe(1.2);
    expect(ctx.waveShapers[0].curve).toBeInstanceOf(Float32Array);
    expect(ctx.waveShapers[0].oversample).toBe('2x');
    expect(ctx.compressors[0].threshold.value).toBe(-24);
    expect(ctx.gains[0].gain.value).toBe(1);
    expect(ctx.gains[1].gain.value).toBeCloseTo(0.045);
    expect(ctx.gains[2].gain.value).toBeCloseTo(0.15);
    expect(ctx.oscillators[0].type).toBe('sine');
    expect(ctx.oscillators[0].frequency.value).toBeCloseTo(0.13);
    expect(ctx.biquads[3].type).toBe('bandpass');
    expect(ctx.biquads[3].frequency.value).toBe(2000);
    expect(ctx.biquads[3].Q.value).toBe(0.5);
    expect(ctx.mediaElementSources[0].connect).toHaveBeenCalledWith(ctx.biquads[0]);
    expect(ctx.biquads[0].connect).toHaveBeenCalledWith(ctx.biquads[1]);
    expect(ctx.biquads[1].connect).toHaveBeenCalledWith(ctx.biquads[2]);
    expect(ctx.biquads[2].connect).toHaveBeenCalledWith(ctx.waveShapers[0]);
    expect(ctx.waveShapers[0].connect).toHaveBeenCalledWith(ctx.compressors[0]);
    expect(ctx.compressors[0].connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.gains[2]);
    expect(ctx.gains[2].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.oscillators[0].connect).toHaveBeenCalledWith(ctx.gains[1]);
    expect(ctx.gains[1].connect).toHaveBeenCalledWith(ctx.gains[0].gain);
    expect(ctx.bufferSources[0].connect).toHaveBeenCalledWith(ctx.biquads[3]);
    expect(ctx.biquads[3].connect).toHaveBeenCalledWith(ctx.gains[3]);
    expect(ctx.gains[3].gain.value).toBeCloseTo(0.035);
    expect(ctx.gains[3].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.bufferSources[0].loop).toBe(true);
    expect(ctx.oscillators[0].start).toHaveBeenCalledWith(0);
    expect(ctx.bufferSources[0].start).toHaveBeenCalledWith(0);

    controller.stop();

    expect(audio.pause).toHaveBeenCalled();
    expect(ctx.bufferSources[0].stop).toHaveBeenCalled();
    expect(ctx.oscillators[0].stop).toHaveBeenCalled();
    expect(ctx.mediaElementSources[0].disconnect).toHaveBeenCalled();
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function rms(samples: Float32Array): number {
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}

function countSamplesAbove(samples: Float32Array, threshold: number): number {
  let count = 0;
  for (const sample of samples) {
    if (Math.abs(sample) > threshold) count += 1;
  }
  return count;
}
