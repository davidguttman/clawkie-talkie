import { useCallback, useEffect, useRef, useState } from 'react';
import { HIFI, type AccentKey } from '../tokens';
import { ButtonAura, LiveWave } from '../components/Phone';
import { useDrivingLoop, type DrivingState } from '../voice/drivingLoop';
import {
  getRemoteTtsAudioDebugSnapshot,
  playPttPressTone,
  unlockDaemonTtsAudio,
} from '../voice/tts';
import { useRtc } from '../rtc/RtcContext';
import type { RecentSession } from '../voice/protocol';
import { readSttChunkConfigFromLocation } from '../voice/sttDaemon';
import {
  getHoldMusicMuted,
  setHoldMusicMuted,
  subscribeHoldMusicMuted,
} from '../voice/holdMusic';

// Runtime driving surface driven by the daemon-owned state machine in
// ../voice/drivingLoop.ts. The phone only captures mic PCM and plays
// daemon-streamed TTS audio; STT, reply generation, and TTS all terminate
// on the daemon side.

type SessionListRequestPhase = 'idle' | 'loading' | 'refreshing';

interface SessionListRequestState {
  phase: SessionListRequestPhase;
  requestId: number;
  timedOut: boolean;
}

const RECENT_SESSIONS_REFRESH_TIMEOUT_MS = 2500;

export function DrivingScreen({
  accent = 'amber',
  fontMode = 'mono',
  onReplay,
  canReplay = false,
  onHistory,
  onSettings,
  compact = false,
  sessionId,
  hostPeerId,
  threadId,
  onSelectSession,
}: {
  accent?: AccentKey;
  fontMode?: 'mono' | 'sans';
  onReplay?: () => void | Promise<void>;
  canReplay?: boolean;
  onHistory?: () => void;
  onSettings?: () => void;
  compact?: boolean;
  sessionId?: string;
  hostPeerId?: string | null;
  threadId?: string;
  onSelectSession?: (session: RecentSession) => void;
}) {
  const accentCfg = HIFI.accents[accent] || HIFI.accents.amber;
  const debugMode = useDebugMode();
  const [holdMusicMuted, setHoldMusicMutedState] = useState(() => getHoldMusicMuted());
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionListRequest, setSessionListRequest] = useState<SessionListRequestState>({
    phase: 'idle',
    requestId: 0,
    timedOut: false,
  });

  const rtc = useRtc();
  const recentSessionsSupported = rtc.recentSessionsSupportStatus === 'supported';

  const loop = useDrivingLoop({
    sessionId,
    threadId,
    hostPeerId,
    rtc: {
      status: rtc.status,
      hasClient: rtc.hasClient,
      sendControl: rtc.sendControl,
      sendBinary: rtc.sendBinary,
      addControlListener: rtc.addControlListener,
      addBinaryListener: rtc.addBinaryListener,
    },
  });

  const {
    state,
    liveText,
    isTranscribing,
    lastTurn,
    intensities,
    error,
    daemonConnected,
    tap,
  } = loop;

  useEffect(() => {
    return subscribeHoldMusicMuted(setHoldMusicMutedState);
  }, []);

  useEffect(() => {
    if (!recentSessionsSupported) setSessionPickerOpen(false);
  }, [recentSessionsSupported]);

  useEffect(() => {
    if (rtc.recentSessionsResponseSeq <= 0) return;
    setSessionListRequest((current) =>
      current.phase === 'idle' && !current.timedOut
        ? current
        : { phase: 'idle', requestId: current.requestId, timedOut: false },
    );
  }, [rtc.recentSessionsResponseSeq]);

  useEffect(() => {
    if (sessionListRequest.phase === 'idle') return;
    const requestId = sessionListRequest.requestId;
    const timeout = window.setTimeout(() => {
      setSessionListRequest((current) =>
        current.requestId === requestId && current.phase !== 'idle'
          ? { phase: 'idle', requestId: current.requestId, timedOut: true }
          : current,
      );
    }, RECENT_SESSIONS_REFRESH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [sessionListRequest.phase, sessionListRequest.requestId]);

  const isRec = state === 'recording';
  const isAI = state === 'ai';
  const isThink = state === 'thinking';

  const stateColor = isRec
    ? accentCfg.rec
    : isAI
      ? HIFI.ai
      : isThink
        ? HIFI.think
        : HIFI.ink3;
  const stateGlow = isRec
    ? accentCfg.recGlow
    : isAI
      ? HIFI.aiGlow
      : isThink
        ? HIFI.thinkGlow
        : 'transparent';

  const baseFont = fontMode === 'sans' ? HIFI.fonts.sans : HIFI.fonts.mono;
  // Compact gutter raised from 2 → 8 so the top-right status pill + gear
  // always sit well inside the viewport on narrow phones, where
  // MobileShell's overflow-x:hidden would otherwise clip them.
  const sidePad = compact ? 8 : 22;

  // Compact uses the shorter "REPLY" label — the full "READING REPLY"
  // wouldn't fit alongside the CLWK label and gear button on narrow phones.
  const statePill = isRec
    ? 'REC'
    : isAI
      ? compact
        ? 'REPLY'
        : 'READING REPLY'
      : isThink
        ? 'THINKING'
        : 'READY';
  const btnLabel = isRec
    ? 'TAP TO STOP'
    : isAI
      ? 'TAP TO SILENCE'
      : isThink
        ? 'THINKING…'
        : 'TAP TO TALK';

  const caption = pickCaption({
    state,
    stateColor,
    liveText,
    isTranscribing,
    lastTurn,
    accentRec: accentCfg.rec,
  });

  const rowGap = compact ? 8 : 10;
  const replayEnabled = !!onReplay && canReplay;
  const recentSessions = rtc.recentSessions;
  const recentSessionsGeneratedAt = rtc.recentSessionsGeneratedAt;
  const activeSession = recentSessions.find(
    (session) => session.sessionId === sessionId || session.sessionKey === sessionId,
  );
  const headerLabel = buildHeaderLabel(activeSession);
  const requestRecentSessionList = useCallback(() => {
    setSessionListRequest((current) => ({
      phase: recentSessionsGeneratedAt ? 'refreshing' : 'loading',
      requestId: current.requestId + 1,
      timedOut: false,
    }));
    rtc.requestRecentSessions();
  }, [recentSessionsGeneratedAt, rtc]);
  const recentSessionsLoading = sessionListRequest.phase === 'loading' && !recentSessionsGeneratedAt;
  const recentSessionsRefreshing = sessionListRequest.phase === 'refreshing';
  const pttButtonSize = compact
    ? 'clamp(164px, min(52vw, 29dvh), 208px)'
    : 'clamp(188px, min(42vw, 30dvh), 208px)';

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        // Caption (1fr) and the voice-control area (1.2fr) split free
        // space proportionally, so the PTT button gets balanced breathing
        // room above and below regardless of transcript length. Rows are
        // fr-based, not content-based, which is why streaming text in the
        // bounded caption cannot push the button around.
        gridTemplateRows: debugMode
          ? `auto minmax(0, 0.9fr) auto minmax(0, 1fr) auto auto auto`
          : `auto minmax(0, 1fr) auto minmax(0, 1.2fr) auto auto`,
        rowGap,
        padding: compact ? `8px ${sidePad}px 10px` : `12px ${sidePad}px 14px`,
        color: HIFI.ink,
        fontFamily: baseFont,
        minWidth: 0,
        minHeight: 0,
        width: '100%',
        boxSizing: 'border-box',
        maxWidth: '100%',
        overflow: 'hidden',
      }}
    >
      {/* header — full hi-fi layout in both compact and desktop. Status
          pill is always visible so the user can read state at a glance. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 8 : 10,
          minWidth: 0,
          width: '100%',
          minHeight: 0,
        }}
      >
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 1.2,
            color: HIFI.ink2,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {headerLabel}
        </div>
        <div
          style={{
            display: 'inline-flex',
            gap: 5,
            alignItems: 'center',
            padding: '3px 9px',
            borderRadius: 20,
            border: `1px solid ${stateColor}55`,
            background: `${stateColor}11`,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.2,
            color: stateColor,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: stateColor,
              boxShadow: `0 0 8px ${stateColor}`,
              animation:
                isRec || isAI || isThink ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
            }}
          />
          {statePill}
        </div>
        {onSettings && (
          <button
            onClick={onSettings}
            style={{
              width: 48,
              height: 48,
              borderRadius: 15,
              background: 'transparent',
              border: `1px solid ${HIFI.stroke}`,
              color: HIFI.ink2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxSizing: 'border-box',
              appearance: 'none',
              WebkitAppearance: 'none',
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Settings"
          >
            <span
              aria-hidden="true"
              style={{
                display: 'block',
                fontFamily: 'Times New Roman, Noto Serif Symbols, serif',
                fontSize: 32,
                lineHeight: 1,
                transform: 'translateY(-1px)',
              }}
            >
              ⚙︎
            </span>
          </button>
        )}
      </div>

      {/* caption — bounded so live text scrolls instead of moving controls.
          Bottom border frames the transcript and visually separates it
          from the voice-control area (waveform + PTT button) below. */}
      <div
        style={{
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          paddingBottom: compact ? 8 : 10,
          borderBottom: `1px solid ${HIFI.stroke}`,
        }}
      >
        <Caption
          caption={caption}
          baseFont={baseFont}
          error={error}
          daemonConnected={daemonConnected}
          hasRtcClient={rtc.hasClient}
          rtcStatus={rtc.status}
          canRetryConnection={rtc.canRetryConnection}
          onRetryConnection={rtc.retryConnection}
          compact={compact}
        />
      </div>
      {/* waveform sits at its natural height directly above the PTT
          button so the two read as one voice-control unit. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <LiveWave
          intensities={intensities}
          color={stateColor}
          width="100%"
          height={compact ? 30 : 34}
        />
      </div>

      {/* BIG BUTTON — centered inside a flexible row so the breathing
          room above (between waveform and button) and below (between
          button and footer) is balanced by the grid, not hard-coded. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          minHeight: 0,
          overflow: 'visible',
        }}
      >
        <PTTButton
          onTap={tap}
          onToggleHoldMusicMuted={() => setHoldMusicMuted(!getHoldMusicMuted())}
          holdMusicMuted={holdMusicMuted}
          state={state}
          stateColor={stateColor}
          stateGlow={stateGlow}
          label={btnLabel}
          accentRec={accentCfg.rec}
          size={pttButtonSize}
        />
      </div>

      {debugMode && (
        <AudioDebugPanel
          baseFont={baseFont}
          compact={compact}
          state={state}
          rtcStatus={rtc.status}
        />
      )}

      {recentSessionsSupported && sessionPickerOpen && (
        <SessionPicker
          sessions={recentSessions}
          activeSessionId={sessionId}
          compact={compact}
          generatedAt={recentSessionsGeneratedAt}
          loading={recentSessionsLoading}
          refreshing={recentSessionsRefreshing}
          timedOut={sessionListRequest.timedOut}
          onRefresh={requestRecentSessionList}
          onSelect={(session) => {
            setSessionPickerOpen(false);
            onSelectSession?.(session);
          }}
        />
      )}

      {/* footer — compact action strip. Settings lives in the header gear
          button (visible in both compact and desktop). */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: recentSessionsSupported ? '1fr 1fr 1fr' : '1fr 1fr',
          gap: 8,
          minWidth: 0,
        }}
      >
        <FooterButton
          icon="↺"
          label="REPLAY"
          onClick={replayEnabled ? onReplay : undefined}
          compact={compact}
        />
        <FooterButton icon="≡" label="HISTORY" onClick={onHistory} compact={compact} />
        {recentSessionsSupported && (
          <FooterButton
            icon="▦"
            label="SESSIONS"
            ariaLabel="Sessions"
            onClick={() => {
              setSessionPickerOpen((open) => {
                const nextOpen = !open;
                if (nextOpen) requestRecentSessionList();
                return nextOpen;
              });
            }}
            compact={compact}
          />
        )}
      </div>
    </div>
  );
}


function SessionPicker({
  sessions,
  activeSessionId,
  compact,
  generatedAt,
  loading,
  refreshing,
  timedOut,
  onRefresh,
  onSelect,
}: {
  sessions: RecentSession[];
  activeSessionId?: string;
  compact: boolean;
  generatedAt?: string;
  loading: boolean;
  refreshing: boolean;
  timedOut: boolean;
  onRefresh: () => void;
  onSelect: (session: RecentSession) => void;
}) {
  const waiting = loading || refreshing;
  const updatedLabel = formatRecentSessionsUpdatedAt(generatedAt);
  const statusLabel = loading
    ? 'Loading recent sessions…'
    : refreshing
      ? 'Refreshing…'
      : updatedLabel;

  return (
    <section
      aria-label="Recent sessions"
      style={{
        minWidth: 0,
        border: `1px solid ${HIFI.stroke}`,
        borderRadius: 14,
        background: 'rgba(12, 16, 24, 0.72)',
        padding: compact ? 8 : 10,
        boxShadow: `0 12px 28px rgba(0,0,0,0.22)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 6,
          fontFamily: HIFI.fonts.mono,
        }}
      >
        <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1.3,
              color: HIFI.ink2,
            }}
          >
            SESSIONS
          </span>
          {statusLabel && (
            <span
              aria-live="polite"
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.3,
                color: refreshing ? HIFI.ai : HIFI.ink3,
              }}
            >
              {statusLabel}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={waiting}
          style={{
            border: 0,
            background: 'transparent',
            color: waiting ? HIFI.ink3 : HIFI.ink2,
            opacity: waiting ? 0.58 : 1,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1,
            cursor: waiting ? 'default' : 'pointer',
            padding: 2,
            flexShrink: 0,
          }}
        >
          {refreshing || loading ? 'REFRESHING…' : 'REFRESH'}
        </button>
      </div>
      {timedOut && (
        <div
          role="status"
          style={{
            marginBottom: 6,
            border: `1px solid ${HIFI.think}55`,
            borderRadius: 9,
            background: `${HIFI.think}12`,
            color: HIFI.think,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 0.4,
            lineHeight: 1.25,
            padding: '5px 7px',
          }}
        >
          No refresh response yet
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gap: 5,
          maxHeight: compact ? 154 : 180,
          overflowY: 'auto',
          paddingRight: 2,
        }}
      >
        {sessions.length === 0 ? (
          <div style={{ color: HIFI.ink3, fontSize: 11, lineHeight: 1.35 }}>
            {loading ? 'Loading recent sessions…' : 'No recent sessions yet.'}
          </div>
        ) : (
          sessions.map((session) => {
            const active = session.sessionId === activeSessionId || session.sessionKey === activeSessionId;
            return (
              <button
                key={`${session.sessionKey}:${session.sessionId}`}
                type="button"
                onClick={() => onSelect(session)}
                aria-current={active ? 'true' : undefined}
                style={{
                  minWidth: 0,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 8,
                  alignItems: 'center',
                  textAlign: 'left',
                  borderRadius: 10,
                  border: `1px solid ${active ? HIFI.ai : HIFI.stroke}`,
                  background: active ? `${HIFI.ai}18` : 'rgba(255,255,255,0.03)',
                  color: HIFI.ink,
                  cursor: 'pointer',
                  padding: compact ? '7px 8px' : '8px 10px',
                  fontFamily: HIFI.fonts.mono,
                  boxSizing: 'border-box',
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: compact ? 11 : 12,
                    fontWeight: 800,
                  }}
                  title={session.displayLabel}
                >
                  {session.displayLabel}
                </span>
                <span
                  style={{
                    color: active ? HIFI.ai : HIFI.ink3,
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {active ? 'ACTIVE' : session.agent.toUpperCase()}
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function formatRecentSessionsUpdatedAt(generatedAt?: string): string | null {
  if (!generatedAt) return null;
  const updatedAt = Date.parse(generatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  const elapsedMs = Math.max(0, Date.now() - updatedAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return 'Updated just now';
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Updated ${elapsedHours}h ago`;
  return `Updated ${new Date(updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function useDebugMode(): boolean {
  const [enabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('debug') === 'true';
  });
  return enabled;
}

interface DebugSnapshot {
  remoteTts: ReturnType<typeof getRemoteTtsAudioDebugSnapshot>;
}

function readDebugSnapshot(): DebugSnapshot {
  return {
    remoteTts: getRemoteTtsAudioDebugSnapshot(),
  };
}

function AudioDebugPanel({
  baseFont,
  compact,
  state,
  rtcStatus,
}: {
  baseFont: string;
  compact: boolean;
  state: DrivingState;
  rtcStatus: string;
}) {
  const [snapshot, setSnapshot] = useState<DebugSnapshot>(() => readDebugSnapshot());

  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot(readDebugSnapshot()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const remoteRows = [
    ['present', boolLabel(snapshot.remoteTts.present)],
    ['paused', nullableBoolLabel(snapshot.remoteTts.paused)],
    ['currentTime', formatNumber(snapshot.remoteTts.currentTime)],
    ['readyState', formatNullable(snapshot.remoteTts.readyState)],
    ['srcObject', formatRemoteSrcObject(snapshot.remoteTts.srcObject)],
    ['src', formatSrc(snapshot.remoteTts.src)],
    ['drivingState', state],
    ['rtc', rtcStatus],
    ['sttChunking', formatSttChunking()],
  ];

  return (
    <section
      style={{
        minWidth: 0,
        maxWidth: '100%',
        borderTop: `1px solid ${HIFI.stroke}`,
        paddingTop: compact ? 7 : 9,
        overflow: 'hidden',
        color: HIFI.ink2,
      }}
      aria-label="Audio debug"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 6,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.2,
          color: HIFI.ink,
        }}
      >
        <span>AUDIO DEBUG</span>
        <span style={{ color: snapshot.remoteTts.present ? HIFI.ai : HIFI.ink3 }}>
          REMOTE TTS {snapshot.remoteTts.present ? 'READY' : 'WAITING'}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: compact ? 5 : 8,
          maxHeight: compact ? 118 : 132,
          overflowY: 'auto',
          paddingRight: 4,
          fontFamily: baseFont,
        }}
      >
        <DebugGroup title="remoteTtsAudio" rows={remoteRows} />
      </div>
    </section>
  );
}

function DebugGroup({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          color: HIFI.ink3,
          marginBottom: 3,
        }}
      >
        {title}
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'grid',
            gridTemplateColumns: '82px minmax(0, 1fr)',
            gap: 6,
            minWidth: 0,
            fontSize: 10,
            lineHeight: 1.35,
            marginBottom: 2,
          }}
        >
          <span style={{ color: HIFI.ink4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {label}
          </span>
          <span
            style={{
              color: HIFI.ink2,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={value}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function formatSttChunking(
  cfg: { chunkMs: number; chunkBytes: number } | null = readSttChunkConfigFromLocation(),
): string {
  if (!cfg) return 'default';
  return `${cfg.chunkMs}ms ~${cfg.chunkBytes}B`;
}

function boolLabel(value: boolean): string {
  return value ? 'true' : 'false';
}

function nullableBoolLabel(value: boolean | null): string {
  return value === null ? 'n/a' : boolLabel(value);
}

function formatNullable(value: string | number | null): string {
  return value === null ? 'n/a' : String(value);
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function formatSrc(src: string | null): string {
  if (!src) return 'none';
  if (src.length <= 58) return src;
  return `${src.slice(0, 46)}... (${src.length} chars)`;
}

function formatRemoteSrcObject(
  srcObject: ReturnType<typeof getRemoteTtsAudioDebugSnapshot>['srcObject'],
): string {
  if (!srcObject) return 'none';
  const tracks = srcObject.audioTrackStates.length ? ` ${srcObject.audioTrackStates.join(',')}` : '';
  return `${srcObject.type} audio=${srcObject.audioTrackCount ?? 'n/a'} live=${
    srcObject.liveAudioTrackCount ?? 'n/a'
  }${tracks}`;
}

interface CaptionData {
  label: string;
  color: string;
  text: string | null;
  live: boolean;
}

const AI_RESPONSE_CAPTION_LABEL = 'AI · READING ALOUD';
const AI_RESPONSE_AUTOSCROLL_WPM = 175;
const AI_RESPONSE_AUTOSCROLL_START_WORDS = 18;
const AI_RESPONSE_AUTOSCROLL_INTERVAL_MS = 250;
const AI_RESPONSE_AUTOSCROLL_VIEWPORT_ANCHOR = 0.38;
const AI_RESPONSE_AUTOSCROLL_EASING = 0.3;
const PROGRAMMATIC_SCROLL_GRACE_MS = 120;

function pickCaption({
  state,
  stateColor,
  liveText,
  isTranscribing,
  lastTurn,
  accentRec,
}: {
  state: DrivingState;
  stateColor: string;
  liveText: string;
  isTranscribing: boolean;
  lastTurn: { who: 'user' | 'ai'; text: string } | null;
  accentRec: string;
}): CaptionData {
  if (state === 'recording') {
    return {
      label: 'YOU · LIVE',
      color: accentRec,
      // liveText is populated by daemon STT progress when available.
      text: liveText || null,
      live: true,
    };
  }
  if (state === 'ai') {
    return { label: AI_RESPONSE_CAPTION_LABEL, color: stateColor, text: liveText || null, live: true };
  }
  if (state === 'thinking') {
    return {
      label: isTranscribing ? 'TRANSCRIBING · OPENCLAW' : 'THINKING',
      color: stateColor,
      text: liveText || null,
      live: isTranscribing,
    };
  }
  if (lastTurn) {
    return {
      label: lastTurn.who === 'user' ? 'YOU · LAST' : 'AI · LAST',
      color: HIFI.ink3,
      text: lastTurn.text || null,
      live: false,
    };
  }
  return {
    label: 'READY',
    color: HIFI.ink3,
    text: null,
    live: false,
  };
}

function buildHeaderLabel(activeSession?: RecentSession): string {
  const displayLabel = trimString(activeSession?.displayLabel);
  const agent = trimString(activeSession?.agent);
  if (displayLabel && agent) return `${agent} - ${displayLabel}`;
  if (displayLabel) return displayLabel;
  if (agent) return agent;
  return 'VOICE SESSION';
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function Caption({
  caption,
  baseFont,
  error,
  daemonConnected,
  hasRtcClient,
  rtcStatus,
  canRetryConnection,
  onRetryConnection,
  compact = false,
}: {
  caption: CaptionData;
  baseFont: string;
  error: string | null;
  daemonConnected: boolean;
  hasRtcClient: boolean;
  rtcStatus: string;
  canRetryConnection: boolean;
  onRetryConnection: () => void;
  compact?: boolean;
}) {
  // Everything (STT, chat, TTS) terminates on the daemon. Surface the
  // daemon connection state first, then whatever runtime error the loop
  // reports.
  const isDaemonBlocker =
    !daemonConnected && (error === 'daemon_not_connected' || !hasRtcClient || rtcStatus !== 'open');
  const errorMessage = isDaemonBlocker
    ? hasRtcClient
      ? `CONNECTING TO DAEMON · ${rtcStatus.toUpperCase()}`
      : 'NO DAEMON — OPEN A DAEMON JOIN URL TO ENABLE TRANSCRIPTION'
    : error
      ? errorLabelFor(error)
      : null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastAiResponseTextRef = useRef<string | null>(null);
  const autoScrollDisabledForResponseRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollClearTimerRef = useRef<number | null>(null);
  const isAiResponseCaption = caption.label === AI_RESPONSE_CAPTION_LABEL;

  const setProgrammaticScrollTop = useCallback((el: HTMLDivElement, scrollTop: number) => {
    programmaticScrollRef.current = true;
    el.scrollTop = scrollTop;
    if (programmaticScrollClearTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollClearTimerRef.current);
    }
    programmaticScrollClearTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollClearTimerRef.current = null;
    }, PROGRAMMATIC_SCROLL_GRACE_MS);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (programmaticScrollRef.current) return;
      if (!isAiResponseCaption || !caption.live) return;
      autoScrollDisabledForResponseRef.current = true;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [caption.live, isAiResponseCaption]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isAiResponseCaption || !caption.live) return;
    const handleUserScrollIntent = () => {
      autoScrollDisabledForResponseRef.current = true;
    };
    el.addEventListener('wheel', handleUserScrollIntent, { passive: true });
    el.addEventListener('touchstart', handleUserScrollIntent, { passive: true });
    el.addEventListener('pointerdown', handleUserScrollIntent, { passive: true });
    el.addEventListener('keydown', handleUserScrollIntent);
    return () => {
      el.removeEventListener('wheel', handleUserScrollIntent);
      el.removeEventListener('touchstart', handleUserScrollIntent);
      el.removeEventListener('pointerdown', handleUserScrollIntent);
      el.removeEventListener('keydown', handleUserScrollIntent);
    };
  }, [caption.live, isAiResponseCaption]);

  useEffect(() => {
    return () => {
      if (programmaticScrollClearTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollClearTimerRef.current);
        programmaticScrollClearTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isAiResponseCaption) {
      lastAiResponseTextRef.current = null;
      autoScrollDisabledForResponseRef.current = false;
      return;
    }
    const responseText = caption.text ?? '';
    if (lastAiResponseTextRef.current === responseText) return;
    lastAiResponseTextRef.current = responseText;
    autoScrollDisabledForResponseRef.current = false;
    const el = scrollRef.current;
    if (!el) return;
    setProgrammaticScrollTop(el, 0);
  }, [isAiResponseCaption, caption.text, setProgrammaticScrollTop]);

  useEffect(() => {
    if (!isAiResponseCaption || !caption.live || !caption.text) return;
    const totalWords = countWords(caption.text);
    if (totalWords <= AI_RESPONSE_AUTOSCROLL_START_WORDS) return;
    const startedAtMs = Date.now();
    const interval = window.setInterval(() => {
      if (autoScrollDisabledForResponseRef.current) {
        window.clearInterval(interval);
        return;
      }
      const el = scrollRef.current;
      if (!el || el.scrollHeight <= el.clientHeight) return;

      const elapsedMs = Date.now() - startedAtMs;
      const estimatedWordsSpoken = (elapsedMs / 60000) * AI_RESPONSE_AUTOSCROLL_WPM;
      if (estimatedWordsSpoken < AI_RESPONSE_AUTOSCROLL_START_WORDS) return;

      const maxScrollTop = el.scrollHeight - el.clientHeight;
      const readingProgress = Math.min(estimatedWordsSpoken / totalWords, 1);
      const approximateReadingY = readingProgress * el.scrollHeight;
      const targetScrollTop = clamp(
        approximateReadingY - el.clientHeight * AI_RESPONSE_AUTOSCROLL_VIEWPORT_ANCHOR,
        0,
        maxScrollTop,
      );
      if (targetScrollTop <= el.scrollTop) return;

      const easedScrollTop = el.scrollTop + (targetScrollTop - el.scrollTop) * AI_RESPONSE_AUTOSCROLL_EASING;
      setProgrammaticScrollTop(el, Math.min(targetScrollTop, easedScrollTop));
    }, AI_RESPONSE_AUTOSCROLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [caption.live, caption.text, isAiResponseCaption, setProgrammaticScrollTop]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div
        ref={scrollRef}
        className="transcript-scroll"
        style={{
          fontSize: 16,
          lineHeight: 1.5,
          color: HIFI.ink,
          fontWeight: 400,
          fontFamily: baseFont,
          wordBreak: 'break-word',
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          paddingRight: 10,
          borderRight: `1px solid ${HIFI.stroke}`,
        }}
      >
        {caption.text}
        {caption.live && caption.text && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 16,
              background: caption.color,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'caret 0.9s step-end infinite',
            }}
          />
        )}
      </div>
      {errorMessage && (
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            maxWidth: '100%',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              letterSpacing: 1,
              color: '#ef6155',
              fontWeight: 600,
              minWidth: 0,
              maxWidth: '100%',
              maxHeight: compact ? 32 : 36,
              overflow: 'hidden',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
              flex: '1 1 auto',
            }}
          >
            {errorMessage}
          </div>
          {canRetryConnection && onRetryConnection && (
            <button
              type="button"
              onClick={onRetryConnection}
              style={{
                border: `1px solid ${HIFI.accents.red.rec}66`,
                borderRadius: 999,
                background: `${HIFI.accents.red.rec}14`,
                color: HIFI.accents.red.rec,
                cursor: 'pointer',
                fontFamily: HIFI.fonts.mono,
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: 1,
                padding: compact ? '6px 8px' : '7px 10px',
                flexShrink: 0,
              }}
            >
              RECONNECT
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function errorLabelFor(code: string): string {
  if (code === 'daemon_not_connected') return 'DAEMON NOT CONNECTED';
  if (code === 'mic_denied') return 'MIC PERMISSION DENIED';
  if (code === 'empty_transcript') return 'NO SPEECH DETECTED — TRY AGAIN';
  if (code === 'empty_audio') return 'NO AUDIO CAPTURED — TRY AGAIN';
  if (code === 'media_recorder_unsupported')
    return 'AUDIO CAPTURE UNSUPPORTED ON THIS BROWSER';
  if (code === 'audio_unsupported') return 'AUDIO PLAYBACK UNSUPPORTED ON THIS BROWSER';
  // Daemon-originated codes from transcription / chat / TTS upstreams.
  if (code === 'openclaw_infer_stt_failed') return 'INFER ERROR · OPENCLAW INFER STT FAILED';
  if (code === 'openclaw_infer_tts_failed') return 'TTS ERROR · OPENCLAW INFER TTS FAILED';
  if (code === 'openclaw_auth_unavailable') return 'REPLY ERROR · OPENCLAW AUTH UNAVAILABLE';
  if (code.startsWith('xai_http_')) return `DAEMON · XAI ${code.replace('xai_http_', 'HTTP ')}`;
  if (code === 'xai_empty_reply') return 'DAEMON · XAI EMPTY REPLY';
  return `VOICE ERROR · ${code}`;
}

function PTTButton({
  onTap,
  onToggleHoldMusicMuted,
  holdMusicMuted,
  state,
  stateColor,
  stateGlow,
  label,
  accentRec: _accentRec,
  size,
}: {
  onTap: () => void;
  onToggleHoldMusicMuted: () => void;
  holdMusicMuted: boolean;
  state: DrivingState;
  stateColor: string;
  stateGlow: string;
  label: string;
  accentRec: string;
  size: string;
}) {
  const [pressed, setPressed] = useState(false);
  const clickHandledByPointerRef = useRef(false);
  const disabled = state === 'thinking';

  const isIdle = state === 'idle';
  const isRec = state === 'recording';
  const isAI = state === 'ai';
  const isThink = state === 'thinking';

  const pressScale = pressed ? 0.94 : isRec ? 1.02 : 1;

  return (
    <button
      type="button"
      aria-label={
        isThink
          ? holdMusicMuted
            ? 'Unmute hold music'
            : 'Mute hold music'
          : label
      }
      onClick={() => {
        if (isThink) {
          onToggleHoldMusicMuted();
          return;
        }
        if (disabled) return;
        const handledByPointer = clickHandledByPointerRef.current;
        clickHandledByPointerRef.current = false;
        if (!handledByPointer) {
          void unlockDaemonTtsAudio();
          playPttPressTone();
        }
        try {
          navigator.vibrate && navigator.vibrate(18);
        } catch {
          // vibration unsupported — fine
        }
        onTap();
      }}
      onPointerDown={() => {
        if (isThink) {
          setPressed(true);
          return;
        }
        if (disabled) return;
        clickHandledByPointerRef.current = true;
        void unlockDaemonTtsAudio();
        playPttPressTone();
        setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => {
        clickHandledByPointerRef.current = false;
        setPressed(false);
      }}
      style={{
        position: 'relative',
        width: size,
        height: size,
        aspectRatio: '1 / 1',
        flexShrink: 0,
        borderRadius: '50%',
        border: 'none',
        cursor: disabled && !isThink ? 'default' : 'pointer',
        background: isIdle
          ? `radial-gradient(circle at 30% 28%, ${pressed ? '#2a2a2e' : '#1a1a1d'} 0%, #0a0a0b 100%)`
          : `radial-gradient(circle at 30% 28%, ${stateColor} 0%, ${stateColor}88 100%)`,
        boxShadow: isIdle
          ? `0 0 0 1px ${HIFI.strokeStrong}, inset 0 1px 0 rgba(255,255,255,0.06), 0 ${pressed ? 8 : 18}px ${pressed ? 20 : 40}px rgba(0,0,0,0.6)`
          : `0 0 0 1px ${stateColor}66, 0 0 ${pressed ? 60 : 44}px ${stateGlow}, inset 0 1px 0 rgba(255,255,255,0.15)`,
        color: isIdle ? HIFI.ink : '#000',
        fontFamily: HIFI.fonts.mono,
        transform: `scale(${pressScale})`,
        transition: pressed
          ? 'transform 60ms cubic-bezier(0.4,0,1,1), box-shadow 60ms'
          : 'transform 240ms cubic-bezier(0.2,1.4,0.4,1), box-shadow 240ms, background 300ms',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <ButtonAura active={isRec || isAI} color={stateColor} />
      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center' }}>
        <div style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>
          {isRec ? '■' : isAI ? '◉' : isThink ? (holdMusicMuted ? '⊘' : '◐') : '●'}
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.8,
            marginTop: 12,
          }}
        >
          {isThink ? (holdMusicMuted ? 'TAP FOR MUSIC' : 'TAP TO MUTE') : label}
        </div>
      </div>
    </button>
  );
}

function FooterButton({
  icon,
  label,
  ariaLabel,
  onClick,
  compact,
}: {
  icon: string;
  label: string;
  ariaLabel?: string;
  onClick?: () => void | Promise<void>;
  compact?: boolean;
}) {
  const disabled = !onClick;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      style={{
        height: compact ? 50 : 60,
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        borderRadius: 14,
        border: `1px solid ${HIFI.stroke}`,
        background: HIFI.surface,
        color: disabled ? HIFI.ink4 : HIFI.ink,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 6 : 12,
        fontFamily: HIFI.fonts.mono,
        fontSize: compact ? 9 : 11,
        fontWeight: 700,
        letterSpacing: compact ? 1 : 1.4,
        transition: 'background 0.2s, border-color 0.2s',
        appearance: 'none',
        WebkitAppearance: 'none',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: compact ? 15 : 18, fontFamily: HIFI.fonts.sans }}>{icon}</span>
      {label}
    </button>
  );
}
