import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeAudioParam {
  value = 0;
  setValueAtTime = vi.fn((value: number) => {
    this.value = value;
    return this;
  });
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

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  frequencyBinCount = 1024;
  minDecibels = -100;
  maxDecibels = -30;
}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
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
  static audioWorkletAddModule: ReturnType<typeof vi.fn> | null = null;

  state: AudioContextState = 'suspended';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  audioWorklet?: { addModule: ReturnType<typeof vi.fn> };
  mediaElementSources: FakeMediaElementSourceNode[] = [];
  biquads: FakeBiquadFilterNode[] = [];
  gains: FakeGainNode[] = [];
  waveShapers: FakeWaveShaperNode[] = [];
  compressors: FakeDynamicsCompressorNode[] = [];
  oscillators: FakeOscillatorNode[] = [];
  bufferSources: FakeAudioBufferSourceNode[] = [];
  analysers: FakeAnalyserNode[] = [];
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });

  constructor() {
    if (FakeAudioContext.audioWorkletAddModule) {
      this.audioWorklet = { addModule: FakeAudioContext.audioWorkletAddModule };
    }
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

  createAnalyser(): FakeAnalyserNode {
    const analyser = new FakeAnalyserNode();
    this.analysers.push(analyser);
    return analyser;
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static instances: FakeAudioWorkletNode[] = [];

  parameters = new Map([
    ['bits', new FakeAudioParam()],
    ['normFreq', new FakeAudioParam()],
  ]);

  constructor(
    public context: AudioContext,
    public name: string,
  ) {
    super();
    FakeAudioWorkletNode.instances.push(this);
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
  FakeAudioContext.audioWorkletAddModule = null;
  FakeAudioWorkletNode.instances = [];
  FakeAudioElement.instances = [];
});

describe('hold music selection', () => {
  it('uses encoded public music URLs and never picks an out-of-range track', async () => {
    const { pickHoldMusicUrl } = await import('../client/src/voice/holdMusic');

    expect(pickHoldMusicUrl(() => 0)).toBe('/music/Dial%20Tone%20Reverie.mp3');
    expect(pickHoldMusicUrl(() => 6 / 11)).toBe('/music/Pehli%20Dastak.mp3');
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
  it('creates separate dense hiss and sparse impulse crackle buffers', async () => {
    const { generateRadioCrackleSamples, generateRadioHissSamples } = await import(
      '../client/src/voice/holdMusic'
    );
    const hiss = generateRadioHissSamples({
      sampleRate: 8000,
      durationSeconds: 2,
      random: seededRandom(12345),
    });
    const crackle = generateRadioCrackleSamples({
      sampleRate: 8000,
      durationSeconds: 2,
      random: seededRandom(12345),
    });

    expect(hiss).toHaveLength(16000);
    expect(crackle).toHaveLength(16000);
    expect(hiss).not.toEqual(crackle);
    expect(countSamplesAbove(hiss, 0)).toBeGreaterThan(15000);
    expect(countSamplesAbove(crackle, 0)).toBeGreaterThan(0);
    expect(countSamplesAbove(crackle, 0)).toBeLessThan(40);
    expect(countSamplesAbove(crackle, 0.25)).toBe(countSamplesAbove(crackle, 0));
  });

  it('builds the AM-IFY drive saturation curve', async () => {
    const { createAmifySaturationCurve } = await import('../client/src/voice/holdMusic');

    const curve = createAmifySaturationCurve(9, 0.5);

    expect(curve).toHaveLength(9);
    expect(curve[0]).toBeCloseTo(-0.348128);
    expect(curve[4]).toBeCloseTo(0);
    expect(curve[8]).toBeCloseTo(0.348128);
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
    expect(ctx.biquads[0].frequency.value).toBe(300);
    expect(ctx.biquads[1].type).toBe('lowpass');
    expect(ctx.biquads[1].frequency.value).toBe(4500);
    expect(ctx.biquads[2].type).toBe('peaking');
    expect(ctx.biquads[2].frequency.value).toBe(1500);
    expect(ctx.biquads[2].gain.value).toBe(5);
    expect(ctx.biquads[2].Q.value).toBe(1.2);
    expect(ctx.waveShapers[0].curve).toBeInstanceOf(Float32Array);
    expect(ctx.waveShapers[0].oversample).toBe('4x');
    expect(ctx.compressors[0].threshold.value).toBe(-24);
    expect(ctx.compressors[0].ratio.value).toBe(8);
    expect(ctx.compressors[0].attack.value).toBe(0.003);
    expect(ctx.compressors[0].release.value).toBe(0.1);
    expect(ctx.gains[1].gain.value).toBe(1);
    expect(ctx.gains[2].gain.value).toBeCloseTo(0.05);
    expect(ctx.gains[3].gain.value).toBeCloseTo(0.15);
    expect(ctx.oscillators[0].type).toBe('sine');
    expect(ctx.oscillators[0].frequency.value).toBeCloseTo(0.4);
    expect(ctx.biquads[3].type).toBe('highpass');
    expect(ctx.biquads[3].frequency.value).toBe(300);
    expect(ctx.biquads[4].type).toBe('lowpass');
    expect(ctx.biquads[4].frequency.value).toBe(4500);
    expect(ctx.biquads[5].type).toBe('peaking');
    expect(ctx.biquads[5].frequency.value).toBe(2000);
    expect(ctx.biquads[5].gain.value).toBe(5);
    expect(ctx.mediaElementSources[0].connect).toHaveBeenCalledWith(ctx.biquads[0]);
    expect(ctx.biquads[0].connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.biquads[1]);
    expect(ctx.biquads[1].connect).toHaveBeenCalledWith(ctx.biquads[2]);
    expect(ctx.biquads[2].connect).toHaveBeenCalledWith(ctx.waveShapers[0]);
    expect(ctx.waveShapers[0].connect).toHaveBeenCalledWith(ctx.compressors[0]);
    expect(ctx.compressors[0].connect).toHaveBeenCalledWith(ctx.gains[1]);
    expect(ctx.gains[1].connect).toHaveBeenCalledWith(ctx.gains[3]);
    expect(ctx.gains[3].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.oscillators[0].connect).toHaveBeenCalledWith(ctx.gains[2]);
    expect(ctx.gains[2].connect).toHaveBeenCalledWith(ctx.gains[1].gain);
    expect(ctx.bufferSources[0].connect).toHaveBeenCalledWith(ctx.biquads[3]);
    expect(ctx.bufferSources[1].connect).toHaveBeenCalledWith(ctx.biquads[3]);
    expect(ctx.biquads[3].connect).toHaveBeenCalledWith(ctx.biquads[4]);
    expect(ctx.biquads[4].connect).toHaveBeenCalledWith(ctx.biquads[5]);
    expect(ctx.biquads[5].connect).toHaveBeenCalledWith(ctx.gains[4]);
    expect(ctx.gains[4].gain.value).toBeCloseTo(0.001);
    expect(ctx.gains[4].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.bufferSources[0].buffer).not.toBe(ctx.bufferSources[1].buffer);
    expect(countSamplesAbove(ctx.bufferSources[0].buffer?.getChannelData(0) ?? new Float32Array(), 0))
      .toBeGreaterThan(90000);
    expect(countSamplesAbove(ctx.bufferSources[1].buffer?.getChannelData(0) ?? new Float32Array(), 0))
      .toBeLessThan(200);
    expect(ctx.bufferSources[0].loop).toBe(true);
    expect(ctx.bufferSources[1].loop).toBe(true);
    expect(ctx.oscillators[0].start).toHaveBeenCalledWith(0);
    expect(ctx.bufferSources[0].start).toHaveBeenCalledWith(0);
    expect(ctx.bufferSources[1].start).toHaveBeenCalledWith(0);

    controller.stop();

    expect(audio.pause).toHaveBeenCalled();
    expect(ctx.bufferSources[0].stop).toHaveBeenCalled();
    expect(ctx.bufferSources[1].stop).toHaveBeenCalled();
    expect(ctx.oscillators[0].stop).toHaveBeenCalled();
    expect(ctx.mediaElementSources[0].disconnect).toHaveBeenCalled();
  });

  it('loads the bitcrusher worklet and inserts it before the music lowpass when supported', async () => {
    const addModule = vi.fn(() => Promise.resolve());
    FakeAudioContext.audioWorkletAddModule = addModule;
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');

    const controller = new HoldMusicController();
    controller.start();
    await flushPromises();

    const ctx = FakeAudioContext.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];
    expect(addModule).toHaveBeenCalledWith('/audio/bitcrusher-processor.js');
    expect(worklet.name).toBe('hold-music-bitcrusher');
    expect(worklet.parameters.get('bits')?.value).toBe(8);
    expect(worklet.parameters.get('normFreq')?.value).toBe(0.4);
    expect(ctx.biquads[0].disconnect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].disconnect).toHaveBeenCalledWith(ctx.biquads[1]);
    expect(ctx.biquads[0].connect).toHaveBeenCalledWith(worklet);
    expect(worklet.connect).toHaveBeenCalledWith(ctx.biquads[1]);

    controller.stop();
    expect(worklet.disconnect).toHaveBeenCalled();
  });

  it('exposes a hold music analyser tapped from the music bed and clears it on stop', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, getActiveHoldMusicAnalyser } = await import(
      '../client/src/voice/holdMusic'
    );

    expect(getActiveHoldMusicAnalyser()).toBeNull();

    const controller = new HoldMusicController();
    controller.start();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.analysers).toHaveLength(1);
    const analyser = ctx.analysers[0];
    expect(analyser.fftSize).toBe(64);
    expect(analyser.smoothingTimeConstant).toBeCloseTo(0.1);
    expect(analyser.minDecibels).toBe(-90);
    expect(analyser.maxDecibels).toBe(-10);
    expect(ctx.gains[3].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.gains[3].connect).toHaveBeenCalledWith(analyser);
    expect(getActiveHoldMusicAnalyser()).toBe(analyser as unknown as AnalyserNode);

    controller.stop();

    expect(analyser.disconnect).toHaveBeenCalled();
    expect(getActiveHoldMusicAnalyser()).toBeNull();
  });

  it('keeps the fallback bitcrusher slot when the worklet fails to load', async () => {
    const addModule = vi.fn(() => Promise.reject(new Error('no worklet')));
    FakeAudioContext.audioWorkletAddModule = addModule;
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');

    const controller = new HoldMusicController();
    controller.start();
    const ctx = FakeAudioContext.instances[0];
    const audio = FakeAudioElement.instances[0];
    audio.duration = 100;
    audio.dispatch('loadedmetadata');
    await flushPromises();

    expect(addModule).toHaveBeenCalledWith('/audio/bitcrusher-processor.js');
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(ctx.biquads[0].connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.biquads[1]);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function countSamplesAbove(samples: Float32Array, threshold: number): number {
  let count = 0;
  for (const sample of samples) {
    if (Math.abs(sample) > threshold) count += 1;
  }
  return count;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
