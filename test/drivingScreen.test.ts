import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

describe('DrivingScreen waveform wiring', () => {
  it('passes driving loop intensities directly to LiveWave', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).not.toContain('idleIntensities');
    expect(source).not.toContain('Math.sin');
    expect(source).not.toContain('waveIntensities');
    expect(source).toContain('intensities={intensities}');
  });
});

describe('DrivingScreen media debug surface', () => {
  it('keeps the hardware-event conclusion and keeper counters visible in debug mode', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('hardwareEvent=');
    expect(source).toContain('probableLayer=');
    expect(source).toContain('keeperEvents play=');
    expect(source).toContain('ios_mic_session_before_js');
  });
});
