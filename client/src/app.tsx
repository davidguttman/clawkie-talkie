import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HIFI } from './tokens';
import { HiFiPhone } from './components/Phone';
import { DrivingScreen } from './screens/Driving';
import { HistoryScreen } from './screens/History';
import { TranscriptScreen } from './screens/Transcript';
import { SettingsScreen } from './screens/Settings';
import { ErrorScreen, type ErrorKind } from './screens/ErrorScreen';
import { RtcProvider, useRtc } from './rtc/RtcContext';
import {
  latestAssistantText,
  loadSettings,
  loadTranscriptSession,
  saveSettings,
  type Settings,
} from './storage';
import { replayAssistantReply } from './replay';
import {
  canSpeakReplayText,
  getLastBufferedReplyAudio,
  playBufferedReplyAudio,
  speakReplayText,
} from './voice/tts';
import { parseHandoffUrl, type HandoffRoute } from './voice/handoffUrl';

type ScreenId = 'driving' | 'history' | 'transcript' | 'settings' | 'error';

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

export function App() {
  const initial = useMemo(parseInitial, []);
  const [screen, setScreen] = useState<ScreenId>(initial.screen);
  const [openSession, setOpenSession] = useState<string | undefined>(initial.sessionId);
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 900,
  );

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const go = useCallback((s: ScreenId) => {
    setScreen(s);
  }, []);

  const compact = isNarrow;
  const currentSessionId =
    screen === 'driving' ? initial.sessionId : openSession || initial.sessionId;

  const replayLastReply = useCallback(async () => {
    const session = currentSessionId ? loadTranscriptSession(currentSessionId) : null;
    try {
      const result = await replayAssistantReply({
        audio: getLastBufferedReplyAudio(),
        text: latestAssistantText(session),
        canSpeakText: canSpeakReplayText(),
        playAudio: playBufferedReplyAudio,
        speakText: speakReplayText,
      });
      return result.message;
    } catch {
      return 'Replay unavailable on this browser';
    }
  }, [currentSessionId]);

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
          onHistory={() => go('history')}
          onSettings={() => go('settings')}
          compact={compact}
          settings={settings}
          sessionId={initial.sessionId}
          hostPeerId={initial.hostPeerId}
          threadId={initial.threadId}
        />
      )}
      {screen === 'history' && (
        <HistoryScreen
          onBack={() => go('driving')}
          onOpenSession={(sessionId) => {
            setOpenSession(sessionId);
            go('transcript');
          }}
          compact={compact}
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
      {screen === 'settings' && (
        <SettingsScreen
          onBack={() => go('driving')}
          settings={settings}
          setSettings={setSettingsState}
          compact={compact}
        />
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

  return (
    <RtcProvider
      hostPeerId={initial.handoff ? (initial.hostPeerId ?? undefined) : undefined}
      rendezvous={
        initial.handoff
          ? {
              sessionId: initial.handoff.sessionId,
              delivery: initial.handoff.delivery,
            }
          : null
      }
    >
      <RtcDisconnectGate isNarrow={isNarrow}>
        <ResponsiveRuntime isNarrow={isNarrow}>{screenContent}</ResponsiveRuntime>
      </RtcDisconnectGate>
    </RtcProvider>
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
