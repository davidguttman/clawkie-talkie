import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import type { VoiceSettings } from './voice/protocol';
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
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [replayAvailabilityTick, setReplayAvailabilityTick] = useState(0);
  const [isNarrow, setIsNarrow] = useState(computeIsNarrow);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

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
  const currentSessionId =
    screen === 'driving' ? initial.sessionId : openSession || initial.sessionId;

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
          onSettings={openSettings}
          compact={compact}
          sessionId={initial.sessionId}
          hostPeerId={initial.hostPeerId}
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
      hostPeerId={initial.handoff ? (initial.hostPeerId ?? undefined) : undefined}
      rendezvous={
        initial.handoff
          ? {
              sessionId: initial.handoff.sessionId,
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
