// Variations 1-3: button-forward driving-mode layouts
// Each variation takes {state} prop: 'idle' | 'recording' | 'thinking' | 'ai'

// ═════════════════════════════════════════════════════════════
// V1 — GIANT BUTTON BOTTOM HALF
// Classic walkie-talkie vibe. Bottom 60% is the button. Top shows
// the LAST turn only (biggest-font caption of what AI just said).
// ═════════════════════════════════════════════════════════════
function V1_BigButton({ state = 'idle' }) {
  const isRec = state === 'recording';
  const isAI  = state === 'ai';
  const isThink = state === 'thinking';

  const btnFill = isRec ? SKETCH.accent
                : isAI  ? SKETCH.ai
                : isThink ? '#d4a72c'
                : SKETCH.paper;
  const btnFg = (isRec || isAI || isThink) ? '#fff' : SKETCH.ink;

  const label = isRec ? 'TAP TO STOP'
              : isAI  ? 'TAP TO INTERRUPT'
              : isThink ? 'THINKING'
              : 'TAP TO TALK';

  // Live-caption content. During recording, you see your words stream
  // in real-time so you can verbally self-correct when the transcriber
  // slips (e.g. "jason" → "JSON"). No in-place edits, no tap targets.
  const cap = isRec ? {
    who: 'YOU · LIVE',
    color: SKETCH.accent,
    committed: 'Okay so we\'re going with jason',
    pending: ' — sorry, I mean JSON, capital letters, not the—',
  } : isAI ? {
    who: 'AI · SPEAKING',
    color: SKETCH.ai,
    committed: 'Got it — using JSON for the config format. The two pressure points I see are the integration work in May and',
    pending: ' design review right before the—',
  } : isThink ? {
    who: 'THINKING',
    color: '#8a6d1f',
    committed: '(processing)',
    pending: '',
  } : {
    who: 'LAST REPLY',
    color: SKETCH.muted,
    committed: '"I\'ll draft that email to Sam and save it for when you\'re back at your desk."',
    pending: '',
  };

  return (
    <PaperPhone>
      <PhoneScreen>
        {/* top bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
          <div style={{ fontFamily: SKETCH.hand, fontSize: 20, fontWeight: 700 }}>WalkyTalkAI</div>
          <StatusChip state={state} />
        </div>

        {/* LIVE CAPTION — streams as you speak / AI speaks */}
        <div style={{
          marginTop: 16, padding: '14px 4px 16px',
          borderBottom: `1.5px dashed ${SKETCH.faint}`,
        }}>
          <div style={{
            fontFamily: SKETCH.mono, fontSize: 10, color: cap.color,
            letterSpacing: 1.5, marginBottom: 8, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {(isRec || isAI) && <span style={{
              width: 6, height: 6, borderRadius: '50%', background: cap.color,
              animation: 'sketchpulse 1.2s ease-in-out infinite',
            }} />}
            {cap.who}
          </div>
          <div style={{
            fontFamily: SKETCH.body, fontSize: 18, lineHeight: 1.4,
            color: SKETCH.ink, fontWeight: 500, minHeight: 126,
          }}>
            {cap.committed}
            {cap.pending && (
              <span style={{ color: cap.color, opacity: 0.7 }}>
                {cap.pending}
                <span style={{
                  display: 'inline-block', width: 2, height: 16,
                  background: cap.color, marginLeft: 2, verticalAlign: 'middle',
                  animation: 'sketchpulse 0.8s step-end infinite',
                }} />
              </span>
            )}
          </div>
        </div>

        {/* waveform strip — live feedback */}
        <div style={{
          padding: '10px 0 6px', display: 'flex', justifyContent: 'center',
        }}>
          <Waveform width={240} height={28} bars={28} state={state === 'thinking' ? 'idle' : state} />
        </div>

        {/* the BIG button */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginTop: 4, marginBottom: 10,
        }}>
          <SCircle size={200} thick filled={btnFill} style={{
            boxShadow: isRec
              ? `0 0 0 8px ${SKETCH.accentSoft}, 3px 4px 0 rgba(0,0,0,0.1)`
              : isAI
              ? `0 0 0 8px ${SKETCH.aiSoft}, 3px 4px 0 rgba(0,0,0,0.1)`
              : '3px 4px 0 rgba(0,0,0,0.1)',
            transition: 'all 0.3s',
          }}>
            <div style={{ textAlign: 'center', color: btnFg }}>
              <div style={{ fontSize: 46, lineHeight: 1 }}>
                {isRec ? '■' : isAI ? '◉' : isThink ? '…' : '●'}
              </div>
              <div style={{
                fontFamily: SKETCH.mono, fontSize: 11, fontWeight: 700,
                letterSpacing: 1.5, marginTop: 8,
              }}>{label}</div>
            </div>
          </SCircle>
        </div>

        {/* BIGGER footer buttons — real tap targets for driving */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, paddingTop: 4,
        }}>
          <SBox rounded={18} thick style={{
            height: 66, display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 10, background: SKETCH.paperAlt,
          }}>
            <span style={{ fontSize: 26 }}>↺</span>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1.5, fontWeight: 700 }}>
              REPLAY
            </div>
          </SBox>
          <SBox rounded={18} thick style={{
            height: 66, display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 10, background: SKETCH.paperAlt,
          }}>
            <span style={{ fontSize: 24 }}>≡</span>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1.5, fontWeight: 700 }}>
              HISTORY
            </div>
          </SBox>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// V2 — FULL-BLEED TAP ANYWHERE
// The entire screen IS the button. Huge, unambiguous. State color
// fills the whole screen. Recent turn floats at top as a ticker.
// ═════════════════════════════════════════════════════════════
function V2_FullBleed({ state = 'idle' }) {
  const bg = state === 'recording' ? SKETCH.accent
          : state === 'ai'        ? SKETCH.ai
          : state === 'thinking'  ? '#d4a72c'
          : SKETCH.paper;
  const isColored = state !== 'idle';
  const fg = isColored ? '#fff' : SKETCH.ink;

  const bigLabel = state === 'recording' ? 'LISTENING'
                 : state === 'ai'        ? 'SPEAKING'
                 : state === 'thinking'  ? 'THINKING'
                 : 'TAP ANYWHERE\nTO TALK';

  const turn = state === 'recording'
    ? '"...and I think Friday works better because—"'
    : state === 'ai'
    ? '"Sure — moved Friday\'s standup to 10am. Anything else before you drive?"'
    : state === 'thinking'
    ? '(processing your request)'
    : '"Last: Got it, calendar updated."';

  return (
    <PaperPhone>
      <PhoneScreen bg={bg} style={{ padding: '8px 16px 16px', transition: 'background 0.3s' }}>
        {/* top ticker */}
        <div style={{
          paddingTop: 6, paddingBottom: 10,
          borderBottom: `1px dashed ${fg}44`,
        }}>
          <div style={{
            fontFamily: SKETCH.mono, fontSize: 10, letterSpacing: 1.4,
            color: fg, opacity: 0.65, marginBottom: 4,
          }}>
            WALKYTALKAI · {state === 'ai' ? 'NOW' : state === 'recording' ? 'YOU' : 'LAST'}
          </div>
          <div style={{
            fontFamily: SKETCH.body, fontSize: 15, lineHeight: 1.3,
            color: fg, fontStyle: state === 'thinking' ? 'italic' : 'normal',
            opacity: state === 'thinking' ? 0.8 : 1,
          }}>{turn}</div>
        </div>

        {/* Giant centered state */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        }}>
          {/* animated ring / orb */}
          <div style={{ position: 'relative', marginBottom: 28 }}>
            <SCircle size={140} thick filled={isColored ? 'rgba(255,255,255,0.12)' : SKETCH.paperAlt}
              style={{ borderColor: fg }}>
              <div style={{ fontSize: 64, color: fg, lineHeight: 1 }}>
                {state === 'recording' ? '🎙' : state === 'ai' ? '🔊' : state === 'thinking' ? '◐' : '●'}
              </div>
            </SCircle>
            {state === 'recording' && (
              <>
                <div style={{
                  position: 'absolute', inset: -20, borderRadius: '50%',
                  border: `2px solid ${fg}`, opacity: 0.4, animation: 'sketchring 1.4s ease-out infinite',
                }} />
                <div style={{
                  position: 'absolute', inset: -40, borderRadius: '50%',
                  border: `2px solid ${fg}`, opacity: 0.2, animation: 'sketchring 1.4s ease-out infinite 0.5s',
                }} />
              </>
            )}
          </div>
          <div style={{
            fontFamily: SKETCH.hand, fontSize: 30, fontWeight: 700,
            color: fg, lineHeight: 1.1, whiteSpace: 'pre-line',
          }}>{bigLabel}</div>
          <div style={{
            fontFamily: SKETCH.mono, fontSize: 10, letterSpacing: 1.5,
            color: fg, opacity: 0.7, marginTop: 14,
          }}>
            {state === 'idle' ? 'TAP AGAIN TO STOP' : state === 'ai' ? 'TAP TO INTERRUPT' : state === 'recording' ? 'TAP TO STOP' : ''}
          </div>
        </div>

        {/* corner hints */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontFamily: SKETCH.mono, fontSize: 10, color: fg, opacity: 0.65, letterSpacing: 1,
        }}>
          <span>↺ REPLAY</span>
          <span>≡</span>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// V3 — ORB + CAPTION (Siri-like)
// Animated orb dominates center. Live caption streams beneath.
// Button is a clear tap-target at bottom but orb IS the state.
// ═════════════════════════════════════════════════════════════
function V3_OrbCaption({ state = 'idle' }) {
  const orbFill = state === 'recording' ? `radial-gradient(circle at 30% 30%, ${SKETCH.accent}, #7a1a0a)`
                : state === 'ai'        ? `radial-gradient(circle at 30% 30%, #4a8db0, ${SKETCH.ai})`
                : state === 'thinking'  ? `radial-gradient(circle at 30% 30%, #e8c95a, #9a7615)`
                : `radial-gradient(circle at 30% 30%, #e8e4d6, #a8a497)`;

  const caption = state === 'recording'
    ? '"Add to my list: pick up dry cleaning Thursday after the meeting with—"'
    : state === 'ai'
    ? '"Added 3 items: dry cleaning Thursday, call mom this weekend, and milk. Want me to read the full list back?"'
    : state === 'thinking'
    ? '...'
    : 'Start a conversation.';

  const captionLabel = state === 'recording' ? 'YOU · LIVE'
                     : state === 'ai'        ? 'AI · SPEAKING'
                     : state === 'thinking'  ? 'THINKING'
                     : 'IDLE';

  return (
    <PaperPhone>
      <PhoneScreen>
        {/* tight header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
          <div style={{ fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1.5, color: SKETCH.muted }}>
            SESSION · 14 MIN
          </div>
          <div style={{ fontFamily: SKETCH.mono, fontSize: 11, color: SKETCH.muted }}>≡</div>
        </div>

        {/* ORB */}
        <div style={{
          marginTop: 32, display: 'flex', justifyContent: 'center', alignItems: 'center',
          height: 220, position: 'relative',
        }}>
          <div style={{
            width: 180, height: 180, borderRadius: '50%',
            background: orbFill,
            border: `2px solid ${SKETCH.ink}`,
            boxShadow: state === 'recording' ? `0 0 40px ${SKETCH.accent}66`
                     : state === 'ai'        ? `0 0 40px ${SKETCH.ai}66`
                     : '3px 4px 0 rgba(0,0,0,0.1)',
            animation: state !== 'idle' ? 'sketchbreathe 2.4s ease-in-out infinite' : 'none',
            transition: 'all 0.3s',
          }} />
          {/* sketchy hand-drawn extra ring */}
          <div style={{
            position: 'absolute', width: 210, height: 210,
            borderRadius: '50%', border: `1.5px dashed ${SKETCH.ink}`,
            opacity: 0.3,
          }} />
        </div>

        {/* caption */}
        <div style={{ marginTop: 24, padding: '0 4px' }}>
          <div style={{
            fontFamily: SKETCH.mono, fontSize: 10, letterSpacing: 1.5,
            color: state === 'recording' ? SKETCH.accent : state === 'ai' ? SKETCH.ai : SKETCH.muted,
            marginBottom: 10, fontWeight: 700,
          }}>· {captionLabel} ·</div>
          <div style={{
            fontFamily: SKETCH.body, fontSize: 18, lineHeight: 1.4,
            color: SKETCH.ink, minHeight: 90,
          }}>{caption}</div>
        </div>

        <div style={{ flex: 1 }} />

        {/* small button row at bottom */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, paddingBottom: 4,
        }}>
          <SCircle size={54} style={{ fontFamily: SKETCH.mono, fontSize: 16 }}>
            <span style={{ fontSize: 20 }}>↺</span>
          </SCircle>
          <SCircle size={96} thick filled={state === 'recording' ? SKETCH.accent : SKETCH.ink}>
            <div style={{ color: '#fff', textAlign: 'center' }}>
              <div style={{ fontSize: 28 }}>{state === 'recording' ? '■' : '●'}</div>
              <div style={{ fontFamily: SKETCH.mono, fontSize: 8, letterSpacing: 1.5 }}>
                {state === 'recording' ? 'STOP' : 'TALK'}
              </div>
            </div>
          </SCircle>
          <SCircle size={54} style={{ fontFamily: SKETCH.mono, fontSize: 16 }}>
            <span style={{ fontSize: 18 }}>≡</span>
          </SCircle>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

Object.assign(window, { V1_BigButton, V2_FullBleed, V3_OrbCaption });
