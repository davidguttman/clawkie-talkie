// hifi-driving.jsx — the main driving-mode screen + state machine

const STATE = { IDLE: 'idle', REC: 'recording', THINK: 'thinking', AI: 'ai' };

function useDrivingState({ accent, micMode, onTurn }) {
  // turns: {who, text, final}[]
  const [turns, setTurns] = React.useState([]);
  const [state, setState] = React.useState(STATE.IDLE);
  const [liveText, setLiveText] = React.useState('');
  const [intensities, setIntensities] = React.useState(() => Array(28).fill(0.12));
  const [turnIdx, setTurnIdx] = React.useState(0);   // index into HIFI_SCRIPT
  const streamRef = React.useRef(null);
  const ttsRef = React.useRef(null);

  // Waveform animation — driven by RAF while active
  React.useEffect(() => {
    if (state === STATE.IDLE) { setIntensities(Array(28).fill(0.12)); return; }
    let raf;
    const tick = (t) => {
      const next = Array.from({ length: 28 }, (_, i) => {
        const base = state === STATE.THINK ? 0.2 : 0.55;
        const variance = state === STATE.THINK ? 0.05 : 0.4;
        const v = base + Math.sin(t / 120 + i * 0.8) * variance + Math.sin(t / 80 + i * 1.7) * variance * 0.5;
        return Math.max(0.08, Math.min(1, Math.abs(v)));
      });
      setIntensities(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const clearStream = () => { if (streamRef.current) { streamRef.current(); streamRef.current = null; } };
  const clearTTS = () => { try { window.speechSynthesis.cancel(); } catch(e){} ttsRef.current = null; };

  // MAIN tap action
  const tap = React.useCallback(() => {
    // IDLE -> RECORDING: start streaming the next user utterance
    if (state === STATE.IDLE) {
      const next = HIFI_SCRIPT[turnIdx];
      if (!next || next.who !== 'user') return;
      setState(STATE.REC);
      setLiveText('');
      // stream the pre-scripted user text as if live mic output
      streamRef.current = window.streamText(next.text, (partial) => {
        setLiveText(partial);
      }, () => {
        // user keeps talking until they tap stop — leave it at full text
        streamRef.current = null;
      }, 42);
    }
    // RECORDING -> THINKING -> AI
    else if (state === STATE.REC) {
      clearStream();
      const text = liveText || HIFI_SCRIPT[turnIdx]?.text || '';
      setTurns(prev => [...prev, { who: 'user', text, final: true }]);
      onTurn && onTurn({ who: 'user', text });
      setLiveText('');
      setState(STATE.THINK);
      setTimeout(() => {
        const ai = HIFI_SCRIPT[turnIdx + 1];
        if (!ai || ai.who !== 'ai') { setState(STATE.IDLE); return; }
        setState(STATE.AI);
        // stream caption + speak
        streamRef.current = window.streamText(ai.text, (partial) => {
          setLiveText(partial);
        }, () => {
          streamRef.current = null;
        }, 35);
        // TTS
        try {
          const u = new SpeechSynthesisUtterance(ai.text);
          u.rate = 1.05; u.pitch = 1; u.volume = 1;
          // prefer a pleasant voice if available
          const voices = window.speechSynthesis.getVoices();
          const preferred = voices.find(v => /samantha|serena|google us english|alex/i.test(v.name));
          if (preferred) u.voice = preferred;
          u.onend = () => {
            // finalize AI turn and go idle, advance script
            setTurns(prev => [...prev, { who: 'ai', text: ai.text, final: true }]);
            onTurn && onTurn({ who: 'ai', text: ai.text });
            setLiveText('');
            setTurnIdx(i => i + 2);
            setState(STATE.IDLE);
            clearStream();
          };
          ttsRef.current = u;
          window.speechSynthesis.speak(u);
        } catch(e) {
          // fallback: finish on a timer proportional to text length
          setTimeout(() => {
            setTurns(prev => [...prev, { who: 'ai', text: ai.text, final: true }]);
            setLiveText('');
            setTurnIdx(i => i + 2);
            setState(STATE.IDLE);
            clearStream();
          }, Math.min(12000, ai.text.length * 50));
        }
      }, 900);
    }
    // AI SPEAKING -> interrupt
    else if (state === STATE.AI) {
      clearTTS();
      clearStream();
      // save partial AI turn
      if (liveText) {
        setTurns(prev => [...prev, { who: 'ai', text: liveText + '…', final: false }]);
      }
      setLiveText('');
      setTurnIdx(i => i + 2);
      setState(STATE.IDLE);
    }
  }, [state, turnIdx, liveText, onTurn]);

  const reset = React.useCallback(() => {
    clearStream(); clearTTS();
    setTurns([]); setLiveText(''); setTurnIdx(0); setState(STATE.IDLE);
  }, []);

  return { state, setState, liveText, setLiveText, turns, intensities, tap, reset, turnIdx };
}

// ─────────────────────────────────────────────────────────
// The hi-fi driving screen (V1 layout, hi-fi visuals)
// ─────────────────────────────────────────────────────────
function DrivingScreen({ accent, fontMode, onStateChange, onReplay, onHistory }) {
  const accentCfg = HIFI.accents[accent] || HIFI.accents.amber;
  const { state, liveText, turns, intensities, tap } = useDrivingState({ accent });

  React.useEffect(() => { onStateChange && onStateChange(state); }, [state, onStateChange]);

  const isRec = state === STATE.REC;
  const isAI = state === STATE.AI;
  const isThink = state === STATE.THINK;
  const isIdle = state === STATE.IDLE;

  const stateColor =
    isRec ? accentCfg.rec :
    isAI  ? HIFI.ai :
    isThink ? HIFI.think : HIFI.ink3;
  const stateGlow =
    isRec ? accentCfg.recGlow :
    isAI  ? HIFI.aiGlow :
    isThink ? HIFI.thinkGlow : 'transparent';

  // caption content: live for recording/ai, last-turn for idle
  const lastTurn = turns[turns.length - 1];
  const caption =
    isRec ? { who: 'YOU · LIVE', color: accentCfg.rec, text: liveText || 'Listening…', live: true } :
    isAI  ? { who: 'AI · READING ALOUD', color: HIFI.ai, text: liveText || '…', live: true } :
    isThink ? { who: 'THINKING', color: HIFI.think, text: '…', live: false } :
    lastTurn ? { who: lastTurn.who === 'user' ? 'YOU · LAST' : 'AI · LAST', color: HIFI.ink3, text: lastTurn.text, live: false }
             : { who: 'READY', color: HIFI.ink3, text: 'Tap to continue the conversation.', live: false };

  const btnLabel =
    isRec ? 'TAP TO STOP' :
    isAI  ? 'TAP TO SILENCE' :
    isThink ? 'THINKING' : 'TAP TO TALK';

  const statePill =
    isRec ? 'REC' :
    isAI  ? 'READING REPLY' :
    isThink ? 'THINKING' : 'READY';

  const baseFont = fontMode === 'sans' ? HIFI.fonts.sans : HIFI.fonts.mono;

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      padding: '8px 22px 16px', color: HIFI.ink,
      fontFamily: baseFont,
    }}>
      {/* header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        paddingTop: 4, paddingBottom: 2,
      }}>
        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 13, fontWeight: 600,
          letterSpacing: 1.5, color: HIFI.ink2,
        }}>CLWK · f3c1 · discord</div>
        <div style={{
          display: 'inline-flex', gap: 6, alignItems: 'center',
          padding: '3px 10px', borderRadius: 20,
          border: `1px solid ${stateColor}55`,
          background: `${stateColor}11`,
          fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 700,
          letterSpacing: 1.4, color: stateColor,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: stateColor,
            animation: (isRec || isAI || isThink) ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
            boxShadow: `0 0 8px ${stateColor}`,
          }} />
          {statePill}
        </div>
      </div>

      {/* caption — scrollable, auto-stuck to bottom while live */}
      <LiveCaption caption={caption} baseFont={baseFont} />

      {/* waveform */}
      <div style={{
        padding: '16px 0 4px',
        display: 'flex', justifyContent: 'center',
      }}>
        <LiveWave intensities={intensities} color={stateColor} width={280} height={34} />
      </div>

      {/* BIG BUTTON */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        <PTTButton
          tap={tap}
          disabled={isThink}
          isIdle={isIdle}
          isRec={isRec}
          isAI={isAI}
          isThink={isThink}
          stateColor={stateColor}
          stateGlow={stateGlow}
          btnLabel={btnLabel}
        />
      </div>

      {/* Replay + History */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10,
      }}>
        <FooterButton icon="↺" label="REPLAY" onClick={onReplay} />
        <FooterButton icon="≡" label="HISTORY" onClick={onHistory} />
      </div>
    </div>
  );
}

// Big push-to-talk button with tactile press-in animation + haptic
function PTTButton({ tap, disabled, isIdle, isRec, isAI, isThink, stateColor, stateGlow, btnLabel }) {
  const [pressed, setPressed] = React.useState(false);
  const [ripple, setRipple] = React.useState(0);

  const doTap = () => {
    if (disabled) return;
    // haptic (mobile only; silently no-ops on desktop)
    try { navigator.vibrate && navigator.vibrate(18); } catch(e){}
    setRipple(r => r + 1);
    tap();
  };

  const onDown = () => { if (!disabled) setPressed(true); };
  const onUp   = () => setPressed(false);

  const pressScale = pressed ? 0.94 : isRec ? 1.02 : 1;

  return (
    <button
      onClick={doTap}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      disabled={disabled}
      style={{
        position: 'relative',
        width: 208, height: 208, borderRadius: '50%',
        border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: isIdle
          ? `radial-gradient(circle at 30% 28%, ${pressed ? '#2a2a2e' : '#1a1a1d'} 0%, #0a0a0b 100%)`
          : `radial-gradient(circle at 30% 28%, ${stateColor} 0%, ${stateColor}88 100%)`,
        boxShadow: isIdle
          ? `0 0 0 1px ${HIFI.strokeStrong}, inset 0 1px 0 rgba(255,255,255,0.06), 0 ${pressed ? 8 : 18}px ${pressed ? 20 : 40}px rgba(0,0,0,0.6)`
          : `0 0 0 1px ${stateColor}66, 0 0 ${pressed ? 60 : 44}px ${stateGlow}, inset 0 1px 0 rgba(255,255,255,0.15)`,
        color: isIdle ? HIFI.ink : '#000',
        fontFamily: HIFI.fonts.mono,
        transform: `scale(${pressScale})`,
        transition: pressed
          ? 'transform 60ms cubic-bezier(0.4,0,1,1), box-shadow 60ms'
          : 'transform 240ms cubic-bezier(0.2,1.4,0.4,1), box-shadow 240ms, background 300ms',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}>
      <ButtonAura active={isRec || isAI} color={stateColor} />

      {/* ripple on tap */}
      <RippleFX key={ripple} color={isIdle ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} />

      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center' }}>
        <div style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>
          {isRec ? '■' : isAI ? '◉' : isThink ? '◐' : '●'}
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.8, marginTop: 12 }}>
          {btnLabel}
        </div>
      </div>
    </button>
  );
}

function RippleFX({ color }) {
  // mounts once per key change → runs a single animation
  return (
    <span style={{
      position: 'absolute', inset: 0, borderRadius: '50%',
      pointerEvents: 'none',
      animation: 'rippleOut 540ms ease-out forwards',
      background: `radial-gradient(circle, ${color} 0%, transparent 62%)`,
    }} />
  );
}

// LiveCaption — fixed-height scrolling caption that auto-pins to bottom
// while live. Word count badge for long turns. Fade mask on top edge
// (only when there's content scrolled off-top).
function LiveCaption({ caption, baseFont }) {
  const bodyRef = React.useRef(null);
  const [userScrolled, setUserScrolled] = React.useState(false);
  const [scrolledDown, setScrolledDown] = React.useState(false);

  // Reset on turn change
  React.useEffect(() => {
    setUserScrolled(false);
    setScrolledDown(false);
  }, [caption.who]);

  // Auto-scroll to bottom while live unless user scrolled up
  React.useEffect(() => {
    if (!caption.live || userScrolled) return;
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setScrolledDown(el.scrollTop > 2);
    }
  }, [caption.text, caption.live, userScrolled]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setUserScrolled(!atBottom);
    setScrolledDown(el.scrollTop > 2);
  };

  // word count for long turns (only show when meaningful)
  const wc = caption.text && caption.live
    ? caption.text.trim().split(/\s+/).filter(Boolean).length
    : 0;
  const showWc = caption.live && wc > 25;

  return (
    <div style={{
      marginTop: 14, height: 188,
      borderBottom: `1px solid ${HIFI.stroke}`, paddingBottom: 12,
      display: 'flex', flexDirection: 'column',
      position: 'relative',
    }}>
      <div style={{
        fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 700,
        letterSpacing: 1.6, color: caption.color, marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {caption.live && <span style={{
          width: 6, height: 6, borderRadius: '50%', background: caption.color,
          animation: 'pulseDot 1.2s ease-in-out infinite',
          boxShadow: `0 0 6px ${caption.color}`,
        }} />}
        <span style={{ flex: 1 }}>{caption.who}</span>
        {showWc && (
          <span style={{
            color: HIFI.ink3, fontSize: 9, letterSpacing: 1.2, fontWeight: 500,
          }}>{wc}w</span>
        )}
      </div>
      <div style={{
        position: 'relative', flex: 1, minHeight: 0,
      }}>
        {/* top fade mask — only when there's content scrolled past top */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 24,
          background: `linear-gradient(to bottom, ${HIFI.bg}, transparent)`,
          pointerEvents: 'none', zIndex: 2,
          opacity: scrolledDown ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }} />
        <div
          ref={bodyRef}
          onScroll={onScroll}
          style={{
            height: '100%', overflowY: 'auto',
            fontSize: 16, lineHeight: 1.5, color: HIFI.ink,
            fontWeight: 400, fontFamily: baseFont,
            paddingRight: 4, scrollbarWidth: 'thin',
          }}>
          {caption.text}
          {caption.live && (
            <span style={{
              display: 'inline-block', width: 8, height: 16,
              background: caption.color, marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'caret 0.9s step-end infinite',
            }} />
          )}
        </div>
        {/* "jump to live" pill when user scrolled up */}
        {userScrolled && caption.live && (
          <button
            onClick={() => {
              const el = bodyRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setUserScrolled(false);
            }}
            style={{
              position: 'absolute', bottom: 6, left: '50%',
              transform: 'translateX(-50%)',
              padding: '4px 10px', borderRadius: 20,
              background: caption.color, color: '#000',
              border: 'none', cursor: 'pointer',
              fontFamily: HIFI.fonts.mono, fontSize: 9, fontWeight: 700,
              letterSpacing: 1.2, zIndex: 3,
              boxShadow: `0 0 14px ${caption.color}66`,
            }}>↓ JUMP TO LIVE</button>
        )}
      </div>
    </div>
  );
}

function FooterButton({ icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      height: 64, borderRadius: 18,
      border: `1px solid ${HIFI.stroke}`,
      background: HIFI.surface,
      color: HIFI.ink, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 12, fontFamily: HIFI.fonts.mono, fontSize: 12, fontWeight: 700,
      letterSpacing: 1.6,
      transition: 'background 0.2s, border-color 0.2s',
    }}
    onMouseEnter={e => { e.currentTarget.style.background = HIFI.surface2; e.currentTarget.style.borderColor = HIFI.strokeStrong; }}
    onMouseLeave={e => { e.currentTarget.style.background = HIFI.surface; e.currentTarget.style.borderColor = HIFI.stroke; }}
    >
      <span style={{ fontSize: 22, fontFamily: HIFI.fonts.sans }}>{icon}</span>
      {label}
    </button>
  );
}

Object.assign(window, { DrivingScreen, useDrivingState, STATE });
