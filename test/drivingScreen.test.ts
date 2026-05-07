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
    const settingsButton = source.slice(
      Math.max(0, source.indexOf('aria-label="Settings"') - 760),
      source.indexOf('aria-label="Settings"') + 420,
    );

    expect(source).toContain('{onSettings && (');
    expect(source).toContain('aria-label="Settings"');
    expect(settingsButton).toContain('width: 48');
    expect(settingsButton).toContain('height: 48');
    expect(settingsButton).toContain('fontSize: 32');
    expect(settingsButton).toContain('lineHeight: 1');
    expect(settingsButton).toContain('aria-hidden="true"');
    expect(settingsButton).toContain('⚙︎');
    expect(settingsButton).not.toContain('width: 38');
    expect(settingsButton).not.toContain('height: 38');
    expect(settingsButton).not.toContain('fontSize: 21');
    expect(settingsButton).not.toContain('width: 30');
    expect(settingsButton).not.toContain('height: 30');
    expect(settingsButton).not.toContain('fontSize: 15');
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
  it('resets new AI response captions to the top before heuristic scrolling starts', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('AI_RESPONSE_CAPTION_LABEL');
    expect(source).toContain('isAiResponseCaption');
    expect(source).toContain('lastAiResponseTextRef');
    expect(source).toContain('setProgrammaticScrollTop(el, 0);');
    expect(source).toContain('autoScrollDisabledForResponseRef.current = false;');
    expect(source).not.toContain('el.scrollTop = el.scrollHeight');
    expect(source).not.toContain('scrollTop = scrollHeight');
  });

  it('uses elapsed WPM word progress to gradually auto-scroll live AI responses', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('AI_RESPONSE_AUTOSCROLL_WPM');
    expect(source).toContain('AI_RESPONSE_AUTOSCROLL_START_WORDS');
    expect(source).toContain('AI_RESPONSE_AUTOSCROLL_INTERVAL_MS');
    expect(source).toContain('const startedAtMs = Date.now();');
    expect(source).toContain('const estimatedWordsSpoken = (elapsedMs / 60000) * AI_RESPONSE_AUTOSCROLL_WPM;');
    expect(source).toContain('if (estimatedWordsSpoken < AI_RESPONSE_AUTOSCROLL_START_WORDS) return;');
    expect(source).toContain('const readingProgress = Math.min(estimatedWordsSpoken / totalWords, 1);');
    expect(source).toContain('AI_RESPONSE_AUTOSCROLL_EASING');
    expect(source).toContain('setProgrammaticScrollTop(el, Math.min(targetScrollTop, easedScrollTop));');
  });

  it('cancels AI response auto-scroll on explicit user intent even during programmatic scroll grace', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain("if (!isAiResponseCaption || !caption.live || !caption.text) return;");
    expect(source).toContain('return () => window.clearInterval(interval);');

    const scrollHandler = source.match(/const handleScroll = \(\) => \{[\s\S]*?\n    \};/)?.[0] ?? '';
    expect(scrollHandler).toContain('if (programmaticScrollRef.current) return;');
    expect(scrollHandler).toContain('autoScrollDisabledForResponseRef.current = true;');

    const userIntentHandler = source.match(/const handleUserScrollIntent = \(\) => \{[\s\S]*?\n    \};/)?.[0] ?? '';
    expect(userIntentHandler).toContain('autoScrollDisabledForResponseRef.current = true;');
    expect(userIntentHandler).not.toContain('programmaticScrollRef');

    expect(source).toContain("el.addEventListener('scroll', handleScroll, { passive: true });");
    expect(source).toContain("el.addEventListener('wheel', handleUserScrollIntent, { passive: true });");
    expect(source).toContain("el.addEventListener('touchstart', handleUserScrollIntent, { passive: true });");
    expect(source).toContain("el.addEventListener('pointerdown', handleUserScrollIntent, { passive: true });");
    expect(source).toContain("el.addEventListener('keydown', handleUserScrollIntent);");
    expect(source).toContain("el.removeEventListener('wheel', handleUserScrollIntent);");
    expect(source).toContain("el.removeEventListener('touchstart', handleUserScrollIntent);");
    expect(source).toContain("el.removeEventListener('pointerdown', handleUserScrollIntent);");
    expect(source).toContain("el.removeEventListener('keydown', handleUserScrollIntent);");
    expect(source).toContain('if (autoScrollDisabledForResponseRef.current) {');
    expect(source).toContain('window.clearInterval(interval);');
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

describe('DrivingScreen connection retry control', () => {
  it('passes the RTC retry API into the caption and renders a Reconnect button for PWA users', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('canRetryConnection={rtc.canRetryConnection}');
    expect(source).toContain('onRetryConnection={rtc.retryConnection}');
    expect(source).toContain('canRetryConnection && onRetryConnection');
    expect(source).toContain('RECONNECT');
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
    expect(buildHeaderLabel).toContain('return `${agent} - ${displayLabel}`;');
    expect(buildHeaderLabel).toContain('if (displayLabel) return displayLabel;');
    expect(buildHeaderLabel).toContain('if (agent) return agent;');
    expect(buildHeaderLabel).toContain("return 'VOICE SESSION';");
    expect(buildHeaderLabel).not.toContain('`${displayLabel} · ${agent}`');
    expect(buildHeaderLabel).not.toContain('VOICE SESSION · ${agent}');
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
