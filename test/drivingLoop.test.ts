import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyserScratch } from '../client/src/voice/drivingLoop';

let activeMicAnalyser: AnalyserNode | null = null;

vi.mock('../client/src/voice/audioSource', async (importActual) => ({
  ...(await importActual<typeof import('../client/src/voice/audioSource')>()),
  getActiveMicAnalyser: () => activeMicAnalyser,
}));

vi.mock('../client/src/voice/tts', () => ({
  getActiveOutputAnalysers: () => [],
  playDaemonTts: vi.fn(),
}));

class FakeAnalyser {
  fftSize = 128;
  frequencyBinCount = 64;
  private frames: Uint8Array[] = [];

  pushFrame(entries: Array<[number, number]>): void {
    const frame = new Uint8Array(this.frequencyBinCount);
    for (const [bin, value] of entries) frame[bin] = value;
    this.frames.push(frame);
  }

  getByteFrequencyData(data: Uint8Array): void {
    const frame = this.frames.shift() ?? new Uint8Array(this.frequencyBinCount);
    data.set(frame);
  }

  getByteTimeDomainData(data: Uint8Array): void {
    data.fill(128);
  }
}

beforeEach(() => {
  activeMicAnalyser = null;
});

describe('driving loop visualization band selection', () => {
  it('samples the live mic analyser on every recording tick', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const analyser = new FakeAnalyser();
    activeMicAnalyser = analyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const stalePcmBands = Array(28).fill(0.2);

    analyser.pushFrame([[10, 8]]);
    const first = readTargetBands('recording', stalePcmBands, null, scratch);

    analyser.pushFrame([[10, 56]]);
    const second = readTargetBands('recording', stalePcmBands, null, scratch);

    expect(first).not.toEqual(stalePcmBands);
    expect(second).not.toEqual(stalePcmBands);
    expect(Math.max(...second)).toBeGreaterThan(Math.max(...first) + 0.15);
  });

  it('falls back to the latest PCM bands only when no mic analyser exists', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const fallback = Array.from({ length: 28 }, (_, i) => 0.08 + i * 0.01);

    expect(readTargetBands('recording', fallback, null, scratch)).toBe(fallback);
  });
});

describe('driving loop hold music state gates', () => {
  it('starts while waiting for the agent and carries through the pre-speech ai state', async () => {
    const { syncHoldMusicForDrivingState } = await import('../client/src/voice/drivingLoop');
    const holdMusic = { start: vi.fn(), stop: vi.fn() };

    syncHoldMusicForDrivingState('thinking', holdMusic);
    syncHoldMusicForDrivingState('ai', holdMusic);

    expect(holdMusic.start).toHaveBeenCalledTimes(1);
    expect(holdMusic.stop).not.toHaveBeenCalled();

    syncHoldMusicForDrivingState('recording', holdMusic);
    syncHoldMusicForDrivingState('idle', holdMusic);

    expect(holdMusic.stop).toHaveBeenCalledTimes(2);
  });

  it('stops when daemon speech starts or the waiting turn ends', async () => {
    const { shouldStopHoldMusicForControlMessage } = await import('../client/src/voice/drivingLoop');

    expect(shouldStopHoldMusicForControlMessage({ t: 'tts.start' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'tts.done' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'tts.error' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'reply.error' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'reply.done' })).toBe(false);
    expect(shouldStopHoldMusicForControlMessage({ t: 'stt.partial' })).toBe(false);
  });
});
