const MIN_DISPLAY_INTENSITY = 0.08;
const DEFAULT_MIN_FREQUENCY = 80;
const PCM_RMS_FLOOR = 0.0025;
const PCM_PEAK_FLOOR = 0.006;
const PCM_REFERENCE_RMS = 0.09;
const PCM_REFERENCE_PEAK = 0.22;
const ANALYSER_RMS_FLOOR = 0.004;
const ANALYSER_PEAK_FLOOR = 0.01;
const ANALYSER_REFERENCE_RMS = 0.08;
const ANALYSER_REFERENCE_PEAK = 0.22;

export interface SmoothBandOptions {
  attack?: number;
  release?: number;
  floor?: number;
}

export const DEFAULT_BAND_SMOOTHING = {
  attack: 0.6,
  release: 0.24,
} as const;

export const RECORDING_BAND_SMOOTHING = {
  attack: 0.68,
  release: 0.3,
} as const;

export const OUTPUT_BAND_SMOOTHING = {
  attack: 0.55,
  release: 0.24,
} as const;

export function pcm16ToBandIntensities(
  pcm: ArrayBuffer,
  bandCount: number,
  sampleRate = 16000,
): number[] {
  const count = Math.max(0, Math.floor(bandCount));
  if (count === 0) return [];
  if (pcm.byteLength < 4) return Array(count).fill(MIN_DISPLAY_INTENSITY);

  const sampleCount = pcm.byteLength >> 1;
  const fftSize = previousPowerOfTwo(sampleCount);
  if (fftSize < 4) return Array(count).fill(MIN_DISPLAY_INTENSITY);

  const view = new DataView(pcm);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const offsetSamples = sampleCount - fftSize;
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < fftSize; i++) {
    const s = view.getInt16((offsetSamples + i) * 2, true);
    const normalized = s < 0 ? s / 0x8000 : s / 0x7fff;
    const abs = Math.abs(normalized);
    sumSquares += normalized * normalized;
    if (abs > peak) peak = abs;
    real[i] = normalized * hann(i, fftSize);
  }

  const rms = Math.sqrt(sumSquares / fftSize);
  const envelope = envelopeToIntensity(rms, peak, {
    rmsFloor: PCM_RMS_FLOOR,
    peakFloor: PCM_PEAK_FLOOR,
    rmsReference: PCM_REFERENCE_RMS,
    peakReference: PCM_REFERENCE_PEAK,
  });
  if (envelope <= MIN_DISPLAY_INTENSITY) return Array(count).fill(MIN_DISPLAY_INTENSITY);

  fft(real, imag);
  const bins = fftSize >> 1;
  const magnitudes = new Float32Array(bins);
  let spectralPeak = 0;
  for (let i = 1; i < bins; i++) {
    const magnitude = Math.hypot(real[i], imag[i]) / (fftSize / 4);
    magnitudes[i] = magnitude;
    if (magnitude > spectralPeak) spectralPeak = magnitude;
  }

  if (spectralPeak <= 0) return Array(count).fill(envelope);
  const normalizedMagnitudes = new Float32Array(bins);
  for (let i = 1; i < bins; i++) normalizedMagnitudes[i] = magnitudes[i] / spectralPeak;

  const spectralShape = frequencyMagnitudesToBands(normalizedMagnitudes, count, {
    minFrequency: DEFAULT_MIN_FREQUENCY,
    maxFrequency: sampleRate / 2,
    sampleRate,
  });
  return applyEnvelopeToBands(spectralShape, envelope);
}

export function analyserToBandIntensities(
  analyser: AnalyserNode,
  bandCount: number,
  frequencyScratch?: Uint8Array<ArrayBuffer>,
  timeScratch?: Uint8Array<ArrayBuffer>,
): number[] {
  const bins = frequencyScratch && frequencyScratch.length === analyser.frequencyBinCount
    ? frequencyScratch
    : new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const frequencyBands = byteFrequencyDataToBands(bins, bandCount);

  if (typeof analyser.getByteTimeDomainData !== 'function') return frequencyBands;
  const time = timeScratch && timeScratch.length === analyser.fftSize
    ? timeScratch
    : new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(time);
  const envelope = byteTimeDomainDataToIntensity(time);
  if (envelope <= MIN_DISPLAY_INTENSITY) return frequencyBands;

  const frequencyPeak = Math.max(...frequencyBands);
  if (frequencyPeak <= MIN_DISPLAY_INTENSITY + 0.01) {
    return Array(Math.max(0, Math.floor(bandCount))).fill(envelope);
  }
  return frequencyBands.map((band) => Math.max(band, envelopeScaledBand(band, envelope)));
}

export function byteFrequencyDataToBands(
  data: Uint8Array<ArrayBufferLike>,
  bandCount: number,
): number[] {
  const count = Math.max(0, Math.floor(bandCount));
  if (count === 0) return [];
  if (data.length === 0) return Array(count).fill(MIN_DISPLAY_INTENSITY);

  const out = new Array<number>(count);
  const minBin = Math.min(2, Math.max(0, data.length - 1));
  const maxBin = Math.max(minBin + 1, data.length - 1);
  for (let band = 0; band < count; band++) {
    const { start, end } = logBandRange(band, count, minBin, maxBin);
    let sum = 0;
    let peak = 0;
    let n = 0;
    for (let i = start; i <= end; i++) {
      const v = data[i] / 255;
      sum += v * v;
      if (v > peak) peak = v;
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    out[band] = clampIntensity(rms * 0.55 + peak * 0.65);
  }
  return out;
}

export function mergeBandIntensities(
  sources: readonly number[][],
  bandCount: number,
  floor = MIN_DISPLAY_INTENSITY,
): number[] {
  const out = Array(Math.max(0, bandCount)).fill(floor);
  for (const source of sources) {
    for (let i = 0; i < out.length && i < source.length; i++) {
      if (source[i] > out[i]) out[i] = source[i];
    }
  }
  return out;
}

export function smoothBandIntensities(
  previous: readonly number[],
  target: readonly number[],
  opts: SmoothBandOptions = {},
): number[] {
  const attack = opts.attack ?? DEFAULT_BAND_SMOOTHING.attack;
  const release = opts.release ?? DEFAULT_BAND_SMOOTHING.release;
  const floor = opts.floor ?? MIN_DISPLAY_INTENSITY;
  const count = Math.max(previous.length, target.length);
  const next = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const prev = previous[i] ?? floor;
    const goal = target[i] ?? floor;
    const k = goal > prev ? attack : release;
    next[i] = clampIntensity(prev + (goal - prev) * k, floor);
  }
  return next;
}

function frequencyMagnitudesToBands(
  magnitudes: Float32Array,
  bandCount: number,
  opts: { minFrequency: number; maxFrequency: number; sampleRate: number },
): number[] {
  const out = new Array<number>(bandCount);
  const fftSize = magnitudes.length * 2;
  const minBin = Math.max(1, Math.floor((opts.minFrequency / opts.sampleRate) * fftSize));
  const maxBin = Math.min(
    magnitudes.length - 1,
    Math.max(minBin + 1, Math.floor((opts.maxFrequency / opts.sampleRate) * fftSize)),
  );

  for (let band = 0; band < bandCount; band++) {
    const { start, end } = logBandRange(band, bandCount, minBin, maxBin);
    let sum = 0;
    let peak = 0;
    let n = 0;
    for (let i = start; i <= end; i++) {
      const mag = magnitudes[i] ?? 0;
      sum += mag * mag;
      if (mag > peak) peak = mag;
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    const shaped = Math.log1p((rms * 0.75 + peak * 0.35) * 18) / Math.log1p(18);
    out[band] = clampIntensity(shaped);
  }
  return out;
}

function byteTimeDomainDataToIntensity(data: Uint8Array<ArrayBufferLike>): number {
  if (data.length === 0) return MIN_DISPLAY_INTENSITY;
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = (data[i] - 128) / 128;
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    if (abs > peak) peak = abs;
  }
  return envelopeToIntensity(Math.sqrt(sumSquares / data.length), peak, {
    rmsFloor: ANALYSER_RMS_FLOOR,
    peakFloor: ANALYSER_PEAK_FLOOR,
    rmsReference: ANALYSER_REFERENCE_RMS,
    peakReference: ANALYSER_REFERENCE_PEAK,
  });
}

function applyEnvelopeToBands(bands: readonly number[], envelope: number): number[] {
  return bands.map((band) => envelopeScaledBand(band, envelope));
}

function envelopeScaledBand(band: number, envelope: number): number {
  const shape = Math.max(0, (band - MIN_DISPLAY_INTENSITY) / (1 - MIN_DISPLAY_INTENSITY));
  return clampIntensity(MIN_DISPLAY_INTENSITY + Math.pow(shape, 0.65) * (envelope - MIN_DISPLAY_INTENSITY));
}

function envelopeToIntensity(
  rms: number,
  peak: number,
  opts: { rmsFloor: number; peakFloor: number; rmsReference: number; peakReference: number },
): number {
  const rmsAmount = normalizedAboveFloor(rms, opts.rmsFloor, opts.rmsReference);
  const peakAmount = normalizedAboveFloor(peak, opts.peakFloor, opts.peakReference);
  const compressed = Math.max(Math.sqrt(rmsAmount), Math.sqrt(peakAmount) * 0.75);
  if (compressed <= 0) return MIN_DISPLAY_INTENSITY;
  return clampIntensity(MIN_DISPLAY_INTENSITY + compressed * 0.82);
}

function normalizedAboveFloor(value: number, floor: number, reference: number): number {
  if (!Number.isFinite(value) || value <= floor) return 0;
  return Math.min(1, (value - floor) / Math.max(reference - floor, Number.EPSILON));
}

function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wLenR = Math.cos(angle);
    const wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = real[i + j];
        const uI = imag[i + j];
        const vR = real[i + j + len / 2] * wr - imag[i + j + len / 2] * wi;
        const vI = real[i + j + len / 2] * wi + imag[i + j + len / 2] * wr;
        real[i + j] = uR + vR;
        imag[i + j] = uI + vI;
        real[i + j + len / 2] = uR - vR;
        imag[i + j + len / 2] = uI - vI;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR;
        wr = nextWr;
      }
    }
  }
}

function previousPowerOfTwo(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function hann(i: number, size: number): number {
  if (size <= 1) return 1;
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
}

function logBandRange(
  band: number,
  bandCount: number,
  minBin: number,
  maxBin: number,
): { start: number; end: number } {
  const min = Math.max(1, minBin);
  const max = Math.max(min + 1, maxBin);
  const lo = band / bandCount;
  const hi = (band + 1) / bandCount;
  const start = Math.floor(min * Math.pow(max / min, lo));
  const end = Math.max(start, Math.ceil(min * Math.pow(max / min, hi)) - 1);
  return { start: Math.min(start, max), end: Math.min(end, max) };
}

function clampIntensity(value: number, floor = MIN_DISPLAY_INTENSITY): number {
  if (!Number.isFinite(value)) return floor;
  if (value < floor) return floor;
  if (value > 1) return 1;
  return value;
}
