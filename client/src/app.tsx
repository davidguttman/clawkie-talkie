import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { HIFI } from './tokens';
import { HiFiPhone } from './components/Phone';
import { DrivingScreen } from './screens/Driving';
import { HistoryScreen } from './screens/History';
import { TranscriptScreen } from './screens/Transcript';
import { SettingsScreen } from './screens/Settings';
import { ErrorScreen, type ErrorKind } from './screens/ErrorScreen';
import { normalizeVoiceSettingsForRtc, RtcProvider, useRtc } from './rtc/RtcContext';
import {
  latestAssistantText,
  loadSettings,
  loadTranscriptSession,
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
import { parseHandoffUrl, type HandoffRoute } from './voice/handoffUrl';
import type { RecentSessionEntry, VoiceSettings } from './voice/protocol';
import { computeIsNarrow } from './responsive';

type ScreenId = 'driving' | 'transcript' | 'error';

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

export function parseInitialLocation(location: { search: string; hash: string }) {
  const legacy = parseInitialSearch(location.search);
  // Hash-first handoff URLs (preferred) — keep identifiers off the wire.
  const handoff = parseHandoffUrl(
    '/voice' + (location.search || '') + (location.hash || ''),
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
  return { ...legacy, handoff: null as HandoffRoute | null };
}

function parseInitial() {
  return parseInitialLocation(window.location);
}

export function voiceSettingsForRtc(settings: Settings): VoiceSettings {
  return normalizeVoiceSettingsForRtc({
    tts: settings.tts,
    stt: settings.stt,
    voice: settings.voice,
  }) ?? {};
}

export function App() {
  const initial = useMemo(parseInitial, []);
  const [screen, setScreen] = useState<ScreenId>(initial.screen);
  const [openSession, setOpenSession] = useState<string | undefined>(initial.sessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [activeHandoff, setActiveHandoff] = useState<HandoffRoute | null>(initial.handoff);
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
    setSessionsOpen(false);
    setSettingsOpen(true);
  }, []);
  const openHistory = useCallback(() => {
    setSettingsOpen(false);
    setSessionsOpen(false);
    setHistoryOpen(true);
  }, []);
  const openSessions = useCallback(() => {
    setSettingsOpen(false);
    setHistoryOpen(false);
    setSessionsOpen(true);
  }, []);

  const compact = isNarrow;
  const currentSessionId =
    screen === 'driving' ? activeHandoff?.sessionId || initial.sessionId : openSession || activeHandoff?.sessionId || initial.sessionId;

  const rtcVoiceSettings = useMemo(() => voiceSettingsForRtc(settings), [settings]);

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
          onHistory={openHistory}
          onSessions={openSessions}
          onSettings={openSettings}
          compact={compact}
          sessionId={activeHandoff?.sessionId || initial.sessionId}
          hostPeerId={activeHandoff?.hostPeerId || initial.hostPeerId}
          threadId={initial.threadId}
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

  const overlayOpen = settingsOpen || historyOpen || sessionsOpen;
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
      {sessionsOpen && (
        <SessionsOverlay
          onClose={() => setSessionsOpen(false)}
          onPick={(session) => {
            if (!activeHandoff) return;
            const next = handoffFromSession(activeHandoff, session);
            setActiveHandoff(next);
            setSessionsOpen(false);
            go('driving');
            replaceHandoffHash(next);
          }}
          activeSessionId={activeHandoff?.sessionId}
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
      hostPeerId={activeHandoff ? activeHandoff.hostPeerId : undefined}
      rendezvous={
        activeHandoff
          ? {
              sessionId: activeHandoff.sessionId,
              ...(activeHandoff.sessionKey ? { sessionKey: activeHandoff.sessionKey } : {}),
              ...(activeHandoff.channel ? { channel: activeHandoff.channel } : {}),
              ...(activeHandoff.target ? { target: activeHandoff.target } : {}),
              ...(activeHandoff.accountId ? { accountId: activeHandoff.accountId } : {}),
            }
          : null
      }
      voiceSettings={rtcVoiceSettings}
    >
      <RtcDisconnectGate isNarrow={isNarrow}>
        <ResponsiveRuntime isNarrow={isNarrow}>{appContent}</ResponsiveRuntime>
      </RtcDisconnectGate>
    </RtcProvider>
  );
}

function handoffFromSession(current: HandoffRoute, session: RecentSessionEntry): HandoffRoute {
  return {
    hostPeerId: current.hostPeerId,
    sessionId: session.sessionId,
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
    ...(session.channel ? { channel: session.channel } : {}),
    ...(session.target ? { target: session.target } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
  };
}

function replaceHandoffHash(handoff: HandoffRoute): void {
  const params = new URLSearchParams();
  params.set('host', handoff.hostPeerId);
  params.set('session', handoff.sessionId);
  if (handoff.sessionKey) params.set('sessionKey', handoff.sessionKey);
  if (handoff.channel) params.set('channel', handoff.channel);
  if (handoff.target) params.set('target', handoff.target);
  if (handoff.accountId) params.set('accountId', handoff.accountId);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params.toString()}`);
}

function SessionsOverlay({
  onClose,
  onPick,
  activeSessionId,
  compact,
}: {
  onClose: () => void;
  onPick: (session: RecentSessionEntry) => void;
  activeSessionId?: string;
  compact: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { sessionsCatalog, requestSessionsCatalog, status } = useRtc();

  useEffect(() => {
    dialogRef.current?.focus();
    requestSessionsCatalog();
    const timer = window.setInterval(requestSessionsCatalog, 60_000);
    return () => window.clearInterval(timer);
  }, [requestSessionsCatalog]);

  const sessions = sessionsCatalog?.sessions ?? [];

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
        aria-label="Sessions"
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
          color: HIFI.ink,
          fontFamily: HIFI.fonts.mono,
          pointerEvents: 'auto',
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          padding: compact ? 16 : 22,
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={onClose}
            aria-label="Back"
            style={sessionButtonStyle({ compact, subtle: true })}
          >
            ←
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1.4 }}>SESSIONS</div>
            <div style={{ color: HIFI.ink3, fontSize: 11, marginTop: 3 }}>
              {status === 'open' ? '10 most recent OpenClaw sessions' : 'Waiting for daemon…'}
            </div>
          </div>
          <button
            onClick={requestSessionsCatalog}
            style={sessionButtonStyle({ compact, subtle: true })}
          >
            ↻
          </button>
        </div>
        <div style={{ display: 'grid', gap: 8, overflow: 'auto', minHeight: 0 }}>
          {sessions.length === 0 && (
            <div style={{ color: HIFI.ink3, fontSize: 13, padding: '18px 4px' }}>
              No recent sessions yet.
            </div>
          )}
          {sessions.map((session) => {
            const selected = session.sessionId === activeSessionId;
            return (
              <button
                key={`${session.id}:${session.sessionKey ?? ''}`}
                onClick={() => onPick(session)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${selected ? HIFI.ai : HIFI.stroke}`,
                  background: selected ? `${HIFI.ai}16` : 'rgba(255,255,255,0.03)',
                  color: HIFI.ink,
                  borderRadius: 14,
                  padding: compact ? '11px 12px' : '13px 14px',
                  cursor: 'pointer',
                  fontFamily: HIFI.fonts.mono,
                  minWidth: 0,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 800 }}>
                    {session.label}
                  </span>
                  {selected && <span style={{ color: HIFI.ai, fontSize: 11 }}>ACTIVE</span>}
                </div>
                <div style={{ marginTop: 5, color: HIFI.ink3, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.agentId ? `${session.agentId} · ` : ''}{session.channel || session.kind || 'session'}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function sessionButtonStyle({ compact, subtle }: { compact: boolean; subtle?: boolean }): CSSProperties {
  return {
    width: compact ? 34 : 38,
    height: compact ? 34 : 38,
    borderRadius: 12,
    background: subtle ? 'transparent' : `${HIFI.ai}14`,
    border: `1px solid ${HIFI.stroke}`,
    color: HIFI.ink2,
    cursor: 'pointer',
    fontFamily: HIFI.fonts.mono,
    fontSize: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
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
  setSettings: (next: Settings) => void;
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
