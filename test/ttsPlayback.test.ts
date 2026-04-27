import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeAudioBuffer {
  duration: number;
  getChannelData: (channel: number) => Float32Array;
}

class FakeAudioParam {
  value = 1;
  setValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
  exponentialRampToValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAnalyserNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData = vi.fn((data: Uint8Array) => {
    data.fill(0);
  });
  getByteTimeDomainData = vi.fn((data: Uint8Array) => {
    data.fill(128);
  });
}

class FakeMediaStreamSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeMediaStream {
  private tracks: Array<{ readyState: 'live' | 'ended' }> = [{ readyState: 'live' }];

  getTracks() {
    return this.tracks;
  }
}

class FakeOscillatorNode {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeBufferSourceNode {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start = vi.fn(() => {
    this.onended?.();
  });
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {};
  sampleRate = 48000;
  resumeCalls = 0;
  closeCalls = 0;
  buffers: Array<{ channels: number; length: number; sampleRate: number }> = [];
  sources: FakeBufferSourceNode[] = [];
  oscillators: FakeOscillatorNode[] = [];
  gains: FakeGainNode[] = [];
  analysers: FakeAnalyserNode[] = [];
  mediaStreamSources: FakeMediaStreamSource[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    return Promise.resolve();
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createAnalyser(): FakeAnalyserNode {
    const analyser = new FakeAnalyserNode();
    this.analysers.push(analyser);
    return analyser;
  }

  createMediaStreamSource(): FakeMediaStreamSource {
    const source = new FakeMediaStreamSource();
    this.mediaStreamSources.push(source);
    return source;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    this.buffers.push({ channels, length, sampleRate });
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }

  createBufferSource(): FakeBufferSourceNode {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source;
  }

  createOscillator(): FakeOscillatorNode {
    const oscillator = new FakeOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeAudioContext.instances = [];
});

describe('daemon TTS playback audio context', () => {
  it('unlocks a shared context from a gesture with a silent pulse', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const { unlockDaemonTtsAudio } = await import('../client/src/voice/tts');

    await unlockDaemonTtsAudio();

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0);
    expect(ctx.buffers[0]).toMatchObject({ channels: 1, length: 1, sampleRate: 48000 });
  });

  it('plays a short PTT press tone on the shared audio context', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const { playPttPressTone } = await import('../client/src/voice/tts');

    playPttPressTone();

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.oscillators).toHaveLength(1);
    const oscillator = ctx.oscillators[0];
    expect(oscillator.type).toBe('sine');
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
    expect(oscillator.start).toHaveBeenCalledWith(0);
    expect(oscillator.stop).toHaveBeenCalledWith(0.18);
  });

  it('does not reject when the browser refuses AudioContext construction', async () => {
    class ThrowingAudioContext {
      constructor() {
        throw new Error('not allowed');
      }
    }
    vi.stubGlobal('window', { AudioContext: ThrowingAudioContext });
    const { unlockDaemonTtsAudio } = await import('../client/src/voice/tts');

    await expect(unlockDaemonTtsAudio()).resolves.toBeUndefined();
  });

  it('reuses the unlocked context and buffers daemon PCM at the daemon sample rate', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const { playDaemonTts, unlockDaemonTtsAudio } = await import('../client/src/voice/tts');
    const controls: Array<(msg: { t: string; [k: string]: unknown }) => void> = [];
    const binaries: Array<(bytes: ArrayBuffer) => void> = [];

    await unlockDaemonTtsAudio();
    const handle = playDaemonTts({
      addControlListener(fn) {
        controls.push(fn);
        return vi.fn();
      },
      addBinaryListener(fn) {
        binaries.push(fn);
        return vi.fn();
      },
      sendControl: vi.fn(),
    });

    controls[0]({ t: 'tts.start', sample_rate: 24000 });
    binaries[0](new Uint8Array([0, 0, 0xff, 0x7f]).buffer);
    handle.stop();
    await handle.done;

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.closeCalls).toBe(0);
    expect(ctx.resumeCalls).toBeGreaterThanOrEqual(1);
    expect(ctx.buffers).toContainEqual({ channels: 1, length: 2, sampleRate: 24000 });
  });

  it('starts background static once and stops cleanly on stop', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const {
      startBackgroundStatic,
      stopBackgroundStatic,
      isBackgroundStaticActive,
      BACKGROUND_STATIC_GAIN,
    } = await import('../client/src/voice/tts');

    expect(isBackgroundStaticActive()).toBe(false);
    startBackgroundStatic();
    expect(isBackgroundStaticActive()).toBe(true);

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.sources.length).toBe(1);
    const source = ctx.sources[0];
    // Loop flag must be set so the buffer plays continuously instead
    // of firing onended after the first 2 s.
    expect((source as unknown as { loop?: boolean }).loop).toBe(true);
    expect(source.start).toHaveBeenCalledWith(0);
    // Buffer sized at sampleRate * BACKGROUND_STATIC_BUFFER_SECONDS.
    expect(ctx.buffers[0]?.sampleRate).toBe(48000);
    expect(ctx.buffers[0]?.length).toBe(48000 * 2);

    // Gain halved from the previous 0.04 white-noise tuning.
    expect(BACKGROUND_STATIC_GAIN).toBe(0.02);
    const lastGain = ctx.gains[ctx.gains.length - 1];
    expect(lastGain.gain.value).toBe(0.02);

    // Idempotent: a second call must not create a second source.
    startBackgroundStatic();
    expect(ctx.sources.length).toBe(1);

    stopBackgroundStatic();
    expect(isBackgroundStaticActive()).toBe(false);
    expect(source.stop).toHaveBeenCalled();
    expect(source.disconnect).toHaveBeenCalled();
  });

  it('generatePinkNoiseSamples returns a bounded Float32Array of the requested length', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const { generatePinkNoiseSamples } = await import('../client/src/voice/tts');

    // Deterministic RNG so the test isn't flaky.
    let seed = 1;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };

    const samples = generatePinkNoiseSamples(2048, {
      random: rand,
      crackleProbability: 0, // isolate the pink path
    });

    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples.length).toBe(2048);
    let nonZero = 0;
    let maxAbs = 0;
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
      if (s !== 0) nonZero++;
      const abs = Math.abs(s);
      if (abs > maxAbs) maxAbs = abs;
    }
    // The Kellet filter ramps up over the first few samples; almost
    // every sample after that is non-zero.
    expect(nonZero).toBeGreaterThan(2000);
    // Pink output at amplitude=0.18 should peak well below clip.
    expect(maxAbs).toBeLessThan(1);
  });

  it('generatePinkNoiseSamples returns an empty array for non-positive counts', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const { generatePinkNoiseSamples } = await import('../client/src/voice/tts');
    expect(generatePinkNoiseSamples(0).length).toBe(0);
    expect(generatePinkNoiseSamples(-5).length).toBe(0);
  });

  it('background static is a no-op when AudioContext is not available', async () => {
    vi.stubGlobal('window', {});
    const { startBackgroundStatic, isBackgroundStaticActive } = await import(
      '../client/src/voice/tts'
    );
    expect(() => startBackgroundStatic()).not.toThrow();
    expect(isBackgroundStaticActive()).toBe(false);
  });

  it('defensively resumes the shared context when TTS starts without prior unlock', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const { playDaemonTts } = await import('../client/src/voice/tts');
    const controls: Array<(msg: { t: string; [k: string]: unknown }) => void> = [];

    const handle = playDaemonTts({
      addControlListener(fn) {
        controls.push(fn);
        return vi.fn();
      },
      addBinaryListener() {
        return vi.fn();
      },
      sendControl: vi.fn(),
    });

    controls[0]({ t: 'tts.start', sample_rate: 24000 });
    handle.stop();
    await handle.done;

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].resumeCalls).toBe(1);
  });

  it('connects the remote stream analyser to a silent sink and disconnects it on detach', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audioEl = {
      autoplay: false,
      pause: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      setAttribute: vi.fn(),
      srcObject: null as MediaStream | null,
      style: {},
    };
    vi.stubGlobal('document', {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => audioEl),
    });
    const { attachDaemonRemoteStream, detachDaemonRemoteStream, getActiveOutputAnalysers } =
      await import('../client/src/voice/tts');
    const stream = new FakeMediaStream() as unknown as MediaStream;

    attachDaemonRemoteStream(stream);

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.mediaStreamSources).toHaveLength(1);
    expect(ctx.analysers).toHaveLength(1);
    const source = ctx.mediaStreamSources[0];
    const analyser = ctx.analysers[0];
    const sink = ctx.gains[0];
    expect(analyser.fftSize).toBe(512);
    expect(analyser.smoothingTimeConstant).toBe(0.45);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(sink);
    expect(sink.gain.value).toBe(0);
    expect(sink.connect).toHaveBeenCalledWith(ctx.destination);
    expect(getActiveOutputAnalysers()).toEqual([analyser]);

    detachDaemonRemoteStream(stream);

    expect(source.disconnect).toHaveBeenCalled();
    expect(analyser.disconnect).toHaveBeenCalled();
    expect(sink.disconnect).toHaveBeenCalled();
    expect(audioEl.pause).toHaveBeenCalled();
    expect(audioEl.srcObject).toBeNull();
    expect(getActiveOutputAnalysers()).toEqual([]);
  });
});
