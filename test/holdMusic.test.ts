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

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

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

class FakeMediaElementSourceNode extends FakeAudioNode {
  constructor(public element: FakeAudioElement) {
    super();
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'suspended';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  mediaElementSources: FakeMediaElementSourceNode[] = [];
  gains: FakeGainNode[] = [];
  bufferSources: FakeAudioBufferSourceNode[] = [];
  analysers: FakeAnalyserNode[] = [];
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaElementSource(audio: FakeAudioElement): FakeMediaElementSourceNode {
    const source = new FakeMediaElementSourceNode(audio);
    this.mediaElementSources.push(source);
    return source;
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

  createAnalyser(): FakeAnalyserNode {
    const analyser = new FakeAnalyserNode();
    this.analysers.push(analyser);
    return analyser;
  }
}

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];

  currentTime = 0;
  duration = Number.NaN;
  loop = false;
  muted = false;
  preload = '';
  volume = 1;
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
  vi.doUnmock('virtual:hold-music-tracks');
  vi.resetModules();
  FakeAudioContext.instances = [];
  FakeAudioElement.instances = [];
});

describe('hold music selection', () => {
  it('uses encoded public music URLs and never picks an out-of-range track', async () => {
    const { pickHoldMusicUrl } = await import('../client/src/voice/holdMusic');

    expect(pickHoldMusicUrl(() => 0)).toBe('/music/Dial%20Tone%20Reverie.mp3');
    expect(pickHoldMusicUrl(() => 6 / 11)).toBe('/music/Pehli%20Dastak.mp3');
    expect(pickHoldMusicUrl(() => 0.999)).toBe('/music/Soft%20Hold%20Tone.mp3');
    expect(pickHoldMusicUrl(() => 0, {
      muted: false,
      effects: false,
      disabledTracks: [],
    })).toBe('/music-original/Dial%20Tone%20Reverie.mp3');
  });


  it('skips disabled songs and returns an empty URL when every song is off', async () => {
    const { getHoldMusicTracks } = await import('../client/src/voice/holdMusicCatalog');
    const { pickHoldMusicUrl } = await import('../client/src/voice/holdMusic');
    const tracks = getHoldMusicTracks();

    expect(pickHoldMusicUrl(() => 0, {
      muted: false,
      effects: true,
      disabledTracks: [tracks[0]],
    })).toBe('/music/Dockside%20Hold.mp3');
    expect(pickHoldMusicUrl(() => 0.999, {
      muted: false,
      effects: true,
      disabledTracks: [...tracks],
    })).toBe('');
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

  it('builds the AM-IFY drive saturation curve used by the regeneration script design', async () => {
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
  it('preloads exactly one shuffled next track when the module loads', async () => {
    vi.stubGlobal('Audio', FakeAudioElement);

    await import('../client/src/voice/holdMusic');

    expect(FakeAudioElement.instances).toHaveLength(1);
    const audio = FakeAudioElement.instances[0];
    expect(audio.src).toMatch(/^\/music\/.+\.mp3$/);
    expect(audio.preload).toBe('auto');
    expect(audio.load).toHaveBeenCalledTimes(1);
  });

  it('plays the processed music and static layers as plain media elements', async () => {
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');
    const preloaded = FakeAudioElement.instances[0];

    const controller = new HoldMusicController();
    controller.start();

    expect(FakeAudioElement.instances).toHaveLength(3);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(preloaded.loop).toBe(true);
    expect(preloaded.preload).toBe('auto');
    expect(preloaded.volume).toBeCloseTo(0.15);
    expect(FakeAudioElement.instances[1].src).toBe('/music-layers/hiss.mp3');
    expect(FakeAudioElement.instances[1].loop).toBe(true);
    expect(FakeAudioElement.instances[1].volume).toBeCloseTo(0.0045);
    expect(FakeAudioElement.instances[2].src).toBe('/music-layers/crackle.mp3');
    expect(FakeAudioElement.instances[2].loop).toBe(true);
    expect(FakeAudioElement.instances[2].volume).toBeCloseTo(0.0065);
    expect(preloaded.play).not.toHaveBeenCalled();

    preloaded.duration = 100;
    preloaded.dispatch('loadedmetadata');

    expect(preloaded.currentTime).toBeGreaterThanOrEqual(15);
    expect(preloaded.currentTime).toBeLessThanOrEqual(50);
    expect(preloaded.play).toHaveBeenCalledTimes(1);
    expect(FakeAudioElement.instances[1].play).toHaveBeenCalledTimes(1);
    expect(FakeAudioElement.instances[2].play).toHaveBeenCalledTimes(1);

    controller.stop();

    expect(preloaded.pause).toHaveBeenCalled();
    expect(FakeAudioElement.instances[1].pause).toHaveBeenCalled();
    expect(FakeAudioElement.instances[2].pause).toHaveBeenCalled();
    expect(FakeAudioElement.instances).toHaveLength(4);
    expect(FakeAudioElement.instances[3]).not.toBe(preloaded);
    expect(FakeAudioElement.instances[3].preload).toBe('auto');
  });

  it('ignores stale play rejections after a newer session has started', async () => {
    vi.stubGlobal('Audio', FakeAudioElement);
    const firstPlay = createDeferred<void>();
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');
    const firstAudio = FakeAudioElement.instances[0];
    firstAudio.play = vi.fn(() => firstPlay.promise);

    const controller = new HoldMusicController();
    controller.start();
    firstAudio.duration = 100;
    firstAudio.dispatch('loadedmetadata');
    expect(firstAudio.play).toHaveBeenCalledTimes(1);

    controller.start();
    const secondAudio = FakeAudioElement.instances[3];
    secondAudio.duration = 100;
    secondAudio.dispatch('loadedmetadata');
    expect(secondAudio.play).toHaveBeenCalledTimes(1);

    firstPlay.reject(new Error('stale play rejection'));
    await flushPromises();

    expect(secondAudio.pause).not.toHaveBeenCalled();
    expect(secondAudio.removeAttribute).not.toHaveBeenCalled();
  });

  it('does not create preload, playback, or layer audio when the hold music manifest is empty', async () => {
    vi.doMock('virtual:hold-music-tracks', () => ({ HOLD_MUSIC_TRACKS: [] }));
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, pickHoldMusicUrl } = await import('../client/src/voice/holdMusic');

    expect(pickHoldMusicUrl()).toBe('');
    expect(FakeAudioElement.instances).toHaveLength(0);

    const controller = new HoldMusicController();
    expect(() => controller.start()).not.toThrow();
    expect(FakeAudioElement.instances).toHaveLength(0);
  });


  it('does not create preload, playback, or layer audio when every song is disabled', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    storage.set('clawkie.settings.v1', JSON.stringify({
      music: {
        muted: false,
        effects: true,
        disabledTracks: [
          'Dial Tone Reverie.mp3',
          'Dockside Hold.mp3',
          'Looped Hold Tone.mp3',
          'Maré de Espera.mp3',
          'Muted Waiting Room.mp3',
          'Palm Reader Queue.mp3',
          'Paper Cup Loop.mp3',
          'Pehli Dastak.mp3',
          'Pixel Queue.mp3',
          'Poolside Hold.mp3',
          'Rotary Hush.mp3',
          'Shelf Cue Drift.mp3',
          'Soft Hold Tone.mp3',
        ],
      },
    }));
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');

    expect(FakeAudioElement.instances).toHaveLength(0);
    const controller = new HoldMusicController();
    expect(() => controller.start()).not.toThrow();
    expect(FakeAudioElement.instances).toHaveLength(0);
  });

  it('does not create static layers when audio effects are disabled', async () => {
    const storage = new Map<string, string>([[
      'clawkie.settings.v1',
      JSON.stringify({ music: { muted: false, effects: false, disabledTracks: [] } }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController } = await import('../client/src/voice/holdMusic');
    const preloaded = FakeAudioElement.instances[0];

    const controller = new HoldMusicController();
    controller.start();

    expect(FakeAudioElement.instances).toHaveLength(1);
    expect(preloaded.src).toMatch(/^\/music-original\/.+\.mp3$/);
    expect(preloaded.volume).toBeCloseTo(0.15);
    preloaded.duration = 100;
    preloaded.dispatch('loadedmetadata');
    expect(preloaded.play).toHaveBeenCalledTimes(1);
  });


  it('restarts an active session when effects are disabled so processed audio and static layers stop', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, setHoldMusicSettings } = await import('../client/src/voice/holdMusic');

    const controller = new HoldMusicController();
    controller.start();

    const [processedMusic, hiss, crackle] = FakeAudioElement.instances;
    expect(processedMusic.src).toMatch(/^\/music\/.+\.mp3$/);
    expect(hiss.src).toBe('/music-layers/hiss.mp3');
    expect(crackle.src).toBe('/music-layers/crackle.mp3');

    setHoldMusicSettings({ muted: false, effects: false, disabledTracks: [] });

    expect(processedMusic.pause).toHaveBeenCalled();
    expect(hiss.pause).toHaveBeenCalled();
    expect(crackle.pause).toHaveBeenCalled();
    expect(FakeAudioElement.instances).toHaveLength(4);
    expect(FakeAudioElement.instances[3].src).toMatch(/^\/music-original\/.+\.mp3$/);
  });

  it('stops an active session when every song is disabled and resumes when songs return', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { getHoldMusicTracks } = await import('../client/src/voice/holdMusicCatalog');
    const { HoldMusicController, setHoldMusicSettings } = await import('../client/src/voice/holdMusic');
    const tracks = [...getHoldMusicTracks()];

    const controller = new HoldMusicController();
    controller.start();
    const [music, hiss, crackle] = FakeAudioElement.instances;

    setHoldMusicSettings({ muted: false, effects: true, disabledTracks: tracks });

    expect(music.pause).toHaveBeenCalled();
    expect(hiss.pause).toHaveBeenCalled();
    expect(crackle.pause).toHaveBeenCalled();
    expect(FakeAudioElement.instances).toHaveLength(3);

    setHoldMusicSettings({ muted: false, effects: true, disabledTracks: [] });

    expect(FakeAudioElement.instances).toHaveLength(6);
    expect(FakeAudioElement.instances[3].src).toMatch(/^\/music\/.+\.mp3$/);
    expect(FakeAudioElement.instances[4].src).toBe('/music-layers/hiss.mp3');
    expect(FakeAudioElement.instances[5].src).toBe('/music-layers/crackle.mp3');
  });

  it('persists mute preference and applies it to the active music and static media layers', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    storage.set('clawkie.holdMusic.muted.v1', '1');
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, getHoldMusicMuted, setHoldMusicMuted } = await import(
      '../client/src/voice/holdMusic'
    );

    const controller = new HoldMusicController();
    controller.start();

    const [music, hiss, crackle] = FakeAudioElement.instances;
    expect(getHoldMusicMuted()).toBe(true);
    for (const audio of [music, hiss, crackle]) {
      expect(audio.muted).toBe(true);
      expect(audio.volume).toBe(0);
    }

    setHoldMusicMuted(false);

    expect(storage.has('clawkie.holdMusic.muted.v1')).toBe(false);
    expect(music.muted).toBe(false);
    expect(music.volume).toBeCloseTo(0.15);
    expect(hiss.muted).toBe(false);
    expect(hiss.volume).toBeCloseTo(0.0045);
    expect(crackle.muted).toBe(false);
    expect(crackle.volume).toBeCloseTo(0.0065);
  });

  it('notifies mute subscribers for external mute changes', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    const { setHoldMusicMuted, subscribeHoldMusicMuted } = await import('../client/src/voice/holdMusic');
    const listener = vi.fn();

    const unsubscribe = subscribeHoldMusicMuted(listener);
    setHoldMusicMuted(true);
    unsubscribe();
    setHoldMusicMuted(false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('exposes a best-effort analyser without routing audible playback through Web Audio', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, getActiveHoldMusicAnalyser } = await import(
      '../client/src/voice/holdMusic'
    );

    expect(getActiveHoldMusicAnalyser()).toBeNull();

    const controller = new HoldMusicController();
    controller.start();

    const music = FakeAudioElement.instances[0];
    music.duration = 100;
    music.dispatch('loadedmetadata');

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.analysers).toHaveLength(1);
    const analyser = ctx.analysers[0];
    expect(analyser.fftSize).toBe(64);
    expect(analyser.smoothingTimeConstant).toBeCloseTo(0.1);
    expect(analyser.minDecibels).toBe(-90);
    expect(analyser.maxDecibels).toBe(-10);
    expect(ctx.mediaElementSources).toHaveLength(1);
    expect(ctx.mediaElementSources[0].element).not.toBe(music);
    expect(ctx.mediaElementSources[0].connect).toHaveBeenCalledWith(analyser);
    expect(ctx.mediaElementSources[0].connect).not.toHaveBeenCalledWith(ctx.destination);
    expect(getActiveHoldMusicAnalyser()).toBe(analyser as unknown as AnalyserNode);

    controller.stop();

    expect(analyser.disconnect).toHaveBeenCalled();
    expect(getActiveHoldMusicAnalyser()).toBeNull();
  });


  it('does not create the duplicate analyser playback while hold music is muted', async () => {
    const storage = new Map<string, string>([['clawkie.holdMusic.muted.v1', '1']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, getActiveHoldMusicAnalyser } = await import(
      '../client/src/voice/holdMusic'
    );

    const controller = new HoldMusicController();
    controller.start();

    const music = FakeAudioElement.instances[0];
    music.duration = 100;
    music.dispatch('loadedmetadata');

    expect(FakeAudioElement.instances).toHaveLength(3);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getActiveHoldMusicAnalyser()).toBeNull();
  });

  it('stops and clears the hold music analyser when muted during playback', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('Audio', FakeAudioElement);
    const { HoldMusicController, getActiveHoldMusicAnalyser, setHoldMusicMuted } = await import(
      '../client/src/voice/holdMusic'
    );

    const controller = new HoldMusicController();
    controller.start();

    const music = FakeAudioElement.instances[0];
    music.duration = 100;
    music.dispatch('loadedmetadata');

    const ctx = FakeAudioContext.instances[0];
    const source = ctx.mediaElementSources[0];
    const analyser = ctx.analysers[0];
    const analyserAudio = source.element;
    expect(getActiveHoldMusicAnalyser()).toBe(analyser as unknown as AnalyserNode);

    setHoldMusicMuted(true);

    expect(music.muted).toBe(true);
    expect(music.volume).toBe(0);
    expect(FakeAudioElement.instances[1].muted).toBe(true);
    expect(FakeAudioElement.instances[2].muted).toBe(true);
    expect(analyserAudio.pause).toHaveBeenCalled();
    expect(analyserAudio.removeAttribute).toHaveBeenCalledWith('src');
    expect(source.disconnect).toHaveBeenCalled();
    expect(analyser.disconnect).toHaveBeenCalled();
    expect(getActiveHoldMusicAnalyser()).toBeNull();

    setHoldMusicMuted(false);

    expect(getActiveHoldMusicAnalyser()).toBeNull();
    expect(ctx.analysers).toHaveLength(1);
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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
