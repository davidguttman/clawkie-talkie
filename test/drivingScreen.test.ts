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

describe('DrivingScreen replay control', () => {
  it('gates the replay footer button on an explicit canReplay prop', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('canReplay = false');
    expect(source).toContain('onReplay && canReplay');
    expect(source).not.toContain('ReplayNotice');
    expect(source).not.toContain('replayNotice');
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

describe('DrivingScreen caption display', () => {
  it('does not render a visible caption-state label above the transcript', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('isAiResponseCaption');
    expect(source).not.toContain('{caption.label}</span>');
    expect(source).not.toContain('animation: \'pulseDot 1.2s ease-in-out infinite\'');
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

describe('DrivingScreen session picker control', () => {
  it('renders a compact SESSIONS footer picker backed by RTC recent sessions', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    const sessionsFooterButton = source.slice(
      Math.max(0, source.indexOf('ariaLabel="Sessions"') - 160),
      source.indexOf('ariaLabel="Sessions"') + 80,
    );

    expect(source).toContain('rtc.recentSessions');
    expect(source).toContain('SessionPicker');
    expect(sessionsFooterButton).toContain('label="SESSIONS"');
    expect(sessionsFooterButton).not.toContain('activeSession');
    expect(source).not.toContain('compactSessionLabel');
    expect(source).toContain('rtc.requestRecentSessions();');
    expect(source).toContain('onSelectSession?.(session);');
  });

  it('uses the active recent session display label and agent in the header without UUID fallbacks', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    const activeSessionLookup = source.match(/const activeSession = recentSessions\.find\([\s\S]*?\);/)?.[0] ?? '';
    const buildHeaderLabel = source.match(/function buildHeaderLabel\(activeSession\?: RecentSession\): string \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(activeSessionLookup).toContain('session.sessionId === sessionId');
    expect(activeSessionLookup).toContain('session.sessionKey === sessionId');
    expect(source).toContain('const headerLabel = buildHeaderLabel(activeSession);');

    expect(buildHeaderLabel).toContain('trimString(activeSession?.displayLabel)');
    expect(buildHeaderLabel).toContain('trimString(activeSession?.agent)');
    expect(buildHeaderLabel).toContain('return `${displayLabel} · ${agent}`;');
    expect(buildHeaderLabel).toContain("return 'VOICE SESSION';");
    expect(buildHeaderLabel).not.toContain('sessionId');
    expect(buildHeaderLabel).not.toContain('hostPeerId');
    expect(source).not.toContain('compactValue');
    expect(source).not.toContain('compactSessionLabel');
  });

  it('hides the Sessions footer and picker until recent-session support is confirmed', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain("const recentSessionsSupported = rtc.recentSessionsSupportStatus === 'supported';");
    expect(source).toContain("{recentSessionsSupported && sessionPickerOpen && (");
    expect(source).toContain("gridTemplateColumns: recentSessionsSupported ? '1fr 1fr 1fr' : '1fr 1fr'");
    expect(source).toContain('{recentSessionsSupported && (');
    expect(source).toContain('if (!recentSessionsSupported) setSessionPickerOpen(false);');
  });

  it('surfaces loading, refreshing, timeout, and updated-at feedback in the session picker', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('SessionListRequestPhase');
    expect(source).toContain('RECENT_SESSIONS_REFRESH_TIMEOUT_MS');
    expect(source).toContain('Loading recent sessions…');
    expect(source).toContain('REFRESHING…');
    expect(source).toContain('No refresh response yet');
    expect(source).toContain('Updated just now');
    expect(source).toContain('disabled={waiting}');
    expect(source).toContain('formatRecentSessionsUpdatedAt');
  });

  it('clears pending refresh state from response sequence changes instead of generatedAt changes', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('rtc.recentSessionsResponseSeq <= 0');
    expect(source).toContain('}, [rtc.recentSessionsResponseSeq]);');
    expect(source).not.toContain('}, [rtc.recentSessionsGeneratedAt]);');
  });
});
