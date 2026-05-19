#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const baseTargetLufs = Number(process.env.HOLD_MUSIC_TARGET_LUFS ?? -23);
const playbackDirs = [
  { label: 'processed effects low /music-low', dir: path.join(repoRoot, 'client/public/music-low'), targetLufs: baseTargetLufs + linearToDb(0.25) },
  { label: 'processed effects medium /music', dir: path.join(repoRoot, 'client/public/music'), targetLufs: baseTargetLufs + linearToDb(0.5) },
  { label: 'processed effects high /music-high', dir: path.join(repoRoot, 'client/public/music-high'), targetLufs: baseTargetLufs },
  { label: 'original no-effects low /music-original-low', dir: path.join(repoRoot, 'client/public/music-original-low'), targetLufs: baseTargetLufs + linearToDb(0.25) },
  { label: 'original no-effects medium /music-original', dir: path.join(repoRoot, 'client/public/music-original'), targetLufs: baseTargetLufs + linearToDb(0.5) },
  { label: 'original no-effects high /music-original-high', dir: path.join(repoRoot, 'client/public/music-original-high'), targetLufs: baseTargetLufs },
];
const layerDirs = [
  { level: 'low', label: 'generated layers low /music-layers-low', dir: path.join(repoRoot, 'client/public/music-layers-low'), scalar: 0.25 },
  { level: 'medium', label: 'generated layers medium /music-layers', dir: path.join(repoRoot, 'client/public/music-layers'), scalar: 0.5 },
  { level: 'high', label: 'generated layers high /music-layers-high', dir: path.join(repoRoot, 'client/public/music-layers-high'), scalar: 1 },
];
const expectedLayerFiles = ['crackle.mp3', 'hiss.mp3'];
const targetLufs = baseTargetLufs;
const maxSpreadLu = Number(process.env.HOLD_MUSIC_MAX_SPREAD_LU ?? 1.5);
const maxTargetDeltaLu = Number(process.env.HOLD_MUSIC_MAX_TARGET_DELTA_LU ?? 0.5);
const maxLayerLevelDeltaDb = Number(process.env.HOLD_MUSIC_MAX_LAYER_LEVEL_DELTA_DB ?? 1.5);

if (!Number.isFinite(targetLufs)) {
  throw new Error(`Invalid HOLD_MUSIC_TARGET_LUFS: ${process.env.HOLD_MUSIC_TARGET_LUFS}`);
}
if (!Number.isFinite(maxSpreadLu) || maxSpreadLu < 0) {
  throw new Error(`Invalid HOLD_MUSIC_MAX_SPREAD_LU: ${process.env.HOLD_MUSIC_MAX_SPREAD_LU}`);
}
if (!Number.isFinite(maxTargetDeltaLu) || maxTargetDeltaLu < 0) {
  throw new Error(`Invalid HOLD_MUSIC_MAX_TARGET_DELTA_LU: ${process.env.HOLD_MUSIC_MAX_TARGET_DELTA_LU}`);
}
if (!Number.isFinite(maxLayerLevelDeltaDb) || maxLayerLevelDeltaDb < 0) {
  throw new Error(`Invalid HOLD_MUSIC_MAX_LAYER_LEVEL_DELTA_DB: ${process.env.HOLD_MUSIC_MAX_LAYER_LEVEL_DELTA_DB}`);
}

const allFailures = [];
let printedSection = false;

for (const playbackDir of playbackDirs) {
  if (printedSection) console.log('');
  printedSection = true;
  const failures = await measurePlaybackDir(playbackDir);
  allFailures.push(...failures);
}

if (printedSection) console.log('');
printedSection = true;
allFailures.push(...await measureLayerLevelDirs(layerDirs));

if (allFailures.length > 0) {
  throw new Error(allFailures.join('\n'));
}

async function measurePlaybackDir({ label, dir, targetLufs }) {
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
    const stats = await measureLoudness(file);
    rows.push({ track, lufs: stats.input_i, truePeak: stats.input_tp, lra: stats.input_lra });
  }

  const loudnessValues = rows.map((row) => row.lufs);
  const min = Math.min(...loudnessValues);
  const max = Math.max(...loudnessValues);
  const spread = max - min;
  const average = loudnessValues.reduce((sum, value) => sum + value, 0) / loudnessValues.length;

  console.log(`Hold music loudness: ${label} (${path.relative(repoRoot, dir)})`);
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
    failures.push(`${label} loudness spread ${spread.toFixed(2)} LU exceeds ${maxSpreadLu.toFixed(2)} LU`);
  }

  const averageTargetDelta = Math.abs(average - targetLufs);
  if (averageTargetDelta > maxTargetDeltaLu) {
    failures.push(
      `${label} average loudness ${average.toFixed(2)} LUFS is `
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
      `${label} tracks outside target ${targetLufs.toFixed(2)} LUFS by more than `
        + `${maxTargetDeltaLu.toFixed(2)} LU: ${trackDetails}`,
    );
  }

  return failures;
}

async function measureLayerLevelDirs(levelDirs) {
  const measurementsByFile = new Map();
  const failures = [];

  for (const levelDir of levelDirs) {
    const entries = await readdir(levelDir.dir, { withFileTypes: true });
    const mp3Files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const available = new Set(mp3Files);
    const missing = expectedLayerFiles.filter((file) => !available.has(file));
    if (missing.length > 0) {
      failures.push(`${levelDir.label} missing expected layer files: ${missing.join(', ')}`);
    }

    const unexpected = mp3Files.filter((file) => !expectedLayerFiles.includes(file));
    if (unexpected.length > 0) {
      failures.push(`${levelDir.label} has unexpected MP3 layer files: ${unexpected.join(', ')}`);
    }

    const rows = [];
    for (const layerFile of expectedLayerFiles) {
      if (!available.has(layerFile)) continue;
      const file = path.join(levelDir.dir, layerFile);
      const stats = await measureVolumeStats(file);
      const row = { file: layerFile, meanDb: stats.meanVolumeDb, peakDb: stats.maxVolumeDb };
      rows.push(row);
      const byLevel = measurementsByFile.get(layerFile) ?? new Map();
      byLevel.set(levelDir.level, { ...row, scalar: levelDir.scalar, label: levelDir.label });
      measurementsByFile.set(layerFile, byLevel);
    }

    console.log(`Hold music layer loudness: ${levelDir.label} (${path.relative(repoRoot, levelDir.dir)})`);
    console.log('MEANdB  PEAKdB  Layer');
    for (const row of rows) {
      console.log(`${format(row.meanDb)}  ${format(row.peakDb)}  ${row.file}`);
    }
  }

  for (const layerFile of expectedLayerFiles) {
    const byLevel = measurementsByFile.get(layerFile);
    if (!byLevel) continue;
    for (const [fromLevel, toLevel] of [['low', 'medium'], ['medium', 'high'], ['low', 'high']]) {
      const from = byLevel.get(fromLevel);
      const to = byLevel.get(toLevel);
      if (!from || !to) continue;
      const expectedDelta = linearToDb(to.scalar / from.scalar);
      const meanDelta = to.meanDb - from.meanDb;
      const peakDelta = to.peakDb - from.peakDb;
      if (Math.abs(meanDelta - expectedDelta) > maxLayerLevelDeltaDb) {
        failures.push(
          `${layerFile} ${fromLevel}->${toLevel} mean-volume delta ${meanDelta.toFixed(2)} dB `
            + `differs from expected ${expectedDelta.toFixed(2)} dB by more than `
            + `${maxLayerLevelDeltaDb.toFixed(2)} dB`,
        );
      }
      if (Math.abs(peakDelta - expectedDelta) > maxLayerLevelDeltaDb) {
        failures.push(
          `${layerFile} ${fromLevel}->${toLevel} peak delta ${peakDelta.toFixed(2)} dB `
            + `differs from expected ${expectedDelta.toFixed(2)} dB by more than `
            + `${maxLayerLevelDeltaDb.toFixed(2)} dB`,
        );
      }
    }
  }

  console.log(
    `layer level relationship tolerance=${maxLayerLevelDeltaDb.toFixed(2)} dB `
      + `expectedFiles=${expectedLayerFiles.join(', ')}`,
  );

  return failures;
}

function format(value) {
  if (value === -Infinity) return '  -inf';
  if (value === Infinity) return '   inf';
  return value.toFixed(2).padStart(6);
}

function linearToDb(value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid linear gain: ${value}`);
  return 20 * Math.log10(value);
}

function measureVolumeStats(file) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-i', file,
      '-af', 'volumedetect',
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
        resolve(parseVolumedetectStats(stderr, file));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseVolumedetectStats(output, file) {
  const meanMatch = output.match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  const maxMatch = output.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  if (!meanMatch || !maxMatch) {
    const tail = stderrTail(output);
    throw new Error(
      `Could not parse volumedetect stats for ${path.relative(repoRoot, file)}`
        + `${tail ? `\nstderr tail:\n${tail}` : ''}`,
    );
  }
  return {
    meanVolumeDb: requireFiniteVolumeDb(meanMatch[1], 'mean_volume', file),
    maxVolumeDb: requireFiniteVolumeDb(maxMatch[1], 'max_volume', file),
  };
}

function requireFiniteVolumeDb(value, field, file) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid volumedetect ${field} for ${path.relative(repoRoot, file)}: ${value}`);
  }
  return numeric;
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
