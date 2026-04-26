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
    return new FakeGainNode();
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
});
