import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readScript(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('hold music asset scripts', () => {
  it('normalizes original playback tracks from raw sources instead of copying raw files', () => {
    const script = readScript('scripts/regenerate-hold-music.mjs');

    expect(script).toContain("const rawDir = path.join(repoRoot, 'assets/hold-music-raw')");
    expect(script).toContain("const originalMusicDir = path.join(repoRoot, 'client/public/music-original')");
    expect(script).not.toContain('copyFile');
    expect(script).toContain('const originalLoudnessStats = await measureMusicLoudness(input, null)');
    expect(script).toContain("'-af', createMusicEncodeFilter(originalLoudnessStats, null, level.scalar)");
    expect(script).toContain("const musicLowDir = path.join(repoRoot, 'client/public/music-low')");
    expect(script).toContain("const musicHighDir = path.join(repoRoot, 'client/public/music-high')");
  });

  it('gates all processed and original playback level directories', () => {
    const script = readScript('scripts/measure-hold-music-loudness.mjs');

    expect(script).toContain("label: 'processed effects low /music-low'");
    expect(script).toContain("label: 'processed effects medium /music'");
    expect(script).toContain("label: 'processed effects high /music-high'");
    expect(script).toContain("label: 'original no-effects low /music-original-low'");
    expect(script).toContain("label: 'original no-effects medium /music-original'");
    expect(script).toContain("label: 'original no-effects high /music-original-high'");
    expect(script).toContain("path.join(repoRoot, 'client/public/music')");
    expect(script).toContain("path.join(repoRoot, 'client/public/music-original')");
    expect(script).toContain('for (const playbackDir of playbackDirs)');
  });

  it('gates generated layer level directories and expected layer files', () => {
    const script = readScript('scripts/measure-hold-music-loudness.mjs');

    expect(script).toContain("label: 'generated layers low /music-layers-low'");
    expect(script).toContain("label: 'generated layers medium /music-layers'");
    expect(script).toContain("label: 'generated layers high /music-layers-high'");
    expect(script).toContain("const expectedLayerFiles = ['crackle.mp3', 'hiss.mp3']");
    expect(script).toContain('measureLayerLevelDirs(layerDirs)');
    expect(script).toContain('missing expected layer files');
    expect(script).toContain('peak delta');
    expect(script).toContain('HOLD_MUSIC_MAX_LAYER_LEVEL_DELTA_DB');
  });
});
