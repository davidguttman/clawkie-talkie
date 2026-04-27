import { describe, expect, it } from 'vitest';
import {
  byteFrequencyDataToBands,
  pcm16ToBandIntensities,
  smoothBandIntensities,
} from '../client/src/voice/audioBands';

describe('audio band helpers', () => {
  it('keeps silent PCM at the quiet floor', () => {
    const pcm = new ArrayBuffer(2048 * 2);

    expect(pcm16ToBandIntensities(pcm, 8)).toEqual(Array(8).fill(0.08));
  });

  it('places a low sine lower than a high sine', () => {
    const low = pcm16ToBandIntensities(sinePcm(440), 12);
    const high = pcm16ToBandIntensities(sinePcm(3000), 12);

    expect(dominantBand(low)).toBeLessThan(dominantBand(high));
    expect(Math.max(...low)).toBeGreaterThan(0.4);
    expect(Math.max(...high)).toBeGreaterThan(0.4);
  });

  it('converts analyser byte bins into bounded log-spaced bands', () => {
    const bins = new Uint8Array(64);
    bins[4] = 255;
    bins[48] = 128;

    const bands = byteFrequencyDataToBands(bins, 6);

    expect(bands).toHaveLength(6);
    expect(Math.max(...bands)).toBeGreaterThan(0.9);
    for (const band of bands) {
      expect(band).toBeGreaterThanOrEqual(0.08);
      expect(band).toBeLessThanOrEqual(1);
    }
  });

  it('smooths rises faster than falls', () => {
    const rising = smoothBandIntensities([0.1], [0.9], { attack: 0.5, release: 0.1 });
    const falling = smoothBandIntensities([0.9], [0.1], { attack: 0.5, release: 0.1 });

    expect(rising[0]).toBeCloseTo(0.5);
    expect(falling[0]).toBeCloseTo(0.82);
  });
});

function sinePcm(frequency: number, sampleRate = 16000, samples = 4096): ArrayBuffer {
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.8;
    view.setInt16(i * 2, value * 0x7fff, true);
  }
  return buffer;
}

function dominantBand(bands: number[]): number {
  let max = -Infinity;
  let index = -1;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i] > max) {
      max = bands[i];
      index = i;
    }
  }
  return index;
}
