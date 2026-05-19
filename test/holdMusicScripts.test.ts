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
    expect(script).toContain("'-af', createMusicEncodeFilter(originalLoudnessStats, null)");
  });

  it('gates both processed and original playback directories', () => {
    const script = readScript('scripts/measure-hold-music-loudness.mjs');

    expect(script).toContain("label: 'processed effects /music'");
    expect(script).toContain("label: 'original no-effects /music-original'");
    expect(script).toContain("path.join(repoRoot, 'client/public/music')");
    expect(script).toContain("path.join(repoRoot, 'client/public/music-original')");
    expect(script).toContain('for (const playbackDir of playbackDirs)');
  });
});
