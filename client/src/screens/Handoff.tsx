import type { CSSProperties } from 'react';
import { HIFI } from '../tokens';
import { ScrollBody } from '../components/ScreenChrome';
import { HIFI_APPS, parseSession } from '../sample-data';
import { useRtc } from '../rtc/RtcContext';

// Ported from docs/design/hifi-screens.jsx. Accepts an optional sessionId
// (if the phone arrived with ?session= or ?join= on the URL) and renders
// the real entry card. Token validation is Phase 4 work — for now this
// just renders the handoff visual and hands off to Driving on confirm.

const DEFAULT_SESSION = 'agent:main:discord:1495266157463208138:1766284491';
const DEFAULT_CHANNEL_HINT = '#ai-writing';

export function HandoffScreen({
  onEnter,
  onBack,
  sessionId,
  joinToken,
  threadId,
  channelHint,
  compact = false,
}: {
  onEnter: () => void;
  onBack?: () => void;
  sessionId?: string;
  joinToken?: string | null;
  threadId?: string;
  channelHint?: string;
  compact?: boolean;
}) {
  const rtc = useRtc();
  const effectiveSession = sessionId || DEFAULT_SESSION;
  const sess = parseSession(effectiveSession);
  const app = HIFI_APPS[sess.app] || HIFI_APPS.discord;
  const encoded = encodeURIComponent(effectiveSession);
  const shownChannelHint = channelHint || DEFAULT_CHANNEL_HINT;
  const threadLabel = sess.threadId ? `thread ${sess.threadId.slice(-10)}` : null;
  // The encoded session id is far too long to render inside a 390px URL
  // pill. On compact phones show a short form with a literal "…" so the
  // right edge is unambiguously contained inside the bar.
  const shownUrl = compact
    ? 'clawkietalkie.ai/?session=…'
    : `clawkietalkie.ai/?session=${encoded}`;

  // Single centered compact column wraps the fake browser bar AND the
  // content stack so nothing below renders wider than the column does.
  const columnStyle: CSSProperties = {
    width: '100%',
    maxWidth: compact ? 296 : '100%',
    margin: '0 auto',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      {/* fake browser bar — inside the same compact column as the content
          below, so its right edge can't overrun the session card. */}
      <div
        style={{
          ...columnStyle,
          padding: compact ? '6px 8px 8px' : '6px 14px 8px',
          borderBottom: `1px solid ${HIFI.stroke}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'transparent',
            border: `1px solid ${HIFI.stroke}`,
            color: HIFI.ink2,
            cursor: onBack ? 'pointer' : 'default',
            fontFamily: HIFI.fonts.mono,
            fontSize: 14,
          }}
        >
          ‹
        </button>
        <div
          style={{
            flex: 1,
            padding: '6px 12px',
            borderRadius: 20,
            background: HIFI.surface,
            border: `1px solid ${HIFI.stroke}`,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            color: HIFI.ink2,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          <span style={{ color: '#4ed29a', flexShrink: 0 }}>⚲</span>
          <span
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flex: 1,
            }}
          >
            {shownUrl}
          </span>
        </div>
      </div>

      <ScrollBody pad={compact ? 6 : 22} column>
      <div
        style={{
          ...columnStyle,
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
        }}
      >
        <div style={{ textAlign: 'center', padding: compact ? '8px 0 6px' : '18px 0 10px' }}>
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 11,
              letterSpacing: 2,
              color: HIFI.ink3,
              fontWeight: 700,
              marginBottom: 4,
            }}
          >
            CLAWKIE<span style={{ color: '#ff9e3b' }}>-TALKIE</span>
          </div>
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              letterSpacing: 1.4,
              color: HIFI.ink3,
              marginBottom: compact ? 8 : 18,
            }}
          >
            A WALKY-TALKY FOR YOUR BRAIN
          </div>
        </div>

        <div
          style={{
            padding: compact ? '14px 10px' : '22px 20px',
            borderRadius: 18,
            background: `linear-gradient(160deg, ${HIFI.surface} 0%, #151518 100%)`,
            border: `1px solid ${HIFI.strokeStrong}`,
            marginBottom: compact ? 8 : 16,
            minWidth: 0,
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              letterSpacing: 1.6,
              color: '#ff9e3b',
              fontWeight: 700,
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#ff9e3b',
                animation: 'pulseDot 1.2s ease-in-out infinite',
                boxShadow: '0 0 8px #ff9e3b',
              }}
            />
            NEW SESSION
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            <span
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: app.bg,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: 20,
                fontFamily: HIFI.fonts.sans,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {app.letter}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontFamily: HIFI.fonts.mono,
                  fontSize: 10,
                  letterSpacing: 1.4,
                  color: HIFI.ink3,
                  fontWeight: 700,
                  marginBottom: 3,
                }}
              >
                FROM {app.name.toUpperCase()}
              </div>
              <div
                style={{
                  fontFamily: HIFI.fonts.sans,
                  fontSize: 17,
                  fontWeight: 600,
                  color: HIFI.ink,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {shownChannelHint}
              </div>
              {threadLabel && (
                <div
                  style={{
                    fontFamily: HIFI.fonts.mono,
                    fontSize: 11,
                    color: HIFI.ink3,
                    marginTop: 2,
                    letterSpacing: 0.4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  › {threadLabel}
                </div>
              )}
              {joinToken && (
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: HIFI.fonts.mono,
                    fontSize: 9,
                    letterSpacing: 1,
                    color: HIFI.ink4,
                  }}
                >
                  TOKEN · {joinToken.slice(0, 8)}…{joinToken.slice(-4)}
                </div>
              )}
              {joinToken && (
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: HIFI.fonts.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    color:
                      rtc.status === 'open'
                        ? '#4ed29a'
                        : rtc.status === 'error'
                          ? '#ef6155'
                          : HIFI.ink3,
                    fontWeight: 700,
                  }}
                >
                  DAEMON · {rtc.status.toUpperCase()}
                  {rtc.detail ? ` · ${rtc.detail}` : ''}
                </div>
              )}
            </div>
          </div>

          <button
            onClick={onEnter}
            style={{
              display: 'block',
              width: '100%',
              maxWidth: '100%',
              boxSizing: 'border-box',
              padding: compact ? '14px 10px' : '16px',
              background: '#ff9e3b',
              color: '#000',
              border: 'none',
              borderRadius: 14,
              fontFamily: HIFI.fonts.mono,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 1.4,
              cursor: 'pointer',
              // Inset glow only — no outer drop shadow so the button can
              // never extend visually past its bounding box.
              boxShadow: 'inset 0 0 0 1px rgba(255,158,59,0.9)',
              appearance: 'none',
              WebkitAppearance: 'none',
            }}
          >
            START TALKING →
          </button>
        </div>

        <div
          style={{
            padding: compact ? '10px 12px' : '14px 16px',
            borderRadius: 12,
            border: `1px solid ${HIFI.stroke}`,
            background: HIFI.surface,
            fontFamily: HIFI.fonts.sans,
            fontSize: compact ? 12 : 13,
            color: HIFI.ink2,
            lineHeight: 1.5,
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            minWidth: 0,
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          Anything you record will be linked back to this {app.name} conversation so you can
          pick up either side, any time.
        </div>

        {/* Status strip flows right after the explainer with a small fixed
            gap. No more auto-margin dead zone — the footer feels connected
            to the explainer above it, not stranded at the bottom. */}
        <div
          style={{
            marginTop: compact ? 8 : 20,
            paddingTop: compact ? 8 : 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minWidth: 0,
          }}
        >
          <div
            style={{
              height: 1,
              background: HIFI.stroke,
              margin: '0 -4px',
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              letterSpacing: 1.2,
              color: HIFI.ink2,
              fontWeight: 700,
              padding: '4px 2px 2px',
            }}
          >
            <span
              style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#4ed29a',
                  boxShadow: '0 0 8px #4ed29a',
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                END-TO-END ENCRYPTED
              </span>
            </span>
            <span style={{ color: HIFI.ink3, flexShrink: 0 }}>PHASE 0</span>
          </div>
        </div>
      </div>
      </ScrollBody>
    </div>
  );
}
