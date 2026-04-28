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

  it('does not smooth LiveWave bar height changes in CSS', () => {
    const source = readFileSync(resolve(root, 'client/src/components/Phone.tsx'), 'utf8');

    expect(source).not.toContain('height 40ms ease-out');
  });
});

describe('DrivingScreen settings button', () => {
  it('renders the settings gear in both compact and desktop headers', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    // Settings button must not be gated on `!compact` — mobile users
    // need an accessible path to Settings too.
    expect(source).not.toContain('!compact && onSettings');
    expect(source).toContain('{onSettings && (');
    expect(source).toContain('aria-label="Settings"');
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
