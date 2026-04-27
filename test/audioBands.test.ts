import { describe, expect, it } from 'vitest';
import {
  analyserToBandIntensities,
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

  it('lifts low-amplitude speech-like PCM visibly above the floor', () => {
    const bands = pcm16ToBandIntensities(sinePcm(440, 0.05), 12);

    expect(Math.max(...bands)).toBeGreaterThan(0.3);
    expect(dominantBand(bands)).toBeGreaterThanOrEqual(0);
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

  it('uses analyser time-domain audio when frequency bins are empty', () => {
    const analyser = {
      fftSize: 64,
      frequencyBinCount: 32,
      getByteFrequencyData(data: Uint8Array) {
        data.fill(0);
      },
      getByteTimeDomainData(data: Uint8Array) {
        for (let i = 0; i < data.length; i++) {
          data[i] = 128 + Math.round(Math.sin((2 * Math.PI * i) / data.length) * 8);
        }
      },
    } as unknown as AnalyserNode;

    const bands = analyserToBandIntensities(
      analyser,
      8,
      new Uint8Array(32),
      new Uint8Array(64),
    );

    expect(bands).toHaveLength(8);
    expect(Math.min(...bands)).toBeGreaterThan(0.25);
    expect(Math.max(...bands)).toBeLessThanOrEqual(1);
  });

  it('smooths rises faster than falls', () => {
    const rising = smoothBandIntensities([0.1], [0.9], { attack: 0.5, release: 0.1 });
    const falling = smoothBandIntensities([0.9], [0.1], { attack: 0.5, release: 0.1 });

    expect(rising[0]).toBeCloseTo(0.5);
    expect(falling[0]).toBeCloseTo(0.82);
  });
});

function sinePcm(
  frequency: number,
  amplitude = 0.8,
  sampleRate = 16000,
  samples = 4096,
): ArrayBuffer {
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
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
