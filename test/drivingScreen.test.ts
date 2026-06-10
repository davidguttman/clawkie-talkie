// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentSession } from '../client/src/voice/protocol';

const mocks = vi.hoisted(() => ({
  rtc: { current: undefined as unknown },
  drivingLoop: { current: undefined as unknown },
}));

vi.mock('../client/src/rtc/RtcContext', () => ({
  useRtc: () => mocks.rtc.current,
}));

vi.mock('../client/src/voice/drivingLoop', () => ({
  useDrivingLoop: () => mocks.drivingLoop.current,
}));

import { DrivingScreen } from '../client/src/screens/Driving';
import { getHoldMusicMuted, setHoldMusicMuted } from '../client/src/voice/holdMusic';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const root = resolve(__dirname, '..');

function baseRtc(overrides: Record<string, unknown> = {}) {
  return {
    status: 'open',
    detail: '',
    sendControl: vi.fn(),
    sendBinary: vi.fn(),
    addControlListener: vi.fn(() => vi.fn()),
    addBinaryListener: vi.fn(() => vi.fn()),
    addRemoteStreamListener: vi.fn(() => vi.fn()),
    ttsCatalog: null,
    requestTtsCatalog: vi.fn(),
    sttCatalog: null,
    requestSttCatalog: vi.fn(),
    recentSessions: [],
    recentSessionsGeneratedAt: undefined,
    toggleRecentSessionFavorite: vi.fn(),
    recentSessionsResponseSeq: 0,
    recentSessionsSupportStatus: 'supported',
    requestRecentSessions: vi.fn(),
    retryConnection: vi.fn(),
    canRetryConnection: false,
    hasClient: true,
    ...overrides,
  };
}

function baseDrivingLoop(overrides: Record<string, unknown> = {}) {
  return {
    state: 'idle',
    liveText: '',
    isTranscribing: false,
    lastTurn: null,
    intensities: Array(28).fill(0.12),
    error: null,
    daemonConnected: true,
    tap: vi.fn(),
    silence: vi.fn(),
    ...overrides,
  };
}

async function renderDriving(props: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(DrivingScreen, { sessionId: 'session-1', ...props }));
  });
  return {
    container,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  mocks.rtc.current = baseRtc();
  mocks.drivingLoop.current = baseDrivingLoop();
  setHoldMusicMuted(false);
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(window, 'MediaMetadata', {
    configurable: true,
    value: undefined,
  });
});

type TestMediaSessionHandlers = Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>>;

function installTestMediaSession() {
  const handlers: TestMediaSessionHandlers = {};
  const mediaSession = {
    metadata: null as MediaMetadata | null,
    playbackState: 'none' as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      handlers[action] = handler;
    }),
  };
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: mediaSession,
  });
  return { handlers, mediaSession };
}

function installTestMediaMetadata() {
  class TestMediaMetadata {
    title: string;
    artist: string;
    album: string;
    artwork: readonly MediaImage[];

    constructor(init: MediaMetadataInit = {}) {
      this.title = init.title ?? '';
      this.artist = init.artist ?? '';
      this.album = init.album ?? '';
      this.artwork = init.artwork ?? [];
    }
  }

  Object.defineProperty(window, 'MediaMetadata', {
    configurable: true,
    value: TestMediaMetadata,
  });
}


describe('DrivingScreen OpenClaw session preview restore', () => {
  it('does not render the host id on the driving surface', async () => {
    const rendered = await renderDriving({ hostPeerId: 'secret-host-id' });

    expect(rendered.container.textContent).toContain('VOICE SESSION');
    expect(rendered.container.textContent).not.toContain('secret-host-id');
    expect(rendered.container.innerHTML).not.toContain('secret-host-id');

    await rendered.cleanup();
  });

  it('renders the active recent session assistant preview as the idle last AI caption', async () => {
    mocks.rtc.current = baseRtc({
      recentSessions: [
        {
          sessionId: 'session-1',
          sessionKey: 'agent:alpha:main',
          agent: 'alpha',
          displayLabel: 'Alpha session',
          lastMessageRole: 'user',
          lastMessagePreview: 'User preview must not become an AI caption.',
          lastAssistantPreview: 'OpenClaw assistant preview restored on open.',
        },
      ],
    });

    const rendered = await renderDriving();

    expect(rendered.container.textContent).toContain('OpenClaw assistant preview restored on open.');
    expect(rendered.container.textContent).not.toContain('User preview must not become an AI caption.');
    expect(rendered.container.textContent).toContain('READY');
    expect(rendered.container.textContent).toContain('TAP TO TALK');
    expect(rendered.container.textContent).not.toContain('TAP TO SILENCE');

    await rendered.cleanup();
  });

  it('keeps local restored assistant text ahead of the OpenClaw preview', async () => {
    mocks.rtc.current = baseRtc({
      recentSessions: [
        {
          sessionId: 'session-1',
          sessionKey: 'agent:alpha:main',
          agent: 'alpha',
          displayLabel: 'Alpha session',
          lastAssistantPreview: 'OpenClaw preview should stay hidden.',
        },
      ],
    });

    const rendered = await renderDriving({ restoredAssistantText: 'Local Clawkie transcript restore wins.' });

    expect(rendered.container.textContent).toContain('Local Clawkie transcript restore wins.');
    expect(rendered.container.textContent).not.toContain('OpenClaw preview should stay hidden.');

    await rendered.cleanup();
  });

  it('uses a selected favorite session assistant preview when recent sessions have not hydrated it yet', async () => {
    const favoriteSession: RecentSession = {
      sessionId: 'session-1',
      sessionKey: 'agent:alpha:main',
      agent: 'alpha',
      displayLabel: 'Favorite Alpha',
      lastAssistantPreview: 'Favorite assistant preview restored.',
    };

    const rendered = await renderDriving({ favoriteSession });

    expect(rendered.container.textContent).toContain('Favorite assistant preview restored.');

    await rendered.cleanup();
  });
});

describe('DrivingScreen waveform wiring', () => {
  it('passes driving loop intensities directly to LiveWave', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).not.toContain('idleIntensities');
    expect(source).not.toContain('Math.sin');
    expect(source).not.toContain('waveIntensities');
    expect(source).toContain('intensities={displayIntensities}');
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

  it('lets manual replay override the driving loop with visible, silenceable AI playback UI', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('manualReplay?: DrivingManualReplay | null;');
    expect(source).toContain("const replayActive = !!manualReplay;");
    expect(source).toContain("const displayState: DrivingState = replayActive ? 'ai' : state;");
    expect(source).toContain('const displayTap = replayActive ? manualReplay.onSilence : tap;');
    expect(source).toContain('liveText: manualReplay?.text ?? liveText');
    expect(source).toContain('state={displayState}');
    expect(source).toContain('const triggerPrimaryVoiceAction = useCallback');
    expect(source).toContain('displayTap();');
    expect(source).toContain('onTap={triggerPrimaryVoiceAction}');
  });

  it('uses restored assistant text or an active session assistant preview as the idle last turn when the loop has no last turn yet', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('restoredAssistantText?: string | null;');
    expect(source).toContain('const restoredAssistantPreview');
    expect(source).toContain('trimString(restoredAssistantText) ||');
    expect(source).toContain('trimString(activeSession?.lastAssistantPreview) ||');
    expect(source).toContain('trimString(favoriteSession?.lastAssistantPreview)');
    expect(source).toContain('const restoredLastTurn');
    expect(source).toContain("state === 'idle' && restoredAssistantPreview");
    expect(source).toContain("{ who: 'ai' as const, text: restoredAssistantPreview }");
    expect(source).toContain('lastTurn: replayActive ? null : (lastTurn ?? restoredLastTurn)');
  });

  it('gates the replay footer button on an explicit canReplay prop', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('canReplay = false');
    expect(source).toContain('onReplay && canReplay');
    expect(source).not.toContain('ReplayNotice');
    expect(source).not.toContain('replayNotice');
  });
});

describe('DrivingScreen media-session headset control', () => {
  it('does not throw when MediaSession is unavailable', async () => {
    const rendered = await renderDriving();

    expect(rendered.container.textContent).toContain('TAP TO TALK');

    await rendered.cleanup();
  });

  it('maps play/pause media actions to the active PTT behavior', async () => {
    const { handlers, mediaSession } = installTestMediaSession();
    const rendered = await renderDriving();

    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('play', expect.any(Function));
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('pause', expect.any(Function));

    act(() => {
      handlers.play?.({ action: 'play' });
    });
    act(() => {
      handlers.pause?.({ action: 'pause' });
    });

    expect(mocks.drivingLoop.current.tap).toHaveBeenCalledTimes(2);

    await rendered.cleanup();
  });

  it('publishes standards-based metadata and playback state for Chrome/Android controls', async () => {
    installTestMediaMetadata();
    const { mediaSession } = installTestMediaSession();
    mocks.rtc.current = baseRtc({
      recentSessions: [
        {
          sessionId: 'session-1',
          sessionKey: 'agent:alpha:main',
          agent: 'alpha',
          displayLabel: 'Alpha session',
        },
      ],
    });

    const idle = await renderDriving();

    expect(mediaSession.metadata?.title).toBe('Clawkie Talkie');
    expect(mediaSession.metadata?.artist).toBe('alpha - Alpha session');
    expect(mediaSession.metadata?.artwork).toEqual([
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ]);
    expect(mediaSession.playbackState).toBe('paused');

    await idle.cleanup();

    mocks.drivingLoop.current = baseDrivingLoop({ state: 'ai' });
    const ai = await renderDriving();

    expect(mediaSession.playbackState).toBe('playing');

    await ai.cleanup();
  });

  it('uses real playback states for thinking hold music without fake keepalive audio', async () => {
    const { mediaSession } = installTestMediaSession();
    mocks.drivingLoop.current = baseDrivingLoop({ state: 'thinking' });

    const audibleThinking = await renderDriving();

    expect(mediaSession.playbackState).toBe('playing');

    await audibleThinking.cleanup();

    setHoldMusicMuted(true);
    const mutedMedia = installTestMediaSession();
    mocks.drivingLoop.current = baseDrivingLoop({ state: 'thinking' });
    const mutedThinking = await renderDriving();

    expect(mutedMedia.mediaSession.playbackState).toBe('paused');

    await mutedThinking.cleanup();
  });

  it('uses the replay silence and thinking mute paths like the on-screen PTT button', async () => {
    const { handlers } = installTestMediaSession();
    const onSilence = vi.fn();
    const replay = await renderDriving({
      manualReplay: { text: 'Replay response', mode: 'audio', analyser: null, onSilence },
    });

    act(() => {
      handlers.play?.({ action: 'play' });
    });

    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(mocks.drivingLoop.current.tap).not.toHaveBeenCalled();

    await replay.cleanup();

    const thinkingMedia = installTestMediaSession();
    mocks.drivingLoop.current = baseDrivingLoop({ state: 'thinking' });
    const thinking = await renderDriving();

    expect(getHoldMusicMuted()).toBe(false);
    act(() => {
      thinkingMedia.handlers.pause?.({ action: 'pause' });
    });

    expect(getHoldMusicMuted()).toBe(true);
    expect(mocks.drivingLoop.current.tap).not.toHaveBeenCalled();

    await thinking.cleanup();
  });

  it('documents the Chrome/Android first-idle-press caveat without hidden audio hacks', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('The first idle headset press may still depend on Chrome having an active');
    expect(source).toContain('do not add hidden/silent audio');
    expect(source).toContain("const MEDIA_SESSION_PTT_ACTIONS: MediaSessionAction[] = ['play', 'pause'];");
  });

  it('clears play/pause handlers on unmount', async () => {
    const { handlers, mediaSession } = installTestMediaSession();
    const rendered = await renderDriving();

    expect(typeof handlers.play).toBe('function');
    expect(typeof handlers.pause).toBe('function');

    await rendered.cleanup();

    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('play', null);
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('pause', null);
    expect(handlers.play).toBeNull();
    expect(handlers.pause).toBeNull();
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

describe('DrivingScreen caption readability', () => {
  it('uses a larger named font size for compact driving captions', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('COMPACT_DRIVING_CAPTION_FONT_SIZE = 22');
    expect(source).toContain('DEFAULT_DRIVING_CAPTION_FONT_SIZE = 16');
    expect(source).toContain('const captionFontMetrics = compact ? COMPACT_DRIVING_CAPTION_METRICS : DEFAULT_DRIVING_CAPTION_METRICS;');
    expect(source).toContain('fontSize: captionFontMetrics.fontSize');
    expect(source).toContain('lineHeight: captionFontMetrics.lineHeight');
    expect(source).toContain('height: captionFontMetrics.caretHeight');
    expect(source).toContain('AI_RESPONSE_AUTOSCROLL_WPM = 175');
    expect(source).toContain('AI_RESPONSE_AUTOSCROLL_START_WORDS = 18');
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
    expect(source).toMatch(/DEFAULT_AI_RESPONSE_AUTOSCROLL_METRICS\s*=\s*\{[\s\S]*?wpm:\s*AI_RESPONSE_AUTOSCROLL_WPM,[\s\S]*?startWords:\s*AI_RESPONSE_AUTOSCROLL_START_WORDS,[\s\S]*?intervalMs:\s*AI_RESPONSE_AUTOSCROLL_INTERVAL_MS,[\s\S]*?viewportAnchor:\s*AI_RESPONSE_AUTOSCROLL_VIEWPORT_ANCHOR,[\s\S]*?easing:\s*AI_RESPONSE_AUTOSCROLL_EASING,[\s\S]*?\}/);
    expect(source).toContain('const startedAtMs = Date.now();');
    expect(source).toMatch(/const estimatedWordsSpoken\s*=\s*\(elapsedMs \/ 60000\) \* aiResponseAutoscrollMetrics\.wpm;/);
    expect(source).toContain('if (estimatedWordsSpoken < aiResponseAutoscrollMetrics.startWords) return;');
    expect(source).toContain('const readingProgress = Math.min(estimatedWordsSpoken / totalWords, 1);');
    expect(source).toContain('aiResponseAutoscrollMetrics.easing');
    expect(source).toContain('setProgrammaticScrollTop(el, Math.min(targetScrollTop, easedScrollTop));');
  });

  it('uses slower tuned AI response autoscroll metrics in compact caption mode', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('COMPACT_AI_RESPONSE_AUTOSCROLL_METRICS');
    expect(source).toMatch(/COMPACT_AI_RESPONSE_AUTOSCROLL_METRICS\s*=\s*\{[\s\S]*?wpm:\s*135,[\s\S]*?viewportAnchor:\s*0\.5,[\s\S]*?easing:\s*0\.22,[\s\S]*?\}/);
    expect(source).toMatch(/const aiResponseAutoscrollMetrics\s*=\s*compact[\s\S]*?\? COMPACT_AI_RESPONSE_AUTOSCROLL_METRICS[\s\S]*?: DEFAULT_AI_RESPONSE_AUTOSCROLL_METRICS;/);
    expect(source).toContain('approximateReadingY - el.clientHeight * aiResponseAutoscrollMetrics.viewportAnchor');
    expect(source).toContain('(targetScrollTop - el.scrollTop) * aiResponseAutoscrollMetrics.easing');
  });

  it('bottom-follows appended live user transcription without reusing AI response scroll timing', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toContain('LIVE_USER_CAPTION_LABEL');
    expect(source).toContain('isLiveUserCaption');
    expect(source).toContain('lastLiveUserTextRef');
    expect(source).toContain('autoScrollDisabledForLiveUserRef');
    expect(source).toContain('setProgrammaticScrollTop(el, el.scrollHeight - el.clientHeight);');

    const liveUserScrollEffect = source.match(/if \(!isLiveUserCaption \|\| !caption\.live\) \{[\s\S]*?setProgrammaticScrollTop\(el, el\.scrollHeight - el\.clientHeight\);[\s\S]*?\}, \[caption\.live, caption\.text, isLiveUserCaption, setProgrammaticScrollTop\]\);/)?.[0] ?? '';
    expect(liveUserScrollEffect).toContain('if (!isLiveUserCaption || !caption.live) {');
    expect(liveUserScrollEffect).toContain('autoScrollDisabledForLiveUserRef.current = false;');
    expect(liveUserScrollEffect).toContain('if (!caption.text || autoScrollDisabledForLiveUserRef.current) return;');
    expect(liveUserScrollEffect).not.toContain('AI_RESPONSE_AUTOSCROLL_INTERVAL_MS');
    expect(liveUserScrollEffect).not.toContain('AI_RESPONSE_AUTOSCROLL_WPM');
    expect(liveUserScrollEffect).not.toContain('DEFAULT_AI_RESPONSE_AUTOSCROLL_METRICS');
    expect(liveUserScrollEffect).not.toContain('COMPACT_AI_RESPONSE_AUTOSCROLL_METRICS');
    expect(liveUserScrollEffect).not.toContain('aiResponseAutoscrollMetrics');
  });

  it('keeps live user scroll opt-out when STT corrections shrink the same recording', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');
    const liveUserScrollEffect = source.match(/if \(!isLiveUserCaption \|\| !caption\.live\) \{[\s\S]*?setProgrammaticScrollTop\(el, el\.scrollHeight - el\.clientHeight\);[\s\S]*?\}, \[caption\.live, caption\.text, isLiveUserCaption, setProgrammaticScrollTop\]\);/)?.[0] ?? '';

    expect(liveUserScrollEffect).toContain('const isNewLiveUserCapture = lastLiveUserTextRef.current === null;');
    expect(liveUserScrollEffect).toContain('lastLiveUserTextRef.current = liveUserText;');
    expect(liveUserScrollEffect).not.toContain('liveUserText.length <');
    expect(liveUserScrollEffect).not.toContain('lastLiveUserText.length');
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
  it('surfaces infer STT and reply auth failures with distinct fatal labels', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toMatch(/if \(code === 'openclaw_infer_stt_failed'\)\s*return 'INFER ERROR/);
    expect(source).toMatch(/if \(code === 'openclaw_auth_unavailable'\)\s*return 'REPLY ERROR/);
  });

  it('surfaces TTS failure (including timeout suffixes) as a non-fatal audio-only message that points the user at the thread', () => {
    const source = readFileSync(resolve(root, 'client/src/screens/Driving.tsx'), 'utf8');

    expect(source).toMatch(/code\.startsWith\('openclaw_infer_tts_failed'\)/);
    expect(source).toMatch(/AUDIO UNAVAILABLE · REPLY IS IN THE THREAD/);
    expect(source).not.toMatch(/'openclaw_infer_tts_failed'\)\s*return 'TTS ERROR/);
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
