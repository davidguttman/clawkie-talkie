import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HIFI } from '../tokens';
import { useRtc } from '../rtc/RtcContext';
import type { RecentSession } from '../voice/protocol';
import type { RecentSessionFavoriteState } from '../storage';

const DASHBOARD_REFRESH_TIMEOUT_MS = 12_000;

type RefreshPhase = 'idle' | 'loading' | 'refreshing';

export function DashboardScreen({
  hostPeerId,
  onSelectSession,
  onHistory,
  onSettings,
  compact = false,
}: {
  hostPeerId?: string | null;
  onSelectSession: (session: RecentSession) => void;
  onHistory?: () => void;
  onSettings?: () => void;
  compact?: boolean;
}) {
  const rtc = useRtc();
  const [refresh, setRefresh] = useState<{ phase: RefreshPhase; requestId: number; timedOut: boolean }>({
    phase: 'idle',
    requestId: 0,
    timedOut: false,
  });

  const requestSessions = useCallback((phase: RefreshPhase = rtc.recentSessionsGeneratedAt ? 'refreshing' : 'loading') => {
    setRefresh((current) => ({
      phase,
      requestId: current.requestId + 1,
      timedOut: false,
    }));
    rtc.requestRecentSessions();
  }, [rtc]);

  useEffect(() => {
    if (rtc.status === 'open' && rtc.recentSessionsSupportStatus !== 'unsupported') {
      requestSessions('loading');
    }
  // Request once when the host rendezvous lane opens; the provider also
  // subscribes, but this makes the dashboard eager when opened from PWA.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtc.status]);

  useEffect(() => {
    if (rtc.recentSessionsResponseSeq <= 0) return;
    setRefresh((current) => ({ phase: 'idle', requestId: current.requestId, timedOut: false }));
  }, [rtc.recentSessionsResponseSeq]);

  useEffect(() => {
    if (refresh.phase === 'idle') return;
    const requestId = refresh.requestId;
    const timeout = window.setTimeout(() => {
      setRefresh((current) =>
        current.requestId === requestId && current.phase !== 'idle'
          ? { phase: 'idle', requestId: current.requestId, timedOut: true }
          : current,
      );
    }, DASHBOARD_REFRESH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [refresh.phase, refresh.requestId]);

  const waiting = refresh.phase !== 'idle';
  const connectionLabel = formatConnectionLabel(rtc.status, rtc.detail);
  const updatedLabel = formatUpdatedAt(rtc.recentSessionsGeneratedAt);
  const supportStatus = rtc.recentSessionsSupportStatus;
  const hasRecentSessionResponse = rtc.recentSessions.length > 0 || !!rtc.recentSessionsGeneratedAt;
  const showUnsupported = supportStatus === 'unsupported' && !hasRecentSessionResponse;
  const showTimedOut = refresh.timedOut && !hasRecentSessionResponse;
  const showError = rtc.detail && rtc.detail !== 'session_replaced' && rtc.status !== 'open';

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        width: '100%',
        display: 'grid',
        gridTemplateRows: 'auto auto minmax(0, 1fr)',
        gap: compact ? 12 : 16,
        padding: compact ? '12px 10px 14px' : '18px 20px',
        boxSizing: 'border-box',
        color: HIFI.ink,
        fontFamily: HIFI.fonts.sans,
        overflow: 'hidden',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.5,
              color: HIFI.ink2,
            }}
          >
            CLAWKIE-TALKIE DASHBOARD
          </div>
          <h1
            style={{
              margin: '8px 0 0',
              fontSize: compact ? 26 : 30,
              lineHeight: 1.05,
              letterSpacing: -0.8,
            }}
          >
            Pick a session
          </h1>
        </div>
        {(onHistory || onSettings) && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {onHistory && (
              <button
                type="button"
                onClick={onHistory}
                aria-label="History"
                style={{
                  minWidth: compact ? 76 : 84,
                  height: 34,
                  borderRadius: 12,
                  background: 'transparent',
                  border: `1px solid ${HIFI.stroke}`,
                  color: HIFI.ink2,
                  cursor: 'pointer',
                  fontFamily: HIFI.fonts.mono,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: 1.1,
                  flexShrink: 0,
                }}
              >
                HISTORY
              </button>
            )}
            {onSettings && (
              <button
                type="button"
                onClick={onSettings}
                aria-label="Settings"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 12,
                  background: 'transparent',
                  border: `1px solid ${HIFI.stroke}`,
                  color: HIFI.ink2,
                  cursor: 'pointer',
                  fontSize: 16,
                  flexShrink: 0,
                }}
              >
                ⚙
              </button>
            )}
          </div>
        )}
      </header>

      <section
        aria-label="Daemon connection"
        style={{
          display: 'grid',
          gap: 8,
          border: `1px solid ${HIFI.stroke}`,
          borderRadius: 16,
          background: 'rgba(255,255,255,0.035)',
          padding: compact ? 10 : 12,
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <StatusPill status={rtc.status} label={connectionLabel} />
          <button
            type="button"
            onClick={() => {
              if (rtc.canRetryConnection) {
                rtc.retryConnection();
                return;
              }
              requestSessions(rtc.recentSessionsGeneratedAt ? 'refreshing' : 'loading');
            }}
            disabled={!rtc.canRetryConnection && (waiting || rtc.status !== 'open')}
            style={{
              border: `1px solid ${HIFI.stroke}`,
              borderRadius: 999,
              background: waiting && !rtc.canRetryConnection ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)',
              color: !rtc.canRetryConnection && (waiting || rtc.status !== 'open') ? HIFI.ink3 : HIFI.ink,
              cursor: !rtc.canRetryConnection && (waiting || rtc.status !== 'open') ? 'default' : 'pointer',
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1.1,
              padding: '7px 10px',
            }}
          >
            {rtc.canRetryConnection ? 'RECONNECT' : waiting ? 'REFRESHING…' : 'REFRESH'}
          </button>
        </div>
        <div
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: HIFI.fonts.mono,
            color: HIFI.ink3,
            fontSize: 10,
            letterSpacing: 0.2,
          }}
          title={hostPeerId || undefined}
        >
          host {hostPeerId || 'missing'}{updatedLabel ? ` · ${updatedLabel}` : ''}
        </div>
        {showError && <Notice tone="error">Daemon rendezvous error: {rtc.detail}</Notice>}
        {showTimedOut && <Notice tone="warn">No recent-session response yet. The daemon may still be starting.</Notice>}
        {showUnsupported && <Notice tone="warn">This daemon does not support host dashboard session discovery.</Notice>}
      </section>

      <section
        aria-label="Recent OpenClaw sessions"
        style={{
          minHeight: 0,
          display: 'grid',
          gridTemplateRows: 'auto minmax(0, 1fr)',
          gap: 10,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.4,
            color: HIFI.ink2,
          }}
        >
          RECENT OPENCLAW SESSIONS
        </div>
        <div style={{ minHeight: 0, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 8 }}>
          {rtc.recentSessions.length > 0 ? (
            rtc.recentSessions.map((session) => (
              <SessionButton
                key={`${session.sessionKey}:${session.sessionId}`}
                session={session}
                compact={compact}
                onSelect={onSelectSession}
              />
            ))
          ) : (
            <EmptyState
              loading={waiting || supportStatus === 'probing'}
              connected={rtc.status === 'open'}
              unsupported={showUnsupported}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const color = status === 'open' ? HIFI.ai : status === 'error' || status === 'closed' ? HIFI.accents.red.rec : HIFI.think;
  return (
    <div
      role="status"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        minWidth: 0,
        borderRadius: 999,
        border: `1px solid ${color}55`,
        background: `${color}12`,
        color,
        fontFamily: HIFI.fonts.mono,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 1.1,
        padding: '7px 10px',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, boxShadow: `0 0 9px ${color}` }} />
      {label}
    </div>
  );
}

function SessionButton({
  session,
  compact,
  onSelect,
}: {
  session: RecentSessionFavoriteState;
  compact: boolean;
  onSelect: (session: RecentSession) => void;
}) {
  const favorite = session.favorite === true;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        alignItems: 'stretch',
        gap: 8,
        minWidth: 0,
        width: '100%',
        borderRadius: 14,
        border: `1px solid ${favorite ? `${HIFI.ai}88` : HIFI.stroke}`,
        background: favorite ? `${HIFI.ai}10` : 'rgba(255,255,255,0.045)',
        padding: compact ? '8px 8px 8px 12px' : '10px 10px 10px 14px',
        boxSizing: 'border-box',
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(session)}
        style={{
          display: 'grid',
          gap: 6,
          minWidth: 0,
          width: '100%',
          textAlign: 'left',
          border: 0,
          background: 'transparent',
          color: HIFI.ink,
          cursor: 'pointer',
          padding: 0,
          fontFamily: HIFI.fonts.sans,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: compact ? 14 : 15,
            fontWeight: 800,
          }}
          title={session.displayLabel}
        >
          {session.displayLabel}
        </span>
        <span
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            minWidth: 0,
            color: HIFI.ink3,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          <span>{session.agent || 'unknown'}</span>
          {session.channel && <span>{session.channel}</span>}
          {session.lastActivity && <span>{formatRelativeActivity(session.lastActivity)}</span>}
          {session.persistedFavorite && <span>SAVED</span>}
        </span>
      </button>
    </div>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone: 'warn' | 'error' }) {
  const color = tone === 'error' ? HIFI.accents.red.rec : HIFI.think;
  return (
    <div
      role="status"
      style={{
        border: `1px solid ${color}55`,
        borderRadius: 10,
        background: `${color}12`,
        color,
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.35,
        padding: '7px 9px',
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({
  loading,
  connected,
  unsupported,
}: {
  loading: boolean;
  connected: boolean;
  unsupported: boolean;
}) {
  const message = unsupported
    ? 'Session discovery is unavailable for this daemon.'
    : loading
      ? 'Loading recent sessions…'
      : connected
        ? 'No recent sessions yet. Start or resume an OpenClaw conversation, then refresh.'
        : 'Connecting to the daemon before loading sessions…';

  return (
    <div
      style={{
        border: `1px dashed ${HIFI.stroke}`,
        borderRadius: 14,
        color: HIFI.ink3,
        padding: 16,
        lineHeight: 1.4,
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function formatConnectionLabel(status: string, detail?: string): string {
  if (status === 'open') return 'CONNECTED';
  if (status === 'connecting') return 'CONNECTING';
  if (status === 'error') return 'ERROR';
  if (status === 'closed') return detail ? 'CLOSED' : 'DISCONNECTED';
  return 'WAITING';
}

function formatUpdatedAt(generatedAt?: string): string | null {
  if (!generatedAt) return null;
  const updatedAt = Date.parse(generatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  const elapsedMs = Math.max(0, Date.now() - updatedAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return 'updated just now';
  if (elapsedMinutes < 60) return `updated ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `updated ${elapsedHours}h ago`;
  return `updated ${new Date(updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

export function formatRelativeActivity(value: string, now = Date.now()): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  const elapsedMs = Math.max(0, now - ts);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}
