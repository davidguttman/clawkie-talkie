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

describe('DrivingScreen hold music mute control', () => {
  it('replaces the thinking icon with a speaker/mute toggle wired to hold music storage', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('getHoldMusicMuted');
    expect(source).toContain('setHoldMusicMuted(!getHoldMusicMuted())');
    expect(source).toContain('subscribeHoldMusicMuted(setHoldMusicMutedState)');
    expect(source).toContain("'Mute hold music'");
    expect(source).toContain("'Unmute hold music'");
    expect(source).toContain("holdMusicMuted ? '⊘' : '◐'");
  });
});

describe('DrivingScreen response scroll timing', () => {
  it('resets AI response captions to the top instead of auto-scrolling to the bottom', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('AI_RESPONSE_CAPTION_LABEL');
    expect(source).toContain('isAiResponseCaption');
    expect(source).toContain('lastAiResponseTextRef');
    expect(source).toContain('el.scrollTop = 0');
    expect(source).not.toContain('el.scrollTop = el.scrollHeight');
    expect(source).not.toContain('scrollTop = scrollHeight');
  });
});

describe('DrivingScreen voice error labels', () => {
  it('surfaces infer STT, infer TTS, and reply auth failures with distinct labels', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain("if (code === 'openclaw_infer_stt_failed') return 'INFER ERROR");
    expect(source).toContain("if (code === 'openclaw_infer_tts_failed') return 'TTS ERROR");
    expect(source).toContain("if (code === 'openclaw_auth_unavailable') return 'REPLY ERROR");
  });
});

describe('DrivingScreen audio debug surface', () => {
  it('keeps remote TTS and STT chunk diagnostics visible in debug mode', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('AUDIO DEBUG');
    expect(source).toContain('REMOTE TTS');
    expect(source).toContain('remoteTtsAudio');
    expect(source).toContain('sttChunking');
  });
});
