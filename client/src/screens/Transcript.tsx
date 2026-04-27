import { useEffect, useMemo, useState } from 'react';
import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';
import {
  exportTranscript,
  loadTranscriptSession,
  type Settings,
  type TranscriptSession,
  type TranscriptTurn,
} from '../storage';

export function TranscriptScreen({
  sessionId,
  onBack,
  compact = false,
  settings,
}: {
  sessionId?: string;
  onBack: () => void;
  compact?: boolean;
  settings: Settings;
}) {
  const [session, setSession] = useState<TranscriptSession | null>(() =>
    sessionId ? loadTranscriptSession(sessionId) : null,
  );
  const subtitle = sessionId ? compactSessionLabel(sessionId) : 'NO SESSION';
  const canExport = !!session && session.turns.length > 0;

  useEffect(() => {
    setSession(sessionId ? loadTranscriptSession(sessionId) : null);
  }, [sessionId]);

  const right = useMemo(
    () => (
      <button
        onClick={() => session && downloadTranscript(session, settings)}
        disabled={!canExport}
        style={{
          height: 36,
          padding: '0 12px',
          borderRadius: 10,
          border: `1px solid ${HIFI.stroke}`,
          background: HIFI.surface,
          color: canExport ? HIFI.ink : HIFI.ink4,
          cursor: canExport ? 'pointer' : 'default',
          fontFamily: HIFI.fonts.mono,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1,
          appearance: 'none',
          WebkitAppearance: 'none',
        }}
      >
        EXPORT
      </button>
    ),
    [canExport, session, settings],
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="Transcript" subtitle={subtitle} onBack={onBack} right={right} />
      <ScrollBody pad={compact ? 2 : 22} column>
        {!session || session.turns.length === 0 ? (
          <EmptyState
            title="No transcript saved"
            body="This phone has not saved any turns for this session yet."
          />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {session.turns.map((turn) => (
              <TurnBubble key={turn.id} turn={turn} showTimestamp={settings.timestamps} />
            ))}
          </div>
        )}
      </ScrollBody>
    </div>
  );
}

function TurnBubble({
  turn,
  showTimestamp,
}: {
  turn: TranscriptTurn;
  showTimestamp: boolean;
}) {
  const isAssistant = turn.role === 'assistant';
  return (
    <div
      style={{
        border: `1px solid ${isAssistant ? 'rgba(127,184,208,0.3)' : HIFI.stroke}`,
        background: isAssistant ? 'rgba(127,184,208,0.09)' : HIFI.surface,
        borderRadius: 14,
        padding: '12px 13px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 7,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.2,
          color: isAssistant ? HIFI.ai : HIFI.ink3,
        }}
      >
        <span>{isAssistant ? 'AI' : 'YOU'}</span>
        {showTimestamp && <span style={{ color: HIFI.ink4 }}>{formatDate(turn.createdAt)}</span>}
        {turn.error && <span style={{ color: '#ef6155' }}>{turn.error}</span>}
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.sans,
          fontSize: 14,
          lineHeight: 1.55,
          color: HIFI.ink,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {turn.text || '(no text)'}
      </div>
    </div>
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
        ↺
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

function downloadTranscript(session: TranscriptSession, settings: Settings): void {
  const exported = exportTranscript(session, settings);
  const blob = new Blob([exported.body], { type: exported.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exported.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
