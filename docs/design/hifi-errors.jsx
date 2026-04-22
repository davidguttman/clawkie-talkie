// hifi-errors.jsx — error states for Clawkie-Talkie.
//
// Five meaningful errors, rendered as full-screen overlays on top of the
// Driving screen layout (so chrome + state pill stay visible where relevant).
// Each has: icon, headline, explanation, primary action, optional secondary.
//
// Design principle: car-friendly. Big readable type (no fine print to squint
// at while driving), one dominant action, muted color — errors should
// interrupt without panicking. Red reserved for DESTRUCTIVE/blocked;
// amber for degraded/retry; slate for informational.

window.ErrorScreen = function ErrorScreen({ kind, onDismiss, onRetry, onBack, accent }) {
  const accentCfg = HIFI.accents[accent || 'amber'];
  const e = ERRORS[kind];
  if (!e) return null;

  const toneColor = {
    blocked:  '#ef6155', // red — blocked, user must act
    degraded: '#ff9e3b', // amber — retryable
    info:     HIFI.ink2, // neutral — informational
  }[e.tone];

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      padding: '0 22px 22px', color: HIFI.ink, position: 'relative',
    }}>
      {/* Minimal header — matches driving chrome so user doesn't feel lost */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 0 14px',
      }}>
        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 600,
          color: HIFI.ink3, letterSpacing: 1.4,
        }}>WLKY · ERROR</div>
        <div style={{
          display: 'inline-flex', gap: 6, alignItems: 'center',
          padding: '3px 10px', borderRadius: 20,
          border: `1px solid ${toneColor}55`,
          background: `${toneColor}11`,
          fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 700,
          letterSpacing: 1.4, color: toneColor,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: toneColor,
            boxShadow: `0 0 8px ${toneColor}`,
          }} />
          {e.pill}
        </div>
      </div>

      {/* Main content — vertically centered, icon + headline + body */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        gap: 18, paddingBottom: 20,
      }}>
        <ErrorIcon glyph={e.glyph} color={toneColor} />

        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 18, fontWeight: 600,
          color: HIFI.ink, letterSpacing: 0.3, lineHeight: 1.3,
          maxWidth: 280,
        }}>{e.headline}</div>

        <div style={{
          fontFamily: HIFI.fonts.sans, fontSize: 14, color: HIFI.ink2,
          lineHeight: 1.5, maxWidth: 280,
        }}>{e.body}</div>

        {e.detail && (
          <div style={{
            marginTop: 4, padding: '8px 12px', borderRadius: 8,
            background: HIFI.surface, border: `1px solid ${HIFI.stroke}`,
            fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink3,
            letterSpacing: 0.4, maxWidth: 280, wordBreak: 'break-all',
          }}>{e.detail}</div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          onClick={e.primaryAction === 'retry' ? onRetry : e.primaryAction === 'back' ? onBack : onDismiss}
          style={{
            width: '100%', padding: '16px',
            background: toneColor, color: '#000',
            border: 'none', borderRadius: 14,
            fontFamily: HIFI.fonts.mono, fontSize: 13, fontWeight: 700,
            letterSpacing: 1.6, cursor: 'pointer',
            boxShadow: `0 0 24px ${toneColor}66`,
          }}>{e.primaryLabel}</button>

        {e.secondaryLabel && (
          <button
            onClick={onDismiss}
            style={{
              width: '100%', padding: '14px',
              background: 'transparent', color: HIFI.ink2,
              border: `1px solid ${HIFI.stroke}`, borderRadius: 14,
              fontFamily: HIFI.fonts.mono, fontSize: 11, fontWeight: 600,
              letterSpacing: 1.4, cursor: 'pointer',
            }}>{e.secondaryLabel}</button>
        )}
      </div>
    </div>
  );
};

// Decorative icon — just a colored square with a glyph, cheap and legible
function ErrorIcon({ glyph, color }) {
  return (
    <div style={{
      width: 68, height: 68, borderRadius: 18,
      background: `${color}18`, border: `1px solid ${color}44`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 34, color: color, fontFamily: HIFI.fonts.mono, fontWeight: 300,
    }}>{glyph}</div>
  );
}

const ERRORS = {
  // 1. Mic permission denied — classic first-use wall. User must leave app.
  mic_denied: {
    tone: 'blocked',
    pill: 'MIC BLOCKED',
    glyph: '⊘',
    headline: "Can't hear you",
    body: 'Clawkie-Talkie needs microphone access. Enable it in iOS Settings, then come back.',
    primaryLabel: 'OPEN SETTINGS',
    primaryAction: 'dismiss',
    secondaryLabel: 'NOT NOW',
  },

  // 2. Network drop — mid-session, AI can't reply. Simple retry.
  offline: {
    tone: 'degraded',
    pill: 'OFFLINE',
    glyph: '⇢',
    headline: 'No connection',
    body: 'We saved what you said. As soon as you\'re back online, the AI will reply.',
    primaryLabel: 'TRY AGAIN',
    primaryAction: 'retry',
  },

  // 3. Transcription failed — we heard something but couldn't turn it into text.
  stt_failed: {
    tone: 'degraded',
    pill: 'RETRY',
    glyph: '≈',
    headline: "Couldn't catch that",
    body: 'Say it again — try to speak closer to the mic and cut engine noise if you can.',
    detail: 'STT error · 504',
    primaryLabel: 'TAP TO RETRY',
    primaryAction: 'retry',
    secondaryLabel: 'CANCEL',
  },

  // 4. TTS failed — AI has the reply text but audio won't play.
  tts_failed: {
    tone: 'info',
    pill: 'AUDIO OFF',
    glyph: '◌',
    headline: "Can't play audio",
    body: 'Your reply is ready — it\'s in the transcript. Audio playback hit an error; the text is all saved.',
    primaryLabel: 'READ IT',
    primaryAction: 'dismiss',
    secondaryLabel: 'DISMISS',
  },

  // 5. Invalid/expired handoff — the ?session= link is bad.
  bad_session: {
    tone: 'blocked',
    pill: 'LINK EXPIRED',
    glyph: '⚠',
    headline: 'This session link isn\'t valid',
    body: 'Handoff links expire after 15 minutes. Go back to your chat and tap the link again to get a fresh one.',
    primaryLabel: 'GOT IT',
    primaryAction: 'dismiss',
  },
};
