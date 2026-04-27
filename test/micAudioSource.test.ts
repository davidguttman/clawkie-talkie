// Mic source lifecycle: getUserMedia must be called once, not on every
// PTT press. iOS / Safari treats stopping mic tracks as "permission
// released" and re-prompts on the next acquisition; the cache below
// keeps the tracks alive across start/stop turns.

import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeAudioParam {
  value = 0;
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeScriptProcessor {
  onaudioprocess: ((ev: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAnalyserNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  frequencyBinCount = 1024;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData = vi.fn();
  getByteTimeDomainData = vi.fn();
}

class FakeMediaStreamSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeMediaStream {
  private tracks: Array<{ readyState: 'live' | 'ended'; stop: () => void }>;
  constructor() {
    this.tracks = [
      {
        readyState: 'live',
        stop: () => {
          for (const t of this.tracks) t.readyState = 'ended';
        },
      },
    ];
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'running';
  destination = {};
  sampleRate = 16000;
  createMediaStreamSource = vi.fn(() => new FakeMediaStreamSource());
  createScriptProcessor = vi.fn(() => new FakeScriptProcessor());
  createAnalyser = vi.fn(() => new FakeAnalyserNode());
  createGain = vi.fn(() => new FakeGainNode());
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

afterEach(async () => {
  const { _resetMicAudioSourceForTests } = await import('../client/src/voice/audioSource');
  _resetMicAudioSourceForTests();
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeAudioContext.instances = [];
});

describe('createMicAudioSource', () => {
  it('calls getUserMedia exactly once across multiple start/stop cycles', async () => {
    const stream = new FakeMediaStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { createMicAudioSource } = await import('../client/src/voice/audioSource');

    const src1 = createMicAudioSource();
    await src1.start(() => {});
    await src1.stop();

    const src2 = createMicAudioSource();
    await src2.start(() => {});
    await src2.stop();

    const src3 = createMicAudioSource();
    await src3.start(() => {});
    await src3.stop();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('uses a 1024-sample mic callback frame for STT transport', async () => {
    const stream = new FakeMediaStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { createMicAudioSource, MIC_BUFFER_SIZE, MIC_FRAME_DURATION_MS } = await import(
      '../client/src/voice/audioSource'
    );

    const src = createMicAudioSource();
    await src.start(() => {});
    await src.stop();

    expect(MIC_BUFFER_SIZE).toBe(1024);
    expect(MIC_FRAME_DURATION_MS).toBe(64);
    expect(FakeAudioContext.instances[0].createScriptProcessor).toHaveBeenCalledWith(
      1024,
      1,
      1,
    );
  });

  it('creates and reuses a live mic analyser configured for RAF visualization', async () => {
    const stream = new FakeMediaStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { createMicAudioSource, getActiveMicAnalyser } = await import(
      '../client/src/voice/audioSource'
    );

    const src1 = createMicAudioSource();
    await src1.start(() => {});
    const firstAnalyser = getActiveMicAnalyser() as unknown as FakeAnalyserNode;
    await src1.stop();

    const src2 = createMicAudioSource();
    await src2.start(() => {});
    const secondAnalyser = getActiveMicAnalyser();
    await src2.stop();

    expect(firstAnalyser).toBeTruthy();
    expect(firstAnalyser.fftSize).toBe(128);
    expect(firstAnalyser.smoothingTimeConstant).toBe(0);
    expect(secondAnalyser).toBe(firstAnalyser);
    expect(FakeAudioContext.instances[0].createAnalyser).toHaveBeenCalledTimes(1);
    expect(firstAnalyser.connect).toHaveBeenCalledTimes(1);
  });

  it('does not stop the underlying mic tracks on a normal stop()', async () => {
    const stream = new FakeMediaStream();
    const trackStop = vi.fn();
    stream.getTracks()[0].stop = trackStop;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { createMicAudioSource } = await import('../client/src/voice/audioSource');

    const src = createMicAudioSource();
    await src.start(() => {});
    await src.stop();

    expect(trackStop).not.toHaveBeenCalled();
    expect(stream.getTracks()[0].readyState).toBe('live');
  });

  it('releaseMicAudioSource() stops tracks and forces re-acquisition', async () => {
    const stream1 = new FakeMediaStream();
    const stream2 = new FakeMediaStream();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(stream1)
      .mockResolvedValueOnce(stream2);
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { createMicAudioSource, getActiveMicAnalyser, releaseMicAudioSource } = await import(
      '../client/src/voice/audioSource'
    );

    const src1 = createMicAudioSource();
    await src1.start(() => {});
    await src1.stop();

    await releaseMicAudioSource();
    expect(stream1.getTracks()[0].readyState).toBe('ended');
    expect(getActiveMicAnalyser()).toBeNull();

    const src2 = createMicAudioSource();
    await src2.start(() => {});
    await src2.stop();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('re-acquires the mic if cached tracks died (e.g. OS revoked permission)', async () => {
    const deadStream = new FakeMediaStream();
    deadStream.getTracks()[0].readyState = 'ended';
    const liveStream = new FakeMediaStream();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(deadStream)
      .mockResolvedValueOnce(liveStream);
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const { createMicAudioSource } = await import('../client/src/voice/audioSource');

    const src1 = createMicAudioSource();
    await src1.start(() => {});
    await src1.stop();

    // Simulate the cached tracks dying between PTT presses.
    deadStream.getTracks()[0].readyState = 'ended';

    const src2 = createMicAudioSource();
    await src2.start(() => {});
    await src2.stop();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});
