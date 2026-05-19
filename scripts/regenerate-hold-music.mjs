#!/usr/bin/env node
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const rawDir = path.join(repoRoot, 'assets/hold-music-raw');
const musicDir = path.join(repoRoot, 'client/public/music');
const originalMusicDir = path.join(repoRoot, 'client/public/music-original');
const layerDir = path.join(repoRoot, 'client/public/music-layers');
const tempDir = path.join(repoRoot, '.vite/hold-music-regen');

// Keep this chain matched to the original runtime WebAudio graph from
// client/src/voice/holdMusic.ts before the tracks were baked:
// highpass -> AudioWorklet bitcrusher -> lowpass -> mid peak -> WaveShaper
// saturation -> DynamicsCompressor -> wobble GainNode. MUSIC_GAIN remains a
// runtime playback volume and is intentionally not baked into these files.
const MUSIC_HIGHPASS_HZ = 300;
const MUSIC_HIGHPASS_Q = 0.8;
const BITCRUSHER_BITS = 8;
const BITCRUSHER_NORM_FREQ = 0.4;
const MUSIC_LOWPASS_HZ = 4500;
const MUSIC_LOWPASS_Q = 0.7;
const MUSIC_MIDRANGE_HZ = 1500;
const MUSIC_MIDRANGE_Q = 1.2;
const MUSIC_MIDRANGE_GAIN_DB = 5;
const MUSIC_SATURATION_DRIVE = 0.35;
const MUSIC_WOBBLE_HZ = 0.4;
const MUSIC_WOBBLE_DEPTH = 0.05;
const MUSIC_COMPRESSOR_THRESHOLD_DB = -24;
const MUSIC_COMPRESSOR_KNEE_DB = 18;
const MUSIC_COMPRESSOR_RATIO = 8;
const MUSIC_COMPRESSOR_ATTACK_MS = 3;
const MUSIC_COMPRESSOR_RELEASE_MS = 100;
const HISS_LAYER_GAIN_DB = -16;
const CRACKLE_LAYER_GAIN_DB = -10;
const MUSIC_LOUDNESS_TARGET_LUFS = -23;
const MUSIC_LOUDNESS_RANGE_LU = 11;
const MUSIC_LOUDNESS_TRUE_PEAK_DBTP = -2;

const bitcrusherSampleHold = 1 / BITCRUSHER_NORM_FREQ;
const compressorThreshold = dbToLinear(MUSIC_COMPRESSOR_THRESHOLD_DB);
// FFmpeg's acompressor knee option is linear; 18 dB maps to about 7.94,
// matching the WebAudio DynamicsCompressorNode knee setting as closely as this
// filter allows.
const compressorKnee = dbToLinear(MUSIC_COMPRESSOR_KNEE_DB);

const musicEffectsFilter = [
  `highpass=f=${MUSIC_HIGHPASS_HZ}:t=q:w=${MUSIC_HIGHPASS_Q}`,
  // Original AudioWorklet quantized to 8 bits and held each sample until
  // phase += normFreq crossed 1.0. normFreq 0.4 therefore holds for roughly
  // 1 / 0.4 = 2.5 input samples. Use a fully-wet crusher; no soft blend.
  `acrusher=bits=${BITCRUSHER_BITS}:mode=lin:mix=1:aa=0:samples=${bitcrusherSampleHold}`,
  `lowpass=f=${MUSIC_LOWPASS_HZ}:t=q:w=${MUSIC_LOWPASS_Q}`,
  `equalizer=f=${MUSIC_MIDRANGE_HZ}:t=q:w=${MUSIC_MIDRANGE_Q}:g=${MUSIC_MIDRANGE_GAIN_DB}`,
  // Exact createAmifySaturationCurve(drive=0.35) transfer formula, expressed
  // as an FFmpeg sample expression. WebAudio's 4x WaveShaper oversampling does
  // not have a direct aeval switch, so the curve itself is the source of truth.
  `aeval=exprs='${createAmifySaturationExpression(MUSIC_SATURATION_DRIVE, 0)}|${createAmifySaturationExpression(MUSIC_SATURATION_DRIVE, 1)}':channel_layout=stereo`,
  `acompressor=threshold=${compressorThreshold}:ratio=${MUSIC_COMPRESSOR_RATIO}:attack=${MUSIC_COMPRESSOR_ATTACK_MS}:release=${MUSIC_COMPRESSOR_RELEASE_MS}:knee=${compressorKnee}:makeup=1`,
  `tremolo=f=${MUSIC_WOBBLE_HZ}:d=${MUSIC_WOBBLE_DEPTH}`,
].join(',');

const musicFormatFilter = [
  // Preserve the stereo bed after aeval and hand libmp3lame fixed-point audio;
  // this is an encoder-format guard, not an extra tone-shaping stage.
  'aformat=sample_fmts=s16p:channel_layouts=stereo',
].join(',');

const musicPreNormalizeFilter = [
  musicEffectsFilter,
  musicFormatFilter,
].join(',');

const musicLoudnessMeasureFilter = [
  musicPreNormalizeFilter,
  `loudnorm=I=${MUSIC_LOUDNESS_TARGET_LUFS}:TP=${MUSIC_LOUDNESS_TRUE_PEAK_DBTP}:LRA=${MUSIC_LOUDNESS_RANGE_LU}:print_format=json`,
].join(',');

const hissFilter = [
  'highpass=f=300',
  'lowpass=f=4500',
  'equalizer=f=2000:t=q:w=1.2:g=5',
  'loudnorm=I=-30:TP=-4:LRA=8',
  `volume=${HISS_LAYER_GAIN_DB}dB`,
].join(',');

const crackleFilter = [
  'highpass=f=300',
  'lowpass=f=4500',
  'alimiter=limit=0.8',
  `volume=${CRACKLE_LAYER_GAIN_DB}dB`,
].join(',');

await main();


function dbToLinear(db) {
  return 10 ** (db / 20);
}

function createAmifySaturationExpression(drive, channel) {
  const amount = Math.max(0, drive) * 100;
  const scale = (3 + amount) * 20 * Math.PI / 180;
  const sample = `min(1,max(-1,val(${channel})))`;
  return `(${scale}*${sample})/(${Math.PI}+${amount}*abs(${sample}))`;
}

async function measureMusicLoudness(input) {
  const stderr = await ffmpegCaptureStderr([
    '-i', input,
    '-vn',
    '-af', musicLoudnessMeasureFilter,
    '-f', 'null',
    '-',
  ]);
  const stats = parseLoudnormJson(stderr, input);
  return {
    input_i: requireFiniteLoudnormValue(stats.input_i, 'input_i', input),
    input_lra: requireFiniteLoudnormValue(stats.input_lra, 'input_lra', input),
    input_tp: requireFiniteLoudnormValue(stats.input_tp, 'input_tp', input),
    input_thresh: requireFiniteLoudnormValue(stats.input_thresh, 'input_thresh', input),
    target_offset: requireFiniteLoudnormValue(stats.target_offset, 'target_offset', input),
  };
}

function createMusicEncodeFilter(loudnessStats) {
  return [
    musicPreNormalizeFilter,
    [
      `loudnorm=I=${MUSIC_LOUDNESS_TARGET_LUFS}`,
      `TP=${MUSIC_LOUDNESS_TRUE_PEAK_DBTP}`,
      `LRA=${MUSIC_LOUDNESS_RANGE_LU}`,
      `measured_I=${loudnessStats.input_i}`,
      `measured_LRA=${loudnessStats.input_lra}`,
      `measured_TP=${loudnessStats.input_tp}`,
      `measured_thresh=${loudnessStats.input_thresh}`,
      `offset=${loudnessStats.target_offset}`,
      'linear=true',
    ].join(':'),
    musicFormatFilter,
  ].join(',');
}

function parseLoudnormJson(output, input) {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not parse loudnorm stats for ${path.relative(repoRoot, input)}`);
  }
  return JSON.parse(match[0]);
}

function requireFiniteLoudnormValue(value, field, input) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid loudnorm ${field} for ${path.relative(repoRoot, input)}: ${value}`);
  }
  return numeric;
}

async function main() {
  await mkdir(musicDir, { recursive: true });
  await mkdir(originalMusicDir, { recursive: true });
  await mkdir(layerDir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const rawTracks = (await readdir(rawDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (rawTracks.length === 0) {
    throw new Error(`No raw MP3 files found in ${path.relative(repoRoot, rawDir)}`);
  }

  await removeStaleGeneratedTracks(musicDir, rawTracks);
  await removeStaleGeneratedTracks(originalMusicDir, rawTracks);

  for (const track of rawTracks) {
    const input = path.join(rawDir, track);
    const originalOutput = path.join(originalMusicDir, track);
    await copyFile(input, originalOutput);

    const output = path.join(musicDir, track);
    console.log(`processing ${path.relative(repoRoot, output)}`);
    const loudnessStats = await measureMusicLoudness(input);
    await ffmpeg([
      '-y',
      '-i', input,
      '-map_metadata', '0',
      '-vn',
      '-af', createMusicEncodeFilter(loudnessStats),
      '-codec:a', 'libmp3lame',
      '-q:a', '3',
      output,
    ]);
  }

  const hissWav = path.join(tempDir, 'hiss.wav');
  const crackleWav = path.join(tempDir, 'crackle.wav');
  await writeFile(hissWav, createHissWav());
  await writeFile(crackleWav, createCrackleWav());

  console.log(`processing ${path.relative(repoRoot, path.join(layerDir, 'hiss.mp3'))}`);
  await ffmpeg([
    '-y',
    '-i', hissWav,
    '-af', hissFilter,
    '-codec:a', 'libmp3lame',
    '-q:a', '5',
    path.join(layerDir, 'hiss.mp3'),
  ]);

  console.log(`processing ${path.relative(repoRoot, path.join(layerDir, 'crackle.mp3'))}`);
  await ffmpeg([
    '-y',
    '-i', crackleWav,
    '-af', crackleFilter,
    '-codec:a', 'libmp3lame',
    '-q:a', '5',
    path.join(layerDir, 'crackle.mp3'),
  ]);

  await rm(tempDir, { recursive: true, force: true });
  console.log('hold music regenerated');
}


async function removeStaleGeneratedTracks(outputDir, expectedTracks) {
  const expected = new Set(expectedTracks);
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3') && !expected.has(entry.name))
    .map(async (entry) => {
      const stalePath = path.join(outputDir, entry.name);
      console.log(`removing stale ${path.relative(repoRoot, stalePath)}`);
      await rm(stalePath, { force: true });
    }));
}

function ffmpeg(args) {
  return runFfmpeg(args, { captureStderr: false });
}

function ffmpegCaptureStderr(args) {
  return runFfmpeg(args, { captureStderr: true });
}

function runFfmpeg(args, { captureStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', captureStderr ? 'info' : 'error', ...args], {
      stdio: ['ignore', 'inherit', captureStderr ? 'pipe' : 'inherit'],
    });
    let stderr = '';
    if (captureStderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

function createHissWav() {
  const sampleRate = 48000;
  const durationSeconds = 30;
  const random = seededRandom(0x48495353);
  const samples = new Float32Array(sampleRate * durationSeconds);
  let shaped = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const white = random() * 2 - 1;
    shaped = shaped * 0.86 + white * 0.14;
    samples[i] = clampSample((white * 0.55 + shaped * 0.45) * 0.26);
  }
  return encodePcm16Wav(samples, sampleRate);
}

function createCrackleWav() {
  const sampleRate = 48000;
  const durationSeconds = 30;
  const random = seededRandom(0x43524143);
  const samples = new Float32Array(sampleRate * durationSeconds);
  const cracklesPerSecond = 5;
  const chance = cracklesPerSecond / sampleRate;

  for (let i = 0; i < samples.length; i += 1) {
    if (random() >= chance) continue;
    const length = 35 + Math.floor(random() * 115);
    const amplitude = (0.42 + random() * 0.38) * (random() < 0.5 ? -1 : 1);
    for (let j = 0; j < length && i + j < samples.length; j += 1) {
      const decay = Math.exp(-j / 18);
      samples[i + j] = clampSample(samples[i + j] + amplitude * decay * (0.4 + random() * 0.6));
    }
  }

  return encodePcm16Wav(samples, sampleRate);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

function encodePcm16Wav(samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = clampSample(samples[i]);
    const intSample = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  return buffer;
}
