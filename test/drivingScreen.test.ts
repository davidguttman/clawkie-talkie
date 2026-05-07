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
  it('lays out the driving header as status left, session label centered, settings right', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    const headerBlock = source.slice(
      source.indexOf('{/* header —'),
      source.indexOf('{/* caption —'),
    );
    const statusIndex = headerBlock.indexOf('{statePill}');
    const labelIndex = headerBlock.indexOf('{headerLabel}');
    const settingsIndex = headerBlock.indexOf('aria-label="Settings"');

    expect(statusIndex).toBeGreaterThan(-1);
    expect(labelIndex).toBeGreaterThan(statusIndex);
    expect(settingsIndex).toBeGreaterThan(labelIndex);

    expect(headerBlock).toContain("display: 'grid'");
    expect(headerBlock).toContain("gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)'");
    expect(headerBlock).toContain("gridColumn: '1'");
    expect(headerBlock).toContain("justifySelf: 'start'");
    expect(headerBlock).toContain("gridColumn: '1 / -1'");
    expect(headerBlock).toContain("justifySelf: 'center'");
    expect(headerBlock).toContain("maxWidth: compact ? 'calc(100% - 196px)' : 'calc(100% - 280px)'");
    expect(headerBlock).toContain("gridColumn: '3'");
    expect(headerBlock).toContain("justifySelf: 'end'");
    expect(headerBlock).toContain("overflow: 'hidden'");
    expect(headerBlock).toContain("textOverflow: 'ellipsis'");
  });

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
    expect(source).toMatch(/holdMusicMuted\s*\?\s*'⊘'\s*:\s*'◐'/);
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
    expect(source).toMatch(/const estimatedWordsSpoken\s*=\s*\(elapsedMs \/ 60000\) \* AI_RESPONSE_AUTOSCROLL_WPM;/);
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
    expect(source).toMatch(/el\.addEventListener\('touchstart', handleUserScrollIntent,\s*\{\s*passive: true,?\s*\}\);/);
    expect(source).toMatch(/el\.addEventListener\('pointerdown', handleUserScrollIntent,\s*\{\s*passive: true,?\s*\}\);/);
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

    expect(source).toMatch(/if \(code === 'openclaw_infer_stt_failed'\)\s*return 'INFER ERROR/);
    expect(source).toMatch(/if \(code === 'openclaw_infer_tts_failed'\)\s*return 'TTS ERROR/);
    expect(source).toMatch(/if \(code === 'openclaw_auth_unavailable'\)\s*return 'REPLY ERROR/);
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


describe('DrivingScreen active session favorite control', () => {
  it('renders a footer favorite button for the active session wired to RTC favorites', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('favoriteSession?: RecentSession;');
    expect(source).toContain('const favoriteSessionTarget = activeSession ?? favoriteSession;');
    expect(source).toContain('const activeSessionFavorite = Boolean(activeSession?.favorite);');
    expect(source).toContain('label="FAVORITE"');
    expect(source).toContain("icon={activeSessionFavorite ? '★' : '☆'}");
    expect(source).toContain("? 'Unfavorite session'");
    expect(source).toContain("ariaPressed={favoriteSessionTarget ? activeSessionFavorite : undefined}");
    expect(source).toContain('const selected = ariaPressed === true && !disabled;');
    expect(source).toContain('border: `1px solid ${selected ? `${HIFI.ai}aa` : HIFI.stroke}`');
    expect(source).toContain('background: selected ? `${HIFI.ai}18` : HIFI.surface');
    expect(source).toContain('color: disabled ? HIFI.ink4 : selected ? HIFI.ai : HIFI.ink');
    expect(source).toContain('boxShadow: selected ? `0 0 18px ${HIFI.ai}22` : undefined');
    expect(source).toContain('onClick={');
    expect(source).toContain('() => rtc.toggleRecentSessionFavorite(favoriteSessionTarget)');
    expect(source).toContain("'Favorite session unavailable'");
  });

  it('removes the old header favorite star', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');
    const header = source.slice(source.indexOf('{headerLabel}'), source.indexOf('aria-label="Settings"'));

    expect(header).not.toContain('toggleRecentSessionFavorite');
    expect(header).not.toContain('aria-pressed={activeSessionFavorite}');
  });
});

describe('DrivingScreen sessions navigation control', () => {
  it('renders fixed Replay, Favorite, Sessions footer buttons without an inline quick picker', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain("gridTemplateColumns: '1fr 1fr 1fr'");
    expect(source).toContain('label="REPLAY"');
    expect(source).toContain('label="FAVORITE"');
    expect(source).toContain('label="SESSIONS"');
    expect(source).toContain('onClick={onSessions}');
    expect(source).not.toContain('function SessionPicker(');
    expect(source).not.toContain('sessionPickerOpen');
    expect(source).not.toContain('requestRecentSessionList');
    expect(source).not.toContain('onSelectSession');
    expect(source).not.toContain('label="HISTORY"');
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

  it('wires the Sessions footer to the dashboard route instead of quick switcher state', () => {
    const appSource = readFileSync(resolve(root, 'client/src/app.tsx'), 'utf8');
    const drivingScreen = appSource.match(/<DrivingScreen\b[\s\S]*?\/>/)?.[0] ?? '';

    expect(drivingScreen).toContain("onSessions={() => go('dashboard')}");
    expect(drivingScreen).toContain('favoriteSession={currentSessionFavoriteCandidate}');
    expect(appSource).toContain('const currentSessionFavoriteCandidate = useMemo(');
    expect(appSource).toContain('() => favoriteSessionFromHandoff(activeHandoff)');
    expect(drivingScreen).not.toContain('onHistory={openHistory}');
    expect(drivingScreen).not.toContain('onSelectSession');
  });
});
