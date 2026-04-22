// Variations 4-5 + review screens

// ═════════════════════════════════════════════════════════════
// V4 — CARPLAY-STYLE BIG TILE
// Oversized, high-contrast layout tuned for quick-glance driving.
// Big status tile + big button, minimal text. Text review lives
// on the phone separately. Optimized for phone mounted in car.
// ═════════════════════════════════════════════════════════════
function V4_CarPlay({ state = 'idle' }) {
  const stateColor = state === 'recording' ? SKETCH.accent
                   : state === 'ai'        ? SKETCH.ai
                   : state === 'thinking'  ? '#d4a72c'
                   : SKETCH.ink;
  const stateBg = state === 'recording' ? SKETCH.accentSoft
                : state === 'ai'        ? SKETCH.aiSoft
                : state === 'thinking'  ? '#f0ebd6'
                : '#eeeae0';
  const stateLabel = state === 'recording' ? 'LISTENING'
                   : state === 'ai'        ? 'SPEAKING'
                   : state === 'thinking'  ? 'THINKING'
                   : 'READY';

  return (
    <PaperPhone>
      <PhoneScreen style={{ padding: '8px 14px 14px' }}>
        {/* top — just title */}
        <div style={{
          fontFamily: SKETCH.hand, fontSize: 14, fontWeight: 700,
          letterSpacing: 0.5, paddingTop: 4, color: SKETCH.muted,
        }}>WalkyTalkAI · driving</div>

        {/* big state tile */}
        <div style={{ marginTop: 14 }}>
          <SBox rounded={20} thick filled={stateBg} style={{
            padding: '22px 18px', transition: 'background 0.3s',
          }}>
            <div style={{
              fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 2,
              color: stateColor, fontWeight: 700, marginBottom: 8,
            }}>· {stateLabel} ·</div>
            <div style={{
              fontFamily: SKETCH.body, fontSize: 22, fontWeight: 600,
              lineHeight: 1.25, color: SKETCH.ink, minHeight: 84,
            }}>
              {state === 'recording' ? '"...remind me to order the cake before Friday."'
               : state === 'ai'      ? '"Reminder set — Friday 9am, order cake."'
               : state === 'thinking' ? '...'
               : 'Tap the button to start'}
            </div>
            {state !== 'idle' && state !== 'thinking' && (
              <div style={{ marginTop: 12 }}>
                <Waveform width={260} height={28} bars={24}
                  state={state === 'recording' ? 'recording' : state === 'ai' ? 'ai' : 'idle'} />
              </div>
            )}
          </SBox>
        </div>

        {/* spacer */}
        <div style={{ flex: 1 }} />

        {/* oversized button grid — thumb zone */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1.6fr 1fr',
          gap: 10, marginBottom: 8,
        }}>
          <SBox rounded={20} thick style={{
            height: 120, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 6,
            background: SKETCH.paper,
          }}>
            <div style={{ fontSize: 28 }}>↺</div>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 9, letterSpacing: 1.5, fontWeight: 700 }}>
              REPLAY
            </div>
          </SBox>

          <SBox rounded={20} thick style={{
            height: 120, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 6,
            background: state === 'recording' ? SKETCH.accent : state === 'ai' ? SKETCH.ai : SKETCH.ink,
            color: '#fff', transition: 'background 0.3s',
          }}>
            <div style={{ fontSize: 44, lineHeight: 1 }}>
              {state === 'recording' ? '■' : state === 'ai' ? '◉' : '●'}
            </div>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1.5, fontWeight: 700 }}>
              {state === 'recording' ? 'STOP' : state === 'ai' ? 'INTERRUPT' : 'TALK'}
            </div>
          </SBox>

          <SBox rounded={20} thick style={{
            height: 120, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 6,
            background: SKETCH.paper,
          }}>
            <div style={{ fontSize: 28 }}>≡</div>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 9, letterSpacing: 1.5, fontWeight: 700 }}>
              LOG
            </div>
          </SBox>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// V5 — LIVE TRANSCRIPT ON TOP, BUTTON AT BOTTOM
// For users who want to glance at text mid-convo. Live transcript
// scrolls at top (last 2-3 turns), fixed button + status docked
// at bottom. Denser than V1-4 but text-forward.
// ═════════════════════════════════════════════════════════════
function V5_LiveTranscript({ state = 'idle' }) {
  const turns = [
    { who: 'you', text: 'What were the action items from the sync yesterday?', t: '2m' },
    { who: 'ai',  text: 'Three: draft the spec by Wed, share it with design, and schedule follow-up with Sam.', t: '2m' },
    { who: 'you', text: state === 'recording' ? '"Okay, actually can you move that spec deadline to—"' : 'Book Sam for Thursday please.', t: state === 'recording' ? 'now' : '1m' },
    ...(state === 'ai' || state === 'thinking'
      ? [{ who: 'ai', text: state === 'thinking' ? '…' : '"Thursday 2pm with Sam — sent invite. Anything else?"', t: 'now' }]
      : []),
  ];

  return (
    <PaperPhone>
      <PhoneScreen style={{ padding: '8px 16px 10px' }}>
        {/* header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          paddingTop: 4, paddingBottom: 10,
          borderBottom: `1px dashed ${SKETCH.faint}`,
        }}>
          <div style={{ fontFamily: SKETCH.hand, fontSize: 18, fontWeight: 700 }}>Monday drive</div>
          <div style={{ fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted, letterSpacing: 1 }}>
            14 TURNS · ↗
          </div>
        </div>

        {/* scrolling transcript */}
        <div style={{
          flex: 1, overflow: 'hidden', paddingTop: 10,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {turns.map((t, i) => {
            const isYou = t.who === 'you';
            const isLive = t.t === 'now';
            return (
              <div key={i} style={{
                alignSelf: isYou ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
              }}>
                <div style={{
                  fontFamily: SKETCH.mono, fontSize: 9, color: SKETCH.muted,
                  letterSpacing: 1.2, marginBottom: 3,
                  textAlign: isYou ? 'right' : 'left',
                }}>{isYou ? 'YOU' : 'AI'} · {t.t}</div>
                <SBox rounded={14}
                  thick={isLive}
                  filled={isYou
                    ? (isLive && state === 'recording' ? SKETCH.accentSoft : SKETCH.paperAlt)
                    : (isLive && state === 'ai' ? SKETCH.aiSoft : SKETCH.paper)}
                  style={{
                    padding: '10px 14px',
                    fontFamily: SKETCH.body, fontSize: 14, lineHeight: 1.35,
                    color: isLive
                      ? (state === 'recording' && isYou ? SKETCH.accent : state === 'ai' && !isYou ? SKETCH.ai : SKETCH.ink)
                      : SKETCH.ink,
                    borderColor: isLive && state === 'recording' && isYou ? SKETCH.accent
                               : isLive && state === 'ai' && !isYou ? SKETCH.ai
                               : SKETCH.ink,
                  }}>
                  {t.text}
                </SBox>
              </div>
            );
          })}
        </div>

        {/* bottom dock */}
        <div style={{
          marginTop: 10, paddingTop: 10,
          borderTop: `1.5px solid ${SKETCH.ink}`,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <SCircle size={44}><span style={{ fontSize: 16 }}>↺</span></SCircle>
            <div style={{ flex: 1 }}>
              <SBox rounded={28} thick filled={
                state === 'recording' ? SKETCH.accent
                : state === 'ai'      ? SKETCH.ai
                : SKETCH.ink
              } style={{
                height: 60, display: 'flex', alignItems: 'center',
                justifyContent: 'center', gap: 10, color: '#fff',
                transition: 'background 0.3s',
              }}>
                <div style={{ fontSize: 22 }}>{state === 'recording' ? '■' : state === 'ai' ? '◉' : '●'}</div>
                <div style={{ fontFamily: SKETCH.mono, fontSize: 12, letterSpacing: 1.5, fontWeight: 700 }}>
                  {state === 'recording' ? 'TAP TO STOP'
                   : state === 'ai'      ? 'TAP TO INTERRUPT'
                   : state === 'thinking' ? 'THINKING…'
                   : 'TAP TO TALK'}
                </div>
              </SBox>
            </div>
          </div>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

Object.assign(window, { V4_CarPlay, V5_LiveTranscript });
