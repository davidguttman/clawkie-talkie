import { HIFI } from '../tokens';
import { ScreenHeader, DisabledRibbon } from '../components/ScreenChrome';
import { HIFI_APPS, HIFI_SESSIONS, parseSession, type SessionRecord } from '../sample-data';

// Visible but disabled in V1 per the kickoff. Full visual port from
// docs/design/hifi-screens.jsx; search input and row taps are non-interactive.
// OpenClaw/Discord is the transcript source of truth — this screen is
// intentionally a preview.

export function HistoryScreen({
  onBack,
  compact = false,
}: {
  onBack: () => void;
  compact?: boolean;
}) {
  const sessions = HIFI_SESSIONS;
  const totalMin = sessions.reduce((acc, s) => {
    const [m, sec] = s.duration.split(':').map(Number);
    return acc + m + sec / 60;
  }, 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader
        title="History"
        subtitle={`${sessions.length} SESSIONS · ${Math.round(totalMin)} MIN TOTAL`}
        onBack={onBack}
      />

      <DisabledRibbon label="SOURCE OF TRUTH · DISCORD" />

      <div style={{ padding: `12px ${compact ? 2 : 18}px 8px` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: HIFI.surface,
            border: `1px solid ${HIFI.strokeStrong}`,
            borderRadius: 12,
            padding: '11px 14px',
          }}
        >
          <span
            style={{
              color: HIFI.ink,
              fontSize: 15,
              fontFamily: HIFI.fonts.mono,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            ⌕
          </span>
          <input
            disabled
            placeholder="Search transcripts"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: HIFI.ink,
              fontFamily: HIFI.fonts.sans,
              fontSize: 13,
              fontWeight: 600,
            }}
          />
          <span
            style={{
              color: HIFI.ink,
              fontFamily: HIFI.fonts.mono,
              fontSize: 9,
              letterSpacing: 1.2,
              fontWeight: 700,
              flexShrink: 0,
              padding: '3px 8px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.12)',
              border: `1px solid rgba(255,255,255,0.5)`,
            }}
          >
            DISABLED
          </span>
        </div>
      </div>

      <div
        aria-hidden
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          pointerEvents: 'none',
          padding: `0 ${compact ? 2 : 12}px 20px`,
        }}
      >
        {sessions.map((s) => (
          <SessionRow key={s.id} s={s} compact={compact} />
        ))}
        <div style={{ textAlign: 'center', padding: '20px 0 6px' }}>
          <span
            style={{
              padding: '10px 20px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.22)',
              border: '2px solid rgba(255,255,255,0.85)',
              fontFamily: HIFI.fonts.mono,
              fontSize: 13,
              letterSpacing: 1.6,
              color: HIFI.ink,
              fontWeight: 700,
              display: 'inline-block',
            }}
          >
            ● PREVIEW — NOT LIVE IN V1
          </span>
        </div>
      </div>
    </div>
  );
}

// Compact relative labels for the `when` column so long phrases like
// "Yesterday, 8:12am" don't fight with the channel name on narrow phones.
function shortWhen(when: string): string {
  return when
    .replace('Today, ', '')
    .replace('Yesterday, ', 'Yday ')
    .replace(/^([A-Z][a-z]{2}), /, '$1 ');
}

// Explicit ellipsis at the string level. CSS `-webkit-line-clamp` can look
// like a hard cut on some mobile browsers — a literal "…" in the string is
// unambiguous and always visible.
function truncateTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Break at a word boundary when one exists near the end. Guard against
  // the `-1` (no-space) case explicitly so we don't strip the last char.
  const base = lastSpace > 0 && lastSpace > max - 20 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[.,;:]$/, '')}…`;
}

function SessionRow({ s, compact }: { s: SessionRecord; compact?: boolean }) {
  const sess = parseSession(s.id);
  const app = HIFI_APPS[sess.app] || HIFI_APPS.discord;
  const threadLabel = s.threadName
    ? s.threadName
    : sess.threadId
      ? `thread ${sess.threadId.slice(-10)}`
      : null;
  // Literal-character truncation so the ellipsis is always in the string
  // itself, not hoping a CSS rule handles it. On compact, also force a
  // one-line preview with CSS ellipsis as a second layer of defense so
  // truncation is unmistakable. Tighter limits on compact for the title
  // line so the "…" has clear breathing room from the right `when`
  // column instead of pressing up against it.
  const previewLimit = compact ? 36 : 120;
  const preview = truncateTo(s.lastLine, previewLimit);
  const channelLabel = s.channelName || sess.channelId || '';
  // With the `when` column moved off the title row on compact, the title
  // has the full row width to work with — so we can loosen the channel
  // and thread truncation limits back toward natural reading.
  const shortChannel = truncateTo(channelLabel, compact ? 20 : 40);
  const shortThread = threadLabel ? truncateTo(threadLabel, compact ? 16 : 30) : null;

  return (
    <div
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '12px 22px 14px 14px',
        background: 'transparent',
        border: 'none',
        borderBottom: `1px solid ${HIFI.stroke}`,
        color: HIFI.ink,
        borderRadius: 8,
        marginBottom: 2,
        minWidth: 0,
        boxSizing: 'border-box',
        maxWidth: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: compact ? 0 : 14,
          marginBottom: 6,
          minWidth: 0,
          // Only needed on desktop to separate the title from the `when`
          // column. On compact `when` has moved out of this row.
          paddingRight: compact ? 0 : 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              background: app.bg,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: HIFI.fonts.sans,
              fontWeight: 700,
              color: 'white',
              fontSize: 10,
              flexShrink: 0,
            }}
          >
            {app.letter}
          </span>
          <span
            style={{
              display: 'block',
              flex: 1,
              minWidth: 0,
              fontFamily: HIFI.fonts.mono,
              fontSize: 11,
              letterSpacing: 0.4,
              color: s.active ? '#ff9e3b' : HIFI.ink,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {shortChannel}
            {shortThread && (
              <>
                <span style={{ color: HIFI.ink3, margin: '0 4px' }}>›</span>
                <span style={{ color: HIFI.ink2, fontWeight: 500 }}>{shortThread}</span>
              </>
            )}
          </span>
        </div>
        {/* `when` stays in the top-right only on desktop, where the phone
            mockup has room for it. On compact it's pulled out of this row
            entirely (it lands in the footer metadata row below) so the
            title gets the full horizontal space and nothing can clip on
            the right. */}
        {!compact && (
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              color: HIFI.ink,
              fontWeight: 600,
              letterSpacing: 0.6,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {shortWhen(s.when)}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'block',
          fontSize: 13,
          color: HIFI.ink,
          lineHeight: 1.45,
          marginBottom: 10,
          fontFamily: HIFI.fonts.sans,
          fontWeight: 400,
          // On narrow phones force a one-line preview. JS already ends the
          // string with "…" when truncated; combining that with CSS ellipsis
          // makes the truncation unambiguous regardless of font width.
          whiteSpace: compact ? 'nowrap' : 'normal',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          wordBreak: compact ? undefined : 'break-word',
          overflowWrap: compact ? undefined : 'anywhere',
          minWidth: 0,
          // Reserve explicit right breathing room for the preview so the
          // truncation point lands visibly inside the row, not flush with
          // the row padding.
          paddingRight: compact ? 16 : 0,
          boxSizing: 'border-box',
        }}
      >
        {preview}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          color: HIFI.ink,
          fontWeight: 600,
          letterSpacing: 1,
          flexWrap: 'wrap',
        }}
      >
        {compact && (
          <>
            <span style={{ whiteSpace: 'nowrap' }}>{shortWhen(s.when)}</span>
            <span style={{ color: HIFI.ink4 }}>·</span>
          </>
        )}
        <span style={{ whiteSpace: 'nowrap' }}>{s.duration}</span>
        <span style={{ color: HIFI.ink4 }}>·</span>
        <span style={{ whiteSpace: 'nowrap' }}>{s.turns} TURNS</span>
        {s.active && (
          <span
            style={{
              marginLeft: 'auto',
              padding: '2px 7px',
              borderRadius: 10,
              background: '#ff9e3b22',
              color: '#ff9e3b',
              fontWeight: 700,
              letterSpacing: 1.4,
              fontSize: 9,
            }}
          >
            ACTIVE
          </span>
        )}
      </div>
    </div>
  );
}
