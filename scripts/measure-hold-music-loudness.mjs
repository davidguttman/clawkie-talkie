#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const musicDir = path.join(repoRoot, 'client/public/music');
const targetLufs = Number(process.env.HOLD_MUSIC_TARGET_LUFS ?? -23);
const maxSpreadLu = Number(process.env.HOLD_MUSIC_MAX_SPREAD_LU ?? 1.5);
const maxTargetDeltaLu = Number(process.env.HOLD_MUSIC_MAX_TARGET_DELTA_LU ?? 0.5);

if (!Number.isFinite(targetLufs)) {
  throw new Error(`Invalid HOLD_MUSIC_TARGET_LUFS: ${process.env.HOLD_MUSIC_TARGET_LUFS}`);
}
if (!Number.isFinite(maxSpreadLu) || maxSpreadLu < 0) {
  throw new Error(`Invalid HOLD_MUSIC_MAX_SPREAD_LU: ${process.env.HOLD_MUSIC_MAX_SPREAD_LU}`);
}
if (!Number.isFinite(maxTargetDeltaLu) || maxTargetDeltaLu < 0) {
  throw new Error(`Invalid HOLD_MUSIC_MAX_TARGET_DELTA_LU: ${process.env.HOLD_MUSIC_MAX_TARGET_DELTA_LU}`);
}

const tracks = (await readdir(musicDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (tracks.length === 0) {
  throw new Error(`No MP3 files found in ${path.relative(repoRoot, musicDir)}`);
}

const rows = [];
for (const track of tracks) {
  const file = path.join(musicDir, track);
  const stats = await measureLoudness(file);
  rows.push({ track, lufs: stats.input_i, truePeak: stats.input_tp, lra: stats.input_lra });
}

const loudnessValues = rows.map((row) => row.lufs);
const min = Math.min(...loudnessValues);
const max = Math.max(...loudnessValues);
const spread = max - min;
const average = loudnessValues.reduce((sum, value) => sum + value, 0) / loudnessValues.length;

console.log(`Hold music loudness (${path.relative(repoRoot, musicDir)})`);
console.log('LUFS     TP     LRA   Track');
for (const row of rows) {
  console.log(`${format(row.lufs)}  ${format(row.truePeak)}  ${format(row.lra)}  ${row.track}`);
}
console.log(
  `average=${average.toFixed(2)} LUFS target=${targetLufs.toFixed(2)} LUFS `
    + `targetDelta=${Math.abs(average - targetLufs).toFixed(2)} LU `
    + `maxTargetDelta=${maxTargetDeltaLu.toFixed(2)} LU `
    + `spread=${spread.toFixed(2)} LU maxSpread=${maxSpreadLu.toFixed(2)} LU`,
);

const failures = [];
if (spread > maxSpreadLu) {
  failures.push(`Hold music loudness spread ${spread.toFixed(2)} LU exceeds ${maxSpreadLu.toFixed(2)} LU`);
}

const averageTargetDelta = Math.abs(average - targetLufs);
if (averageTargetDelta > maxTargetDeltaLu) {
  failures.push(
    `Hold music average loudness ${average.toFixed(2)} LUFS is `
      + `${averageTargetDelta.toFixed(2)} LU from target ${targetLufs.toFixed(2)} LUFS; `
      + `max allowed delta is ${maxTargetDeltaLu.toFixed(2)} LU`,
  );
}

const offTargetTracks = rows
  .map((row) => ({ ...row, targetDelta: Math.abs(row.lufs - targetLufs) }))
  .filter((row) => row.targetDelta > maxTargetDeltaLu);
if (offTargetTracks.length > 0) {
  const trackDetails = offTargetTracks
    .map((row) => `${row.track} (${row.lufs.toFixed(2)} LUFS, delta ${row.targetDelta.toFixed(2)} LU)`)
    .join(', ');
  failures.push(
    `Hold music tracks outside target ${targetLufs.toFixed(2)} LUFS by more than `
      + `${maxTargetDeltaLu.toFixed(2)} LU: ${trackDetails}`,
  );
}

if (failures.length > 0) {
  throw new Error(failures.join('\n'));
}

function format(value) {
  return value.toFixed(2).padStart(6);
}

function measureLoudness(file) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-i', file,
      '-af', `loudnorm=I=${targetLufs}:TP=-2:LRA=11:print_format=json`,
      '-f', 'null',
      '-',
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderrTail(stderr);
        reject(new Error(
          `ffmpeg exited with ${code} while measuring ${path.relative(repoRoot, file)}`
            + `${tail ? `\nstderr tail:\n${tail}` : ''}`,
        ));
        return;
      }
      try {
        const stats = parseLoudnormJson(stderr, file);
        resolve({
          input_i: requireFiniteLoudnormValue(stats.input_i, 'input_i', file),
          input_tp: requireFiniteLoudnormValue(stats.input_tp, 'input_tp', file),
          input_lra: requireFiniteLoudnormValue(stats.input_lra, 'input_lra', file),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseLoudnormJson(output, file) {
  const candidates = [...output.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]).reverse();
  for (const candidate of candidates) {
    try {
      const stats = JSON.parse(candidate);
      if (Object.hasOwn(stats, 'input_i')) {
        return stats;
      }
    } catch {
      // Try the next JSON-looking block in stderr.
    }
  }
  const tail = stderrTail(output);
  throw new Error(
    `Could not parse loudnorm stats for ${path.relative(repoRoot, file)}`
      + `${tail ? `\nstderr tail:\n${tail}` : ''}`,
  );
}

function stderrTail(output, maxLines = 20) {
  return output
    .trim()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join('\n');
}

function requireFiniteLoudnormValue(value, field, file) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid loudnorm ${field} for ${path.relative(repoRoot, file)}: ${value}`);
  }
  return numeric;
}
