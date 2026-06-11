import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { HIFI } from '../tokens';
import { useRtc } from '../rtc/RtcContext';
import {
  phoneToDaemon,
  type NewSessionDestinationOption,
  type NewSessionDestinationProvider,
  type NewSessionDestinationsCatalog,
  type RecentSession,
} from '../voice/protocol';
import type { RecentSessionFavoriteState } from '../storage';

const DASHBOARD_REFRESH_TIMEOUT_MS = 12_000;
const NEW_SESSION_CREATE_TIMEOUT_MS = 15_000;

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
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const showNewSession = rtc.newSessionsSupported;

  useEffect(() => {
    if (!showNewSession) setNewSessionOpen(false);
  }, [showNewSession]);

  useEffect(() => {
    if (!showNewSession || rtc.status !== 'open') return;
    rtc.requestNewSessionDestinations();
  }, [showNewSession, rtc.status, rtc.requestNewSessionDestinations]);

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
  const daemonRendezvousDetail = formatDaemonRendezvousDetail(rtc.detail);
  const showError = daemonRendezvousDetail && rtc.status !== 'open';

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
          <h1
            style={{
              margin: 0,
              fontSize: compact ? 26 : 30,
              lineHeight: 1.05,
              letterSpacing: -0.8,
            }}
          >
            Recent Sessions
          </h1>
        </div>
        {(showNewSession || onHistory || onSettings) && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {showNewSession && (
              <button
                type="button"
                onClick={() => setNewSessionOpen(true)}
                aria-label="New session"
                style={{
                  minWidth: compact ? 56 : 64,
                  height: 34,
                  borderRadius: 12,
                  background: `${HIFI.ai}14`,
                  border: `1px solid ${HIFI.ai}66`,
                  color: HIFI.ai,
                  cursor: 'pointer',
                  fontFamily: HIFI.fonts.mono,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: 1.1,
                  flexShrink: 0,
                }}
              >
                + NEW
              </button>
            )}
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
        >
          daemon connection{updatedLabel ? ` · ${updatedLabel}` : ''}
        </div>
        {showError && <Notice tone="error">{daemonRendezvousDetail}</Notice>}
        {showTimedOut && <Notice tone="warn">No recent-session response yet. The daemon may still be starting.</Notice>}
        {showUnsupported && <Notice tone="warn">This daemon does not support host dashboard session discovery.</Notice>}
      </section>

      {newSessionOpen ? (
        <NewSessionFlow
          compact={compact}
          onClose={() => setNewSessionOpen(false)}
          onCreated={(session) => {
            setNewSessionOpen(false);
            onSelectSession(session);
          }}
        />
      ) : (
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
      )}
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
  const preview = formatSessionPreview(session);
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
        {preview && (
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: HIFI.ink2,
              fontSize: compact ? 11 : 12,
              lineHeight: 1.35,
            }}
            title={preview.text}
          >
            <span style={{ color: preview.tone === 'assistant' ? HIFI.ai : HIFI.ink3, fontWeight: 800 }}>
              {preview.label}:
            </span>{' '}
            {preview.text}
          </span>
        )}
      </button>
    </div>
  );
}

type NewSessionCreatePhase =
  | { phase: 'idle' }
  | { phase: 'creating'; requestId: string }
  | { phase: 'error'; message: string };

export function filterNewSessionDestinations(
  destinations: NewSessionDestinationOption[],
  query: string,
): NewSessionDestinationOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return destinations;
  return destinations.filter(
    (destination) =>
      destination.label.toLowerCase().includes(normalized) ||
      destination.target.toLowerCase().includes(normalized) ||
      (destination.group ?? '').toLowerCase().includes(normalized),
  );
}

export function groupNewSessionDestinations(
  destinations: NewSessionDestinationOption[],
): { group?: string; destinations: NewSessionDestinationOption[] }[] {
  const groups: { group?: string; destinations: NewSessionDestinationOption[] }[] = [];
  const byGroup = new Map<string, NewSessionDestinationOption[]>();
  for (const destination of destinations) {
    const key = destination.group ?? '';
    let bucket = byGroup.get(key);
    if (!bucket) {
      bucket = [];
      byGroup.set(key, bucket);
      groups.push({ ...(destination.group ? { group: destination.group } : {}), destinations: bucket });
    }
    bucket.push(destination);
  }
  return groups;
}

// The picker only ever shows creatable choices: the local web session
// plus channel providers the daemon backed with real parent channels.
// Anything else — providers without destinations, non-available
// statuses from older daemons — is omitted entirely rather than shown
// as a disabled card or "not supported yet" placeholder.
export function listSelectableNewSessionProviders(
  catalog: NewSessionDestinationsCatalog,
): NewSessionDestinationProvider[] {
  return catalog.providers.filter(
    (provider) =>
      provider.status === 'available' &&
      (provider.kind === 'local' || provider.destinations.length > 0),
  );
}

export function formatNewSessionCreateError(message: unknown): string {
  const code = typeof message === 'string' ? message : '';
  if (code === 'new_session_destination_unsupported') {
    return 'The daemon cannot create sessions for that destination.';
  }
  if (
    code === 'invalid_new_session_request' ||
    code === 'invalid_new_session_agent' ||
    code === 'invalid_new_session_target' ||
    code === 'invalid_new_session_account'
  ) {
    return 'The daemon rejected the new-session request.';
  }
  if (code === 'discord_thread_create_failed') {
    return 'The daemon could not create the Discord thread.';
  }
  if (code === 'discord_thread_id_unresolved') {
    return 'Discord did not return a usable thread id.';
  }
  if (code === 'slack_thread_create_failed') {
    return 'The daemon could not start the Slack thread.';
  }
  if (code === 'slack_thread_ts_unresolved') {
    return 'Slack did not return a usable thread timestamp.';
  }
  if (code === 'new_session_timeout') {
    return 'No response from the daemon. Try again.';
  }
  return code ? `Session creation failed: ${code}` : 'Session creation failed.';
}

function makeNewSessionRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `new-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isNewSessionDestinationsCatalog(value: unknown): value is NewSessionDestinationsCatalog {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as { providers?: unknown }).providers)
  );
}

function webOnlyNewSessionDestinationsCatalog(): NewSessionDestinationsCatalog {
  return {
    generatedAt: '',
    providers: [
      {
        id: 'webchat',
        label: 'Web only (no chat channel)',
        kind: 'local',
        status: 'available',
        destinations: [],
      },
    ],
  };
}

function NewSessionFlow({
  compact,
  onClose,
  onCreated,
}: {
  compact: boolean;
  onClose: () => void;
  onCreated: (session: RecentSession) => void;
}) {
  const rtc = useRtc();
  const { sendControl, addControlListener } = rtc;
  const [catalog, setCatalog] = useState<NewSessionDestinationsCatalog | null>(
    rtc.newSessionDestinationsCatalog ?? webOnlyNewSessionDestinationsCatalog(),
  );
  const [providerId, setProviderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [create, setCreate] = useState<NewSessionCreatePhase>({ phase: 'idle' });
  const creatingRequestIdRef = useRef<string | null>(null);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  useEffect(() => {
    if (rtc.newSessionDestinationsCatalog) setCatalog(rtc.newSessionDestinationsCatalog);
  }, [rtc.newSessionDestinationsCatalog, rtc.newSessionDestinationsResponseSeq]);

  useEffect(() => {
    if (!rtc.newSessionDestinationsCatalog) rtc.requestNewSessionDestinations();
  }, [rtc.newSessionDestinationsCatalog, rtc.requestNewSessionDestinations]);

  useEffect(() => {
    return addControlListener((msg) => {
      if (msg.t === 'sessions.destinations' && isNewSessionDestinationsCatalog(msg.catalog)) {
        setCatalog(msg.catalog);
        return;
      }
      if (
        msg.t === 'sessions.created' &&
        typeof msg.requestId === 'string' &&
        msg.requestId === creatingRequestIdRef.current &&
        msg.session &&
        typeof msg.session === 'object'
      ) {
        creatingRequestIdRef.current = null;
        setCreate({ phase: 'idle' });
        onCreatedRef.current(msg.session as RecentSession);
        return;
      }
      if (
        msg.t === 'sessions.create.error' &&
        typeof msg.requestId === 'string' &&
        msg.requestId === creatingRequestIdRef.current
      ) {
        creatingRequestIdRef.current = null;
        setCreate({ phase: 'error', message: formatNewSessionCreateError(msg.message) });
      }
    });
  }, [addControlListener]);

  useEffect(() => {
    if (create.phase !== 'creating') return;
    const requestId = create.requestId;
    const timeout = window.setTimeout(() => {
      setCreate((current) => {
        if (current.phase !== 'creating' || current.requestId !== requestId) return current;
        creatingRequestIdRef.current = null;
        return { phase: 'error', message: formatNewSessionCreateError('new_session_timeout') };
      });
    }, NEW_SESSION_CREATE_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [create]);

  const startCreate = useCallback(
    (input: { providerId: string; target?: string; accountId?: string }) => {
      const requestId = makeNewSessionRequestId();
      creatingRequestIdRef.current = requestId;
      setCreate({ phase: 'creating', requestId });
      sendControl(
        phoneToDaemon.sessionsCreateRequest({
          requestId,
          providerId: input.providerId,
          ...(input.target ? { target: input.target } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
        }),
      );
    },
    [sendControl],
  );

  const creating = create.phase === 'creating';
  const destinationsStillLoading = !rtc.newSessionDestinationsCatalog;
  const selectableProviders = useMemo(
    () => (catalog ? listSelectableNewSessionProviders(catalog) : []),
    [catalog],
  );
  const activeProvider = providerId
    ? selectableProviders.find((provider) => provider.id === providerId) ?? null
    : null;
  const filteredGroups = useMemo(
    () =>
      activeProvider
        ? groupNewSessionDestinations(filterNewSessionDestinations(activeProvider.destinations, query))
        : [],
    [activeProvider, query],
  );

  return (
    <section
      aria-label="New session"
      style={{
        minHeight: 0,
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gap: 10,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.4,
            color: HIFI.ink2,
          }}
        >
          {activeProvider ? `NEW SESSION · ${activeProvider.label.toUpperCase()}` : 'NEW SESSION · CHOOSE CHAT'}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {activeProvider && (
            <button
              type="button"
              onClick={() => {
                setProviderId(null);
                setQuery('');
              }}
              disabled={creating}
              style={newSessionHeaderButtonStyle(creating)}
            >
              BACK
            </button>
          )}
          <button type="button" onClick={onClose} disabled={creating} style={newSessionHeaderButtonStyle(creating)}>
            CANCEL
          </button>
        </div>
      </div>

      <div style={{ minHeight: 0, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 8 }}>
        {create.phase === 'error' && <Notice tone="error">{create.message}</Notice>}
        {creating && (
          <div
            role="status"
            style={{
              border: `1px dashed ${HIFI.stroke}`,
              borderRadius: 14,
              color: HIFI.ink2,
              padding: 14,
              fontSize: 13,
            }}
          >
            Creating session…
          </div>
        )}
        {catalog && !activeProvider && !creating && (
          <>
            {selectableProviders.map((provider) => (
              <NewSessionProviderButton
                key={provider.id}
                provider={provider}
                compact={compact}
                onSelect={() => {
                  if (provider.kind === 'local') {
                    startCreate({ providerId: provider.id });
                    return;
                  }
                  setProviderId(provider.id);
                  setQuery('');
                }}
              />
            ))}
            {destinationsStillLoading && (
              <div
                role="status"
                style={{
                  border: `1px dashed ${HIFI.stroke}`,
                  borderRadius: 14,
                  color: HIFI.ink3,
                  padding: 12,
                  lineHeight: 1.4,
                  fontSize: 12,
                }}
              >
                Loading chat destinations in the background…
              </div>
            )}
          </>
        )}
        {catalog && activeProvider && !creating && (
          <>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${activeProvider.label} channels…`}
              aria-label="Search destinations"
              autoFocus
              style={{
                width: '100%',
                boxSizing: 'border-box',
                borderRadius: 12,
                border: `1px solid ${HIFI.stroke}`,
                background: 'rgba(255,255,255,0.05)',
                color: HIFI.ink,
                fontFamily: HIFI.fonts.sans,
                fontSize: compact ? 13 : 14,
                padding: '10px 12px',
                outline: 'none',
              }}
            />
            {filteredGroups.length === 0 && (
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
                {activeProvider.destinations.length === 0
                  ? 'No writable destinations reported by the daemon.'
                  : 'No destinations match your search.'}
              </div>
            )}
            {filteredGroups.map((group) => (
              <div key={group.group ?? ''} style={{ display: 'grid', gap: 6 }}>
                {group.group && (
                  <div
                    style={{
                      fontFamily: HIFI.fonts.mono,
                      fontSize: 9,
                      fontWeight: 800,
                      letterSpacing: 1.2,
                      color: HIFI.ink3,
                    }}
                  >
                    {group.group.toUpperCase()}
                  </div>
                )}
                {group.destinations.map((destination) => (
                  <button
                    key={destination.id}
                    type="button"
                    onClick={() =>
                      startCreate({
                        providerId: activeProvider.id,
                        target: destination.target,
                        ...(destination.accountId ? { accountId: destination.accountId } : {}),
                      })
                    }
                    style={{
                      display: 'grid',
                      gap: 4,
                      textAlign: 'left',
                      minWidth: 0,
                      width: '100%',
                      borderRadius: 14,
                      border: `1px solid ${HIFI.stroke}`,
                      background: 'rgba(255,255,255,0.045)',
                      color: HIFI.ink,
                      cursor: 'pointer',
                      padding: compact ? '10px 12px' : '12px 14px',
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
                      title={destination.label}
                    >
                      {destination.label}
                    </span>
                    <span
                      style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: HIFI.ink3,
                        fontFamily: HIFI.fonts.mono,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                      }}
                    >
                      {destination.target}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function newSessionHeaderButtonStyle(disabled: boolean): CSSProperties {
  return {
    minWidth: 64,
    height: 30,
    borderRadius: 10,
    background: 'transparent',
    border: `1px solid ${HIFI.stroke}`,
    color: disabled ? HIFI.ink3 : HIFI.ink2,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: HIFI.fonts.mono,
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 1.1,
    flexShrink: 0,
  };
}

function NewSessionProviderButton({
  provider,
  compact,
  onSelect,
}: {
  provider: NewSessionDestinationProvider;
  compact: boolean;
  onSelect: () => void;
}) {
  const description = provider.kind === 'local'
    ? 'Voice-only OpenClaw session. Replies stay in the app.'
    : `${provider.destinations.length} channel${provider.destinations.length === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'grid',
        gap: 4,
        textAlign: 'left',
        minWidth: 0,
        width: '100%',
        borderRadius: 14,
        border: `1px solid ${HIFI.stroke}`,
        background: 'rgba(255,255,255,0.045)',
        color: HIFI.ink,
        cursor: 'pointer',
        padding: compact ? '10px 12px' : '12px 14px',
        fontFamily: HIFI.fonts.sans,
      }}
    >
      <span style={{ fontSize: compact ? 14 : 15, fontWeight: 800 }}>{provider.label}</span>
      <span
        style={{
          color: HIFI.ink3,
          fontSize: compact ? 11 : 12,
          lineHeight: 1.35,
        }}
      >
        {description}
      </span>
    </button>
  );
}

function formatSessionPreview(session: RecentSession): { label: string; text: string; tone: 'assistant' | 'latest' } | null {
  const assistantPreview = session.lastAssistantPreview?.trim();
  if (assistantPreview) return { label: 'Agent', text: assistantPreview, tone: 'assistant' };
  const latestPreview = session.lastMessagePreview?.trim();
  if (!latestPreview) return null;
  const role = session.lastMessageRole?.trim().toLowerCase();
  return {
    label: role && role !== 'assistant' ? `Latest ${role}` : 'Latest',
    text: latestPreview,
    tone: 'latest',
  };
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

function formatDaemonRendezvousDetail(detail?: string): string | null {
  if (!detail || detail === 'session_replaced') return null;
  if (detail === 'unsupported_daemon_protocol') {
    return 'Daemon protocol/capability mismatch. Update the installed daemon.';
  }
  return `Daemon rendezvous error: ${detail}`;
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
