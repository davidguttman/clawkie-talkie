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
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
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
    expect(ctx.biquads[0].frequency.value).toBeGreaterThan(0);
    expect(ctx.mediaElementSources[0].connect).toHaveBeenCalledWith(ctx.biquads[0]);
    expect(ctx.biquads[0].connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.gains[1].gain.value).toBeLessThan(0.02);
    expect(ctx.bufferSources[0].loop).toBe(true);
    expect(ctx.bufferSources[0].start).toHaveBeenCalledWith(0);

    controller.stop();

    expect(audio.pause).toHaveBeenCalled();
    expect(ctx.bufferSources[0].stop).toHaveBeenCalled();
    expect(ctx.mediaElementSources[0].disconnect).toHaveBeenCalled();
  });
});
