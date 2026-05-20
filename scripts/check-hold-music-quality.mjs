#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const decodeSampleRate = 48000;
const maxStereoRmsRatio = Number(process.env.HOLD_MUSIC_MAX_STEREO_RMS_RATIO ?? 4);
const minAudibleRms = Number(process.env.HOLD_MUSIC_MIN_AUDIBLE_RMS ?? 1e-6);

const playbackDirs = [
  { label: 'processed effects+noise low /music-low', dir: path.join(repoRoot, 'client/public/music-low') },
  { label: 'processed effects+noise medium /music', dir: path.join(repoRoot, 'client/public/music') },
  { label: 'processed effects+noise high /music-high', dir: path.join(repoRoot, 'client/public/music-high') },
];

if (!Number.isFinite(maxStereoRmsRatio) || maxStereoRmsRatio < 1) {
  throw new Error(`Invalid HOLD_MUSIC_MAX_STEREO_RMS_RATIO: ${process.env.HOLD_MUSIC_MAX_STEREO_RMS_RATIO}`);
}
if (!Number.isFinite(minAudibleRms) || minAudibleRms < 0) {
  throw new Error(`Invalid HOLD_MUSIC_MIN_AUDIBLE_RMS: ${process.env.HOLD_MUSIC_MIN_AUDIBLE_RMS}`);
}

const allFailures = [];
let printedSection = false;

for (const playbackDir of playbackDirs) {
  if (printedSection) console.log('');
  printedSection = true;
  const failures = await checkPlaybackDir(playbackDir);
  allFailures.push(...failures);
}

if (allFailures.length > 0) {
  throw new Error(allFailures.join('\n'));
}

async function checkPlaybackDir({ label, dir }) {
  const tracks = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (tracks.length === 0) {
    throw new Error(`No MP3 files found for ${label} in ${path.relative(repoRoot, dir)}`);
  }

  const rows = [];
  for (const track of tracks) {
    const file = path.join(dir, track);
    rows.push({ track, ...(await inspectDecodedStereo(file)) });
  }

  console.log(`Hold music quality: ${label} (${path.relative(repoRoot, dir)})`);
  console.log('full L/R  2nd-half L/R  invalid  Track');
  for (const row of rows) {
    console.log(`${formatRatio(row.fullRatio)}    ${formatRatio(row.secondHalfRatio)}      ${String(row.invalidSamples).padStart(7)}  ${row.track}`);
  }
  console.log(`maxStereoRmsRatio=${maxStereoRmsRatio.toFixed(2)} minAudibleRms=${minAudibleRms}`);

  const failures = [];
  for (const row of rows) {
    if (row.invalidSamples > 0) {
      failures.push(`${label} ${row.track} decoded ${row.invalidSamples} non-finite sample(s)`);
    }
    if (row.frameCount === 0) {
      failures.push(`${label} ${row.track} decoded no samples`);
      continue;
    }
    if (row.fullMaxRms < minAudibleRms) {
      failures.push(`${label} ${row.track} full-track RMS is effectively silent (${row.fullMaxRms})`);
    }
    if (row.secondHalfMaxRms < minAudibleRms) {
      failures.push(`${label} ${row.track} second-half RMS is effectively silent (${row.secondHalfMaxRms})`);
    }
    if (row.fullRatio > maxStereoRmsRatio) {
      failures.push(`${label} ${row.track} full-track stereo RMS ratio ${row.fullRatio.toFixed(2)} exceeds ${maxStereoRmsRatio.toFixed(2)}`);
    }
    if (row.secondHalfRatio > maxStereoRmsRatio) {
      failures.push(`${label} ${row.track} second-half stereo RMS ratio ${row.secondHalfRatio.toFixed(2)} exceeds ${maxStereoRmsRatio.toFixed(2)}`);
    }
  }

  return failures;
}

async function inspectDecodedStereo(file) {
  const durationSeconds = await probeDurationSeconds(file);
  const midpointFrame = Math.max(0, Math.floor(durationSeconds * decodeSampleRate / 2));
  const child = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', file,
    '-vn',
    '-ac', '2',
    '-ar', String(decodeSampleRate),
    '-f', 'f32le',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let leftover = Buffer.alloc(0);
  let frameCount = 0;
  let invalidSamples = 0;
  const full = createStereoAccumulator();
  const secondHalf = createStereoAccumulator();

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  for await (const chunk of child.stdout) {
    const buffer = leftover.length === 0 ? chunk : Buffer.concat([leftover, chunk]);
    const bytesToRead = buffer.length - (buffer.length % 8);
    for (let offset = 0; offset < bytesToRead; offset += 8) {
      const left = buffer.readFloatLE(offset);
      const right = buffer.readFloatLE(offset + 4);
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        if (!Number.isFinite(left)) invalidSamples += 1;
        if (!Number.isFinite(right)) invalidSamples += 1;
      } else {
        accumulate(full, left, right);
        if (frameCount >= midpointFrame) accumulate(secondHalf, left, right);
      }
      frameCount += 1;
    }
    leftover = bytesToRead === buffer.length ? Buffer.alloc(0) : buffer.subarray(bytesToRead);
  }

  if (leftover.length > 0) {
    throw new Error(`Decoded partial stereo frame for ${path.relative(repoRoot, file)}`);
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg exited with ${exitCode} while decoding ${path.relative(repoRoot, file)}`
        + `${stderr ? `\nstderr:\n${stderr.trim()}` : ''}`,
    );
  }

  const fullRms = finalize(full);
  const secondHalfRms = finalize(secondHalf);
  return {
    frameCount,
    invalidSamples,
    fullRatio: rmsRatio(fullRms.left, fullRms.right),
    secondHalfRatio: rmsRatio(secondHalfRms.left, secondHalfRms.right),
    fullMaxRms: Math.max(fullRms.left, fullRms.right),
    secondHalfMaxRms: Math.max(secondHalfRms.left, secondHalfRms.right),
  };
}

function createStereoAccumulator() {
  return { leftSquares: 0, rightSquares: 0, frames: 0 };
}

function accumulate(accumulator, left, right) {
  accumulator.leftSquares += left * left;
  accumulator.rightSquares += right * right;
  accumulator.frames += 1;
}

function finalize(accumulator) {
  if (accumulator.frames === 0) return { left: 0, right: 0 };
  return {
    left: Math.sqrt(accumulator.leftSquares / accumulator.frames),
    right: Math.sqrt(accumulator.rightSquares / accumulator.frames),
  };
}

function rmsRatio(leftRms, rightRms) {
  const louder = Math.max(leftRms, rightRms);
  const quieter = Math.min(leftRms, rightRms);
  if (louder === 0) return 1;
  if (quieter === 0) return Infinity;
  return louder / quieter;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return '     inf';
  return value.toFixed(2).padStart(8);
}

async function probeDurationSeconds(file) {
  const output = await capture('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=duration:format=duration',
    '-of', 'json',
    file,
  ]);
  const metadata = JSON.parse(output);
  const duration = Number(metadata.streams?.[0]?.duration ?? metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for ${path.relative(repoRoot, file)}`);
  }
  return duration;
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}${stderr ? `\nstderr:\n${stderr.trim()}` : ''}`));
    });
  });
}
