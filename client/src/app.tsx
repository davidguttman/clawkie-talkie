import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { HIFI } from './tokens';
import { HiFiPhone } from './components/Phone';
import { DrivingScreen } from './screens/Driving';
import { DashboardScreen } from './screens/Dashboard';
import { HistoryScreen } from './screens/History';
import { TranscriptScreen } from './screens/Transcript';
import { SettingsScreen } from './screens/Settings';
import { ErrorScreen, type ErrorKind } from './screens/ErrorScreen';
import { normalizeVoiceSettingsForRtc, RtcProvider, useRtc } from './rtc/RtcContext';
import {
  latestAssistantText,
  loadLastDashboardHostPeerId,
  loadSettings,
  loadTranscriptSession,
  saveLastDashboardHostPeerId,
  saveSettings,
  type Settings,
} from './storage';
import {
  canReplayAssistantReply,
  replayAssistantReply,
  subscribeReplayAvailabilityChanges,
} from './replay';
import {
  canSpeakReplayText,
  getLastBufferedReplyAudio,
  playBufferedReplyAudio,
  speakReplayText,
} from './voice/tts';
import { formatHandoffHash, parseHandoffUrl, parseHostDashboardUrl, type HandoffRoute } from './voice/handoffUrl';
import type { RecentSession, VoiceSettings } from './voice/protocol';
import { computeIsNarrow } from './responsive';

type ScreenId = 'dashboard' | 'driving' | 'transcript' | 'error';

export function parseInitialSearch(search: string): {
  screen: ScreenId;
  errorKind: ErrorKind;
  hostPeerId: string | null;
  sessionId?: string;
  threadId?: string;
} {
  const params = new URLSearchParams(search);
  const errorKind: ErrorKind =
    params.get('errorKind') === 'replaced' ? 'replaced' : 'bad_session';
  const hostPeerId = params.get('host')?.trim() || null;
  const sessionId = params.get('session') || undefined;
  const threadId = params.get('threadId') || undefined;
  return { screen: 'error', errorKind, hostPeerId, sessionId, threadId };
}

export function parseInitialLocation(
  location: { pathname?: string; search: string; hash: string },
  options: { savedDashboardHostPeerId?: string | null } = {},
) {
  const legacy = parseInitialSearch(location.search);
  const pathname = location.pathname || '/voice';
  // Hash-first handoff URLs (preferred) — keep identifiers off the wire.
  const handoff = parseHandoffUrl(
    pathname + (location.search || '') + (location.hash || ''),
  );
  if (handoff) {
    return {
      ...legacy,
      screen: 'driving' as ScreenId,
      hostPeerId: handoff.hostPeerId,
      sessionId: handoff.sessionId,
      handoff,
    };
  }
  const dashboard = parseHostDashboardUrl(
    pathname + (location.search || '') + (location.hash || ''),
  );
  if (dashboard) {
    return {
      ...legacy,
      screen: 'dashboard' as ScreenId,
      hostPeerId: dashboard.hostPeerId,
      sessionId: undefined,
      handoff: null as HandoffRoute | null,
    };
  }
  const savedDashboardHostPeerId = options.savedDashboardHostPeerId?.trim();
  const dashboardPath = pathname.replace(/\/$/, '') === '/dashboard';
  if (dashboardPath && savedDashboardHostPeerId) {
    return {
      ...legacy,
      screen: 'dashboard' as ScreenId,
      hostPeerId: savedDashboardHostPeerId,
      sessionId: undefined,
      handoff: null as HandoffRoute | null,
    };
  }
  return { ...legacy, handoff: null as HandoffRoute | null };
}

function parseInitial() {
  const initial = parseInitialLocation(window.location, {
    savedDashboardHostPeerId: loadLastDashboardHostPeerId(),
  });
  if (initial.hostPeerId && (initial.screen === 'dashboard' || initial.screen === 'driving')) {
    saveLastDashboardHostPeerId(initial.hostPeerId);
  }
  return initial;
}

export function voiceSettingsForRtc(settings: Settings): VoiceSettings {
  return normalizeVoiceSettingsForRtc({
    tts: settings.tts,
    stt: settings.stt,
    voice: settings.voice,
  }) ?? {};
}


export function handoffToRendezvous(handoff: HandoffRoute) {
  return {
    sessionId: handoff.sessionId,
    ...(handoff.sessionKey ? { sessionKey: handoff.sessionKey } : {}),
    ...(handoff.channel ? { channel: handoff.channel } : {}),
    ...(handoff.target ? { target: handoff.target } : {}),
    ...(handoff.accountId ? { accountId: handoff.accountId } : {}),
  };
}

export function selectHandoffFromRecentSession(
  current: HandoffRoute | null,
  session: RecentSession,
  fallbackHostPeerId?: string | null,
): HandoffRoute | null {
  const hostPeerId = current?.hostPeerId ?? fallbackHostPeerId ?? null;
  if (!hostPeerId) return current;
  return {
    hostPeerId,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    ...(session.channel ? { channel: session.channel } : {}),
    ...(session.target ? { target: session.target } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
  };
}

export function favoriteSessionFromHandoff(handoff: HandoffRoute | null): RecentSession | undefined {
  const sessionId = trimHandoffString(handoff?.sessionId);
  const sessionKey = trimHandoffString(handoff?.sessionKey);
  if (!sessionId || !sessionKey) return undefined;

  const parsed = parseFavoriteSessionKey(sessionKey);
  const channel = trimHandoffString(handoff?.channel) ?? parsed.channel;
  const target = trimHandoffString(handoff?.target) ?? parsed.target;
  const accountId = trimHandoffString(handoff?.accountId);
  const agent = parsed.agent ?? 'unknown';

  return {
    sessionId,
    sessionKey,
    agent,
    ...(channel ? { channel } : {}),
    ...(target ? { target } : {}),
    ...(accountId ? { accountId } : {}),
    displayLabel: buildFavoriteSessionDisplayLabel(sessionKey, channel, target),
  };
}

function parseFavoriteSessionKey(sessionKey: string): { agent?: string; channel?: string; target?: string } {
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  if (parts[0] !== 'agent') return {};
  const agent = parts[1];
  const channel = parts[2];
  if (!channel) return { ...(agent ? { agent } : {}) };

  const kind = parts[3];
  const id = parts.at(-1);
  const targetKind = channel === 'discord' && kind === 'direct' ? 'user' : kind;
  return {
    ...(agent ? { agent } : {}),
    channel,
    ...(targetKind && id && id !== kind ? { target: `${targetKind}:${id}` } : {}),
  };
}

function buildFavoriteSessionDisplayLabel(sessionKey: string, channel?: string, target?: string): string {
  if (channel && target) return `${channel} ${target}`;
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  const visibleParts = parts[0] === 'agent' ? parts.slice(2) : parts;
  return visibleParts.length > 0 ? visibleParts.join(' ') : 'Voice session';
}

function trimHandoffString(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function App() {
  const initial = useMemo(parseInitial, []);
  const [screen, setScreen] = useState<ScreenId>(initial.screen);
  const [activeHandoff, setActiveHandoff] = useState<HandoffRoute | null>(initial.handoff);
  const [openSession, setOpenSession] = useState<string | undefined>(initial.sessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings(initial.hostPeerId));
  const [replayAvailabilityTick, setReplayAvailabilityTick] = useState(0);
  const [isNarrow, setIsNarrow] = useState(computeIsNarrow);

  useEffect(() => {
    saveSettings(settings, initial.hostPeerId);
  }, [settings, initial.hostPeerId]);

  useEffect(() => {
    const onResize = () => setIsNarrow(computeIsNarrow());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return subscribeReplayAvailabilityChanges(() => {
      setReplayAvailabilityTick((tick) => tick + 1);
    });
  }, []);

  const go = useCallback((s: ScreenId) => {
    setScreen(s);
  }, []);
  const openSettings = useCallback(() => {
    setHistoryOpen(false);
    setSettingsOpen(true);
  }, []);
  const openHistory = useCallback(() => {
    setSettingsOpen(false);
    setHistoryOpen(true);
  }, []);

  const compact = isNarrow;
  const activeHostPeerId = activeHandoff?.hostPeerId ?? initial.hostPeerId;
  const currentSessionId =
    screen === 'driving' ? activeHandoff?.sessionId ?? initial.sessionId : openSession || activeHandoff?.sessionId || initial.sessionId;

  const rtcVoiceSettings = useMemo(() => voiceSettingsForRtc(settings), [settings]);
  const currentSessionFavoriteCandidate = useMemo(
    () => favoriteSessionFromHandoff(activeHandoff),
    [activeHandoff],
  );

  const selectRecentSession = useCallback((session: RecentSession) => {
    const next = selectHandoffFromRecentSession(
      activeHandoff ?? initial.handoff,
      session,
      activeHostPeerId,
    );
    if (!next) return;
    setActiveHandoff(next);
    setOpenSession(next.sessionId);
    setScreen('driving');
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState(null, '', `/voice${formatHandoffHash(next)}`);
    }
  }, [activeHandoff, initial.handoff, activeHostPeerId]);

  const replayLastReply = useCallback(async () => {
    const session = currentSessionId ? loadTranscriptSession(currentSessionId) : null;
    try {
      await replayAssistantReply({
        audio: getLastBufferedReplyAudio(),
        text: latestAssistantText(session),
        canSpeakText: canSpeakReplayText(),
        playAudio: playBufferedReplyAudio,
        speakText: speakReplayText,
      });
    } catch {
      // The replay button is only enabled when a source exists, but playback
      // can still fail if the browser rejects audio at the last moment.
    }
  }, [currentSessionId]);

  const canReplayLastReply = useMemo(() => {
    void replayAvailabilityTick;
    const session = currentSessionId ? loadTranscriptSession(currentSessionId) : null;
    return canReplayAssistantReply({
      audio: getLastBufferedReplyAudio(),
      text: latestAssistantText(session),
      canSpeakText: canSpeakReplayText(),
    });
  }, [currentSessionId, replayAvailabilityTick]);

  const screenContent = (
    <>
      {screen === 'dashboard' && (
        <DashboardScreen
          hostPeerId={activeHostPeerId}
          onSelectSession={selectRecentSession}
          onHistory={openHistory}
          onSettings={openSettings}
          compact={compact}
        />
      )}
      {screen === 'driving' && (
        <DrivingScreen
          accent="amber"
          fontMode="mono"
          onReplay={
            currentSessionId
              ? replayLastReply
              : undefined
          }
          canReplay={canReplayLastReply}
          onSessions={() => go('dashboard')}
          onSettings={openSettings}
          compact={compact}
          sessionId={activeHandoff?.sessionId ?? initial.sessionId}
          hostPeerId={activeHostPeerId}
          threadId={initial.threadId}
          favoriteSession={currentSessionFavoriteCandidate}
        />
      )}
      {screen === 'transcript' && (
        currentSessionId ? (
          <TranscriptScreen
            sessionId={currentSessionId}
            onBack={() => go('driving')}
            compact={compact}
            settings={settings}
          />
        ) : (
          <ErrorScreen
            kind="bad_session"
            onDismiss={() => go('driving')}
            onRetry={() => go('driving')}
            onBack={() => go('driving')}
          />
        )
      )}
      {screen === 'error' && (
        <ErrorScreen
          kind={initial.errorKind}
          onDismiss={() => go('driving')}
          onRetry={() => go('driving')}
          onBack={() => go('driving')}
        />
      )}
    </>
  );

  const overlayOpen = settingsOpen || historyOpen;
  const baseContentIsolationProps: { 'aria-hidden'?: true; inert?: '' } = overlayOpen
    ? { 'aria-hidden': true, inert: '' }
    : {};
  const appContent = (
    <div
      style={{
        position: 'relative',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div {...baseContentIsolationProps} style={{ height: '100%', minHeight: 0 }}>
        {screenContent}
      </div>
      {historyOpen && (
        <HistoryOverlay
          onClose={() => setHistoryOpen(false)}
          onOpenSession={(sessionId) => {
            setHistoryOpen(false);
            setOpenSession(sessionId);
            go('transcript');
          }}
          compact={compact}
        />
      )}
      {settingsOpen && (
        <SettingsOverlay
          setSettingsOpen={setSettingsOpen}
          settings={settings}
          setSettings={setSettingsState}
          compact={compact}
        />
      )}
    </div>
  );

  return (
    <RtcProvider
      hostPeerId={activeHostPeerId ?? undefined}
      rendezvous={activeHandoff ? handoffToRendezvous(activeHandoff) : null}
      voiceSettings={rtcVoiceSettings}
    >
      <RtcDisconnectGate isNarrow={isNarrow}>
        <ResponsiveRuntime isNarrow={isNarrow}>{appContent}</ResponsiveRuntime>
      </RtcDisconnectGate>
    </RtcProvider>
  );
}

function HistoryOverlay({
  onClose,
  onOpenSession,
  compact,
}: {
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  compact: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        aria-hidden="true"
        onClick={() => undefined}
        onPointerDown={() => undefined}
        onTouchStart={() => undefined}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          background: 'rgba(0, 0, 0, 0.42)',
          pointerEvents: 'auto',
          touchAction: 'none',
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="History"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          minHeight: 0,
          outline: 'none',
          background: HIFI.bg,
          pointerEvents: 'auto',
        }}
      >
        <HistoryScreen onBack={onClose} onOpenSession={onOpenSession} compact={compact} />
      </div>
    </div>
  );
}

function SettingsOverlay({
  setSettingsOpen,
  settings,
  setSettings,
  compact,
}: {
  setSettingsOpen: (open: boolean) => void;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  compact: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { ttsCatalog, requestTtsCatalog, sttCatalog, requestSttCatalog } = useRtc();

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        aria-hidden="true"
        onClick={() => undefined}
        onPointerDown={() => undefined}
        onTouchStart={() => undefined}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          background: 'rgba(0, 0, 0, 0.42)',
          pointerEvents: 'auto',
          touchAction: 'none',
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setSettingsOpen(false);
          }
        }}
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          minHeight: 0,
          outline: 'none',
          background: HIFI.bg,
          pointerEvents: 'auto',
        }}
      >
        <SettingsScreen
          onBack={() => setSettingsOpen(false)}
          settings={settings}
          setSettings={setSettings}
          ttsCatalog={ttsCatalog}
          onRefreshTtsCatalog={requestTtsCatalog}
          sttCatalog={sttCatalog}
          onRefreshSttCatalog={requestSttCatalog}
          compact={compact}
        />
      </div>
    </div>
  );
}

function RtcDisconnectGate({
  isNarrow,
  children,
}: {
  isNarrow: boolean;
  children: ReactNode;
}) {
  const rtc = useRtc();
  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  if (rtc.detail !== 'session_replaced') return <>{children}</>;

  const replaced = (
    <ErrorScreen
      kind="replaced"
      onDismiss={reload}
      onRetry={reload}
      onBack={reload}
    />
  );

  return <ResponsiveRuntime isNarrow={isNarrow}>{replaced}</ResponsiveRuntime>;
}

function ResponsiveRuntime({
  isNarrow,
  children,
}: {
  isNarrow: boolean;
  children: ReactNode;
}) {
  if (isNarrow) {
    return <RuntimeShell>{children}</RuntimeShell>;
  }

  return (
    <DesktopPhoneShell>
      <HiFiPhone>{children}</HiFiPhone>
    </DesktopPhoneShell>
  );
}

function DesktopPhoneShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        width: '100%',
        background: HIFI.bg,
        color: HIFI.ink,
        fontFamily: HIFI.fonts.sans,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

function RuntimeShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="runtime-scroll"
      style={{
        minHeight: '100dvh',
        height: '100dvh',
        width: '100%',
        maxWidth: '100vw',
        background: HIFI.bg,
        color: HIFI.ink,
        fontFamily: HIFI.fonts.sans,
        display: 'flex',
        flexDirection: 'column',
        overflowX: 'hidden',
        boxSizing: 'border-box',
        // Fixed 14px horizontal gutter so we don't depend on asymmetric
        // `env(safe-area-inset-left/right)` behavior across browsers. Vertical
        // still honors notch/home indicator.
        paddingTop: 'env(safe-area-inset-top, 0)',
        paddingBottom: 'env(safe-area-inset-bottom, 0)',
        paddingLeft: 'calc(14px + env(safe-area-inset-left, 0px))',
        paddingRight: 'calc(14px + env(safe-area-inset-right, 0px))',
      }}
    >
      {children}
    </div>
  );
}
