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

  it('bakes effects plus hiss and crackle into processed tracks before level scaling', () => {
    const script = readScript('scripts/regenerate-hold-music.mjs');

    expect(script).toContain('const processedMusicMixFilter = [');
    expect(script).toContain('[music_fx][hiss][crackle]amix=inputs=3:duration=first:normalize=0:dropout_transition=0');
    expect(script).toContain("'-stream_loop', '-1'");
    expect(script).toContain('await createProcessedMusicMix(input, hissWav, crackleWav, processedMixInput)');
    expect(script).toContain('const loudnessStats = await measureMusicLoudness(processedMixInput, null)');
    expect(script).toContain("'-af', createMusicEncodeFilter(loudnessStats, null, level.scalar)");
    expect(script).not.toContain('layerScalar');
    expect(script).not.toContain('createLayerEncodeFilter');
    expect(script).not.toContain('music-layers');
  });

  it('gates all processed and original playback level directories', () => {
    const script = readScript('scripts/measure-hold-music-loudness.mjs');

    expect(script).toContain("label: 'processed effects+noise low /music-low'");
    expect(script).toContain("label: 'processed effects+noise medium /music'");
    expect(script).toContain("label: 'processed effects+noise high /music-high'");
    expect(script).toContain("label: 'original no-effects low /music-original-low'");
    expect(script).toContain("label: 'original no-effects medium /music-original'");
    expect(script).toContain("label: 'original no-effects high /music-original-high'");
    expect(script).toContain("path.join(repoRoot, 'client/public/music')");
    expect(script).toContain("path.join(repoRoot, 'client/public/music-original')");
    expect(script).toContain('for (const playbackDir of playbackDirs)');
    expect(script).not.toContain('measureLayerLevelDirs');
    expect(script).not.toContain('music-layers');
  });

  it('wires a decoded quality gate for processed hold music assets', () => {
    const pkg = JSON.parse(readScript('package.json'));
    const script = readScript('scripts/check-hold-music-quality.mjs');

    expect(pkg.scripts['music:qa']).toBe('node scripts/check-hold-music-quality.mjs');
    expect(script).toContain("label: 'processed effects+noise low /music-low'");
    expect(script).toContain("label: 'processed effects+noise medium /music'");
    expect(script).toContain("label: 'processed effects+noise high /music-high'");
    expect(script).toContain('HOLD_MUSIC_MAX_STEREO_RMS_RATIO');
    expect(script).toContain('invalidSamples');
    expect(script).toContain('secondHalfRatio');
  });

  it('does not leave runtime references to separate hold music layer assets', () => {
    const runtime = [
      readScript('client/src/voice/holdMusic.ts'),
      readScript('client/src/voice/holdMusicCatalog.ts'),
    ].join('\n');

    expect(runtime).not.toContain('/music-layers');
    expect(runtime).not.toContain('holdMusicLayerUrl');
    expect(runtime).not.toContain('HOLD_MUSIC_LAYER_TRACKS');
  });
});
