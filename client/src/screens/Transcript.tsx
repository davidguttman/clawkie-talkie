import { HIFI } from '../tokens';
import { ScreenHeader, DisabledRibbon } from '../components/ScreenChrome';
import {
  HIFI_APPS,
  HIFI_FULL_TRANSCRIPT,
  HIFI_SESSIONS,
  parseSession,
  type Turn,
} from '../sample-data';

// Visible but disabled placeholder per the kickoff. Port of the transcript
// visual from docs/design/hifi-screens.jsx; action menu is omitted because
// there's nothing real to share yet.

export function TranscriptScreen({
  sessionId,
  onBack,
  compact = false,
}: {
  sessionId?: string;
  onBack: () => void;
  compact?: boolean;
}) {
  const session =
    HIFI_SESSIONS.find((s) => s.id === sessionId) || HIFI_SESSIONS[0];
  const sess = parseSession(session.id);
  const app = HIFI_APPS[sess.app] || HIFI_APPS.discord;
  const threadLabel = session.threadName
    ? session.threadName
    : sess.threadId
      ? `thread ${sess.threadId.slice(-10)}`
      : null;
  const turns = HIFI_FULL_TRANSCRIPT;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        color: HIFI.ink,
        position: 'relative',
      }}
    >
      <ScreenHeader
        title={session.channelName || sess.channelId || ''}
        subtitle={`${threadLabel ? threadLabel.toUpperCase() + ' · ' : ''}${session.when.toUpperCase()} · ${session.duration}`}
        onBack={onBack}
      />
      <DisabledRibbon label="SOURCE OF TRUTH · DISCORD" />

      <div
        aria-hidden
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          opacity: 0.82,
          pointerEvents: 'none',
          padding: `12px ${compact ? 2 : 16}px 20px`,
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 12,
            background: HIFI.surface,
            border: `1px solid ${HIFI.stroke}`,
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            color: HIFI.ink2,
            letterSpacing: 0.6,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: app.bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: HIFI.fonts.sans,
              fontWeight: 700,
              color: 'white',
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {app.letter}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                color: HIFI.ink2,
                fontSize: 9,
                letterSpacing: 1.4,
                marginBottom: 2,
              }}
            >
              HANDED OFF FROM {app.name.toUpperCase()}
            </div>
            <div
              style={{
                color: HIFI.ink,
                fontFamily: HIFI.fonts.mono,
                fontSize: 11,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {session.channelName || sess.channelId}
              {threadLabel && (
                <>
                  <span style={{ color: HIFI.ink3, margin: '0 5px' }}>›</span>
                  <span style={{ color: HIFI.ink2, fontWeight: 500 }}>{threadLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {turns.map((t, i) => (
          <TurnBubble key={i} turn={t} />
        ))}

        <div
          style={{
            marginTop: 18,
            padding: '12px 0',
            textAlign: 'center',
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            color: HIFI.ink2,
            letterSpacing: 1.4,
          }}
        >
          · PREVIEW — NOT LIVE IN V1 ·
        </div>
      </div>
    </div>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  const isUser = turn.who === 'user';
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1.6,
          marginBottom: 4,
          color: isUser ? '#ff9e3b' : HIFI.ai,
        }}
      >
        {isUser ? 'YOU' : 'CLAWKIE-TALKIE'}
      </div>
      <div
        style={{
          fontFamily: HIFI.fonts.sans,
          fontSize: 14,
          lineHeight: 1.55,
          color: isUser ? HIFI.ink : HIFI.ink2,
          fontWeight: isUser ? 500 : 400,
        }}
      >
        {turn.text}
      </div>
    </div>
  );
}
