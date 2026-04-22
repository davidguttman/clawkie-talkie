import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HIFI } from './tokens';
import { HiFiPhone } from './components/Phone';
import { HandoffScreen } from './screens/Handoff';
import { DrivingScreen } from './screens/Driving';
import { HistoryScreen } from './screens/History';
import { TranscriptScreen } from './screens/Transcript';
import { SettingsScreen } from './screens/Settings';
import { ErrorScreen, type ErrorKind } from './screens/ErrorScreen';
import { loadSettings, saveSettings, type Settings } from './storage';

type ScreenId = 'handoff' | 'driving' | 'history' | 'transcript' | 'settings' | 'error';

const SCREEN_IDS: ScreenId[] = [
  'handoff',
  'driving',
  'history',
  'transcript',
  'settings',
  'error',
];

const ERROR_KINDS: ErrorKind[] = [
  'mic_denied',
  'offline',
  'stt_failed',
  'tts_failed',
  'bad_session',
];

function parseInitial(): {
  screen: ScreenId;
  errorKind: ErrorKind;
  joinToken?: string;
  sessionId?: string;
} {
  const params = new URLSearchParams(window.location.search);
  const rawScreen = params.get('screen');
  const screen: ScreenId = (SCREEN_IDS as string[]).includes(rawScreen || '')
    ? (rawScreen as ScreenId)
    : 'handoff';
  const rawKind = params.get('errorKind');
  const errorKind: ErrorKind = (ERROR_KINDS as string[]).includes(rawKind || '')
    ? (rawKind as ErrorKind)
    : 'bad_session';
  const joinToken = params.get('join') || undefined;
  const sessionId = params.get('session') || undefined;
  return { screen, errorKind, joinToken, sessionId };
}

function setUrlParam(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  window.history.replaceState(null, '', url.toString());
}

export function App() {
  const initial = useMemo(parseInitial, []);
  const [screen, setScreen] = useState<ScreenId>(initial.screen);
  const [errorKind, setErrorKind] = useState<ErrorKind>(initial.errorKind);
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
    setUrlParam('screen', s);
  }, []);

  const goErrorKind = useCallback((k: ErrorKind) => {
    setErrorKind(k);
    setUrlParam('errorKind', k);
  }, []);

  // `compact` is the "real phone" layout mode: stacked rows, smaller chrome,
  // more gutter — used whenever we're not rendering inside the desktop phone
  // mockup. Threshold matches the MobileShell switch so they're never out of
  // sync.
  const compact = isNarrow;

  const screenContent = (
    <>
      {screen === 'handoff' && (
        <HandoffScreen
          onEnter={() => go('driving')}
          onBack={() => go('driving')}
          joinToken={initial.joinToken}
          sessionId={initial.sessionId}
          compact={compact}
        />
      )}
      {screen === 'driving' && (
        <DrivingScreen
          accent="amber"
          fontMode="mono"
          onReplay={() => {
            const fallback = 'agent:main:discord:1495266157463208138:1766284491';
            setOpenSession(openSession || fallback);
            go('transcript');
          }}
          onHistory={() => go('history')}
          onSettings={() => go('settings')}
          compact={compact}
        />
      )}
      {screen === 'history' && (
        <HistoryScreen onBack={() => go('driving')} compact={compact} />
      )}
      {screen === 'transcript' && (
        <TranscriptScreen
          sessionId={openSession}
          onBack={() => go('driving')}
          compact={compact}
        />
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
          kind={errorKind}
          onDismiss={() => go('driving')}
          onRetry={() => go('driving')}
          onBack={() => go('driving')}
        />
      )}
    </>
  );

  if (isNarrow) {
    return <MobileShell>{screenContent}</MobileShell>;
  }

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <SideNav
        screen={screen}
        onScreen={go}
        errorKind={errorKind}
        onErrorKind={goErrorKind}
      />
      <HiFiPhone>{screenContent}</HiFiPhone>
    </div>
  );
}

function MobileShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="mobile-scroll"
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
        paddingLeft: 14,
        paddingRight: 14,
      }}
    >
      {children}
    </div>
  );
}

function SideNav({
  screen,
  onScreen,
  errorKind,
  onErrorKind,
}: {
  screen: ScreenId;
  onScreen: (s: ScreenId) => void;
  errorKind: ErrorKind;
  onErrorKind: (k: ErrorKind) => void;
}) {
  const screens: { id: ScreenId; label: string; hint: string }[] = [
    { id: 'handoff', label: 'Handoff landing', hint: 'from Discord link' },
    { id: 'driving', label: 'Driving mode', hint: 'main voice screen' },
    { id: 'history', label: 'History', hint: 'past sessions (disabled)' },
    { id: 'transcript', label: 'Transcript', hint: 'session detail (disabled)' },
    { id: 'settings', label: 'Settings', hint: 'xAI key · voice' },
    { id: 'error', label: 'Error states', hint: '5 scenarios' },
  ];

  const kinds: { id: ErrorKind; label: string; hint: string }[] = [
    { id: 'mic_denied', label: 'Mic blocked', hint: 'first tap, no permission' },
    { id: 'offline', label: 'No connection', hint: 'daemon/session failure' },
    { id: 'stt_failed', label: 'Transcription failed', hint: 'spoke, got nothing' },
    { id: 'tts_failed', label: 'Audio failed', hint: 'text ok, no sound' },
    { id: 'bad_session', label: 'Bad handoff link', hint: 'expired or invalid' },
  ];

  return (
    <div style={{ width: 220, paddingTop: 40 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 11,
          letterSpacing: 2,
          color: HIFI.ink3,
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        PHASE 0 BUILD
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 24,
          fontWeight: 600,
          color: HIFI.ink,
          lineHeight: 1.2,
          marginBottom: 14,
        }}
      >
        Clawkie<span style={{ color: HIFI.accents.amber.rec }}>-Talkie</span>
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.sans,
          fontSize: 13,
          color: HIFI.ink2,
          lineHeight: 1.55,
        }}
      >
        A walky-talky for your brain. Shell port is live; voice loop wires up in Phase 2.
      </div>

      <div style={{ marginTop: 26, paddingTop: 16, borderTop: `1px solid ${HIFI.stroke}` }}>
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            letterSpacing: 1.6,
            color: HIFI.ink3,
            fontWeight: 700,
            marginBottom: 10,
          }}
        >
          SCREENS
        </div>
        {screens.map((s) => {
          const on = screen === s.id;
          const accent = HIFI.accents.amber.rec;
          return (
            <button
              key={s.id}
              onClick={() => onScreen(s.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '9px 10px 9px 12px',
                marginBottom: 3,
                borderRadius: 8,
                background: on ? HIFI.surface2 : 'transparent',
                border: `1px solid ${on ? HIFI.strokeStrong : 'transparent'}`,
                borderLeft: `3px solid ${on ? accent : 'transparent'}`,
                color: on ? HIFI.ink : HIFI.ink2,
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: on ? `inset 0 0 24px ${accent}18` : 'none',
              }}
            >
              <div
                style={{
                  fontFamily: HIFI.fonts.sans,
                  fontSize: 12,
                  fontWeight: on ? 700 : 500,
                  color: on ? HIFI.ink : HIFI.ink2,
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  fontFamily: HIFI.fonts.mono,
                  fontSize: 9,
                  color: on ? HIFI.ink2 : HIFI.ink3,
                  letterSpacing: 0.6,
                  marginTop: 2,
                }}
              >
                {s.hint}
              </div>
            </button>
          );
        })}
      </div>

      {screen === 'error' && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${HIFI.stroke}` }}>
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              letterSpacing: 1.6,
              color: HIFI.ink3,
              fontWeight: 700,
              marginBottom: 10,
            }}
          >
            ERROR KIND
          </div>
          {kinds.map((e) => {
            const on = errorKind === e.id;
            const accent = HIFI.accents.amber.rec;
            return (
              <button
                key={e.id}
                onClick={() => onErrorKind(e.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px 8px 12px',
                  marginBottom: 3,
                  borderRadius: 8,
                  background: on ? HIFI.surface2 : 'transparent',
                  border: `1px solid ${on ? HIFI.strokeStrong : 'transparent'}`,
                  borderLeft: `3px solid ${on ? accent : 'transparent'}`,
                  color: on ? HIFI.ink : HIFI.ink2,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: on ? `inset 0 0 24px ${accent}18` : 'none',
                }}
              >
                <div
                  style={{
                    fontFamily: HIFI.fonts.sans,
                    fontSize: 11,
                    fontWeight: on ? 700 : 500,
                    color: on ? HIFI.ink : HIFI.ink2,
                  }}
                >
                  {e.label}
                </div>
                <div
                  style={{
                    fontFamily: HIFI.fonts.mono,
                    fontSize: 9,
                    color: on ? HIFI.ink2 : HIFI.ink3,
                    letterSpacing: 0.5,
                    marginTop: 2,
                  }}
                >
                  {e.hint}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
