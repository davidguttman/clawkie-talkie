import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyserScratch } from '../client/src/voice/drivingLoop';

const root = resolve(__dirname, '..');

let activeMicAnalyser: AnalyserNode | null = null;
let activeHoldMusicAnalyser: AnalyserNode | null = null;
let activeOutputAnalysers: AnalyserNode[] = [];

vi.mock('../client/src/voice/audioSource', async (importActual) => ({
  ...(await importActual<typeof import('../client/src/voice/audioSource')>()),
  getActiveMicAnalyser: () => activeMicAnalyser,
}));

vi.mock('../client/src/voice/tts', () => ({
  getActiveOutputAnalysers: () => activeOutputAnalysers,
  playDaemonTts: vi.fn(),
}));

vi.mock('../client/src/voice/holdMusic', () => ({
  HoldMusicController: class {
    start(): void {}
    stop(): void {}
    unlock(): Promise<void> {
      return Promise.resolve();
    }
  },
  getActiveHoldMusicAnalyser: () => activeHoldMusicAnalyser,
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
  activeHoldMusicAnalyser = null;
  activeOutputAnalysers = [];
});

describe('driving loop visualization band selection', () => {
  it('mirrors unique low-to-high bands so highs land outside and lows land at the center', async () => {
    const { mirrorCenterOutBands } = await import('../client/src/voice/drivingLoop');

    expect(mirrorCenterOutBands([0.1, 0.25, 0.8])).toEqual([0.8, 0.25, 0.1, 0.1, 0.25, 0.8]);
  });

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

describe('driving loop thinking visualizer source selection', () => {
  it('uses the hold music analyser in thinking when no tts/remote analyser exists', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const holdAnalyser = new FakeAnalyser();
    holdAnalyser.pushFrame([[50, 255]]);
    activeHoldMusicAnalyser = holdAnalyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();

    const bands = readTargetBands('thinking', [], null, scratch);

    expect(bands).toHaveLength(28);
    expect(bands.slice(0, 14)).toEqual(bands.slice(14).reverse());
    expect(bands[13]).toBe(bands[14]);
    // High-bin signal: highs render on the outside edges, so center sits lower.
    expect(bands[13]).toBeLessThan(bands[0]);
  });

  it('does not include the hold music analyser when state is ai', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const holdAnalyser = new FakeAnalyser();
    holdAnalyser.pushFrame([[10, 96]]);
    activeHoldMusicAnalyser = holdAnalyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();

    // No tts/remote analyser available either; should fall back to QUIET.
    const bands = readTargetBands('ai', [], null, scratch);
    expect(Math.max(...bands)).toBeLessThan(0.1);
  });

  it('does not affect non-thinking/ai states', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const holdAnalyser = new FakeAnalyser();
    holdAnalyser.pushFrame([[10, 200]]);
    activeHoldMusicAnalyser = holdAnalyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const fallback = Array.from({ length: 28 }, (_, i) => 0.08 + i * 0.01);

    expect(readTargetBands('idle', fallback, null, scratch)).not.toBe(fallback);
    expect(Math.max(...readTargetBands('idle', fallback, null, scratch))).toBeLessThan(0.1);
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

describe('driving loop visualizer frame rendering', () => {
  it('applies a light time-smoothing pass before rendering frames', () => {
    const source = readFileSync(resolve(root, 'client/src/voice/drivingLoop.ts'), 'utf8');

    expect(source).toContain('smoothBandIntensities');
    expect(source).toContain('LIGHT_SMOOTHING');
    expect(source).toContain('attack: 0.85');
    expect(source).toContain('release: 0.6');
    expect(source).not.toContain('renderedBandsRef.current = target;');
    expect(source).not.toContain('setIntensities(target);');
  });
});

describe('driving loop transcript finalization', () => {
  it('routes an empty authoritative final to empty_transcript even when a committed partial exists', async () => {
    const { resolveSttDone } = await import('../client/src/voice/drivingLoop');

    const result = resolveSttDone('   ', ['chunk words']);

    expect(result).toEqual({
      nextAccumulated: [],
      transcript: { active: false, sttDone: false, text: '' },
      event: { type: 'stt.error', reason: 'empty_transcript' },
    });
    expect('saveText' in result).toBe(false);
  });

  it('uses non-empty stt.done text as the saved/dispatch transcript', async () => {
    const { resolveSttDone } = await import('../client/src/voice/drivingLoop');

    const result = resolveSttDone(' authoritative final ', ['chunk words']);

    expect(result).toEqual({
      nextAccumulated: [],
      transcript: { active: true, sttDone: true, text: 'authoritative final' },
      event: { type: 'stt.done', text: 'authoritative final' },
      saveText: 'authoritative final',
    });
  });
});
