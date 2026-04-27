import { useEffect, useState } from 'react';
import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';
import { listTranscriptSessions, type TranscriptSessionMeta } from '../storage';

export function HistoryScreen({
  onBack,
  onOpenSession,
  compact = false,
}: {
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  compact?: boolean;
}) {
  const [sessions, setSessions] = useState<TranscriptSessionMeta[]>(() =>
    listTranscriptSessions(),
  );

  useEffect(() => {
    const refresh = () => setSessions(listTranscriptSessions());
    window.addEventListener('storage', refresh);
    refresh();
    return () => window.removeEventListener('storage', refresh);
  }, []);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="History" subtitle="LOCAL DEVICE" onBack={onBack} />
      <ScrollBody pad={compact ? 2 : 22} column>
        {sessions.length === 0 ? (
          <EmptyState
            title="No local history"
            body="Saved conversations will appear here after a voice reply finishes on this phone."
          />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {sessions.map((session) => (
              <HistoryItem
                key={session.id}
                session={session}
                compact={compact}
                onOpen={() => onOpenSession(session.id)}
              />
            ))}
          </div>
        )}
      </ScrollBody>
    </div>
  );
}

function HistoryItem({
  session,
  compact,
  onOpen,
}: {
  session: TranscriptSessionMeta;
  compact: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        width: '100%',
        minWidth: 0,
        textAlign: 'left',
        border: `1px solid ${HIFI.stroke}`,
        background: HIFI.surface,
        color: HIFI.ink,
        borderRadius: 14,
        padding: compact ? '12px 12px' : '14px 14px',
        cursor: 'pointer',
        appearance: 'none',
        WebkitAppearance: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 12,
            fontWeight: 700,
            color: HIFI.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {compactSessionLabel(session.id)}
        </div>
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            letterSpacing: 1,
            color: HIFI.ink3,
            flexShrink: 0,
          }}
        >
          {session.turnCount} TURNS
        </div>
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.sans,
          fontSize: 13,
          lineHeight: 1.45,
          color: HIFI.ink2,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          wordBreak: 'break-word',
        }}
      >
        {session.preview}
      </div>
      <div
        style={{
          marginTop: 10,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          color: HIFI.ink4,
          letterSpacing: 0.8,
        }}
      >
        {formatDate(session.updatedAt)}
      </div>
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 12,
        padding: '24px 10px',
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          border: `1px solid ${HIFI.stroke}`,
          background: HIFI.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: HIFI.ink3,
          fontFamily: HIFI.fonts.mono,
          fontSize: 22,
        }}
      >
        ≡
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 15,
          fontWeight: 700,
          color: HIFI.ink,
          letterSpacing: 0.4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.sans,
          fontSize: 13,
          lineHeight: 1.5,
          color: HIFI.ink2,
          maxWidth: 300,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function compactSessionLabel(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 22) return trimmed.toUpperCase();
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-8)}`.toUpperCase();
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
