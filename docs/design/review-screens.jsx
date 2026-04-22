// Review screens — these are the "later, out of the car" UX
// History list / session detail / export / empty / settings

// ═════════════════════════════════════════════════════════════
// HISTORY LIST — all past conversations
// ═════════════════════════════════════════════════════════════
function HistoryList() {
  const sessions = [
    { date: 'TODAY', label: 'Monday drive', when: '8:14 AM', turns: 14, preview: 'Action items from the sync yesterday, Sam on Thursday…' },
    { date: 'TODAY', label: 'Grocery run', when: '6:42 PM', turns: 6, preview: 'Added to list: milk, bread, that cheese—' },
    { date: 'YESTERDAY', label: 'PRD brainstorm', when: '7:51 AM', turns: 38, preview: 'What if we treated the composer more like a doc editor…', starred: true },
    { date: 'YESTERDAY', label: 'Reminders', when: '5:13 PM', turns: 4, preview: 'Dry cleaning Thursday after work.' },
    { date: 'MAR 22', label: 'Draft to Priya', when: '8:20 AM', turns: 21, preview: 'Tone should be warm but direct — the contract piece matters.' },
    { date: 'MAR 22', label: 'Blog: AI in cars', when: '6:50 PM', turns: 45, preview: 'The real insight is that voice is the only modality that—', starred: true },
  ];

  let lastDate = null;
  return (
    <PaperPhone>
      <PhoneScreen>
        {/* header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          paddingTop: 4, paddingBottom: 14,
        }}>
          <div>
            <div style={{ fontFamily: SKETCH.hand, fontSize: 26, fontWeight: 700, lineHeight: 1 }}>History</div>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted, letterSpacing: 1, marginTop: 4 }}>
              48 SESSIONS · 14H TOTAL
            </div>
          </div>
          <SCircle size={40}><span style={{ fontSize: 18 }}>⚙</span></SCircle>
        </div>

        {/* search */}
        <SBox rounded={14} style={{
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
          background: SKETCH.paperAlt, marginBottom: 10,
        }}>
          <span style={{ fontSize: 14 }}>🔍</span>
          <span style={{ fontFamily: SKETCH.body, fontSize: 13, color: SKETCH.muted }}>
            Search transcripts…
          </span>
        </SBox>

        {/* list */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sessions.map((s, i) => {
            const showDate = s.date !== lastDate;
            lastDate = s.date;
            return (
              <React.Fragment key={i}>
                {showDate && (
                  <div style={{
                    fontFamily: SKETCH.mono, fontSize: 9, letterSpacing: 1.4,
                    color: SKETCH.muted, fontWeight: 700,
                    padding: '8px 2px 4px', marginTop: i === 0 ? 0 : 4,
                  }}>· {s.date} ·</div>
                )}
                <SBox rounded={12} style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                    <div style={{ fontFamily: SKETCH.body, fontSize: 14, fontWeight: 700 }}>
                      {s.starred && <span style={{ color: '#d4a72c' }}>★ </span>}
                      {s.label}
                    </div>
                    <div style={{ fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted, letterSpacing: 0.5 }}>
                      {s.when} · {s.turns}
                    </div>
                  </div>
                  <div style={{
                    fontFamily: SKETCH.body, fontSize: 12, color: SKETCH.muted,
                    lineHeight: 1.35, overflow: 'hidden',
                    display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
                  }}>{s.preview}</div>
                </SBox>
              </React.Fragment>
            );
          })}
        </div>

        <div style={{
          marginTop: 8, display: 'flex', justifyContent: 'space-around',
          paddingTop: 10, borderTop: `1px dashed ${SKETCH.faint}`,
          fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted, letterSpacing: 1,
        }}>
          <span>● TALK</span>
          <span style={{ color: SKETCH.ink, fontWeight: 700 }}>≡ HISTORY</span>
          <span>⚙ SETTINGS</span>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// TRANSCRIPT DETAIL — clean read view, built for export/repurposing
// ═════════════════════════════════════════════════════════════
function TranscriptDetail() {
  const turns = [
    { who: 'you', text: 'I want to draft a blog post on what it\'s actually like using AI assistants while driving. Start brainstorming angles.' },
    { who: 'ai', text: 'Three angles: (1) the hands-free productivity myth — most assistants still want your eyes. (2) voice-as-thinking: how speaking out loud changes what you say. (3) the commute as a creative cell. Which pulls you?' },
    { who: 'you', text: 'Two. That\'s the most interesting one. Let\'s go there.' },
    { who: 'ai', text: 'Okay. Core claim could be: driving is the rare place where you\'re forced to think in sentences, which is why ideas come out whole. Counterweight: transcripts are messy. You need a tool that treats voice as a source, not a final product.' },
    { who: 'you', text: 'Yes. That\'s actually the hook. Save that.' },
  ];

  return (
    <PaperPhone>
      <PhoneScreen style={{ padding: '8px 16px 14px' }}>
        {/* header with back + actions */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 6,
        }}>
          <span style={{ fontFamily: SKETCH.mono, fontSize: 18 }}>‹</span>
          <div style={{ flex: 1, fontFamily: SKETCH.hand, fontSize: 18, fontWeight: 700 }}>
            Blog: AI in cars
          </div>
          <span style={{ fontSize: 14, color: '#d4a72c' }}>★</span>
          <span style={{ fontFamily: SKETCH.mono, fontSize: 16 }}>⋯</span>
        </div>
        <div style={{
          fontFamily: SKETCH.mono, fontSize: 9, letterSpacing: 1.2,
          color: SKETCH.muted, marginBottom: 10, paddingLeft: 26,
        }}>
          MAR 22 · 6:50 PM · 45 TURNS · 12:04
        </div>

        {/* action row — export options */}
        <div style={{
          display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap',
        }}>
          {['Copy', 'Share', 'Export MD'].map(a => (
            <SBox key={a} rounded={16} style={{
              padding: '4px 10px', fontFamily: SKETCH.mono, fontSize: 10,
              letterSpacing: 0.8, fontWeight: 600,
            }}>{a}</SBox>
          ))}
        </div>

        {/* transcript turns */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {turns.map((t, i) => (
            <div key={i}>
              <div style={{
                fontFamily: SKETCH.mono, fontSize: 9, letterSpacing: 1.4,
                color: t.who === 'you' ? SKETCH.accent : SKETCH.ai,
                fontWeight: 700, marginBottom: 4,
              }}>{t.who === 'you' ? 'YOU' : 'AI'}</div>
              <div style={{
                fontFamily: SKETCH.body, fontSize: 14, lineHeight: 1.5,
                color: SKETCH.ink,
                paddingLeft: t.who === 'ai' ? 14 : 0,
                borderLeft: t.who === 'ai' ? `2px solid ${SKETCH.ai}` : 'none',
              }}>{t.text}</div>
            </div>
          ))}
          <div style={{
            fontFamily: SKETCH.note, fontSize: 15, color: SKETCH.muted,
            textAlign: 'center', padding: '6px 0',
          }}>… 40 more turns …</div>
        </div>

        {/* continue bar */}
        <div style={{ marginTop: 10 }}>
          <SBox rounded={24} thick style={{
            padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10,
            background: SKETCH.paperAlt,
          }}>
            <SCircle size={36} filled={SKETCH.ink}>
              <span style={{ color: '#fff', fontSize: 14 }}>●</span>
            </SCircle>
            <div style={{ fontFamily: SKETCH.body, fontSize: 13, fontWeight: 500 }}>
              Continue this conversation
            </div>
          </SBox>
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// EMPTY / FIRST USE
// ═════════════════════════════════════════════════════════════
function EmptyState() {
  return (
    <PaperPhone>
      <PhoneScreen style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{
          fontFamily: SKETCH.hand, fontSize: 42, fontWeight: 700,
          lineHeight: 1, marginBottom: 6,
        }}>WalkyTalkAI</div>
        <div style={{
          fontFamily: SKETCH.note, fontSize: 19, color: SKETCH.muted,
          marginBottom: 38, padding: '0 20px', lineHeight: 1.3,
        }}>a walky-talky for your<br/>brain, in the car</div>

        <SCircle size={180} thick filled={SKETCH.paperAlt} style={{ marginBottom: 20 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 58 }}>●</div>
            <div style={{ fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1.6, fontWeight: 700, marginTop: 6 }}>
              TAP TO TALK
            </div>
          </div>
        </SCircle>

        <div style={{
          fontFamily: SKETCH.body, fontSize: 13, color: SKETCH.muted,
          marginTop: 10, padding: '0 24px', lineHeight: 1.5,
        }}>
          Tap once to start recording.<br/>
          Tap again when you\'re done.<br/>
          I\'ll reply out loud — and save<br/>everything as text for later.
        </div>

        <div style={{
          marginTop: 32, padding: '10px 18px', borderRadius: 24,
          background: SKETCH.paperAlt, border: `1.5px solid ${SKETCH.ink}`,
          fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1, fontWeight: 600,
        }}>MIC PERMISSION → CARPLAY → GO</div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════
function Settings() {
  const groups = [
    { h: 'VOICE', items: [
      { k: 'AI voice', v: 'Warm · f' },
      { k: 'Speaking speed', v: '1.1×' },
      { k: 'Auto-read replies', v: 'On' },
    ]},
    { h: 'DRIVING', items: [
      { k: 'CarPlay mode', v: 'Auto' },
      { k: 'Silence threshold', v: '1.2s' },
      { k: 'Haptic confirm on tap', v: 'On' },
    ]},
    { h: 'TRANSCRIPT', items: [
      { k: 'Clean up filler words', v: 'On' },
      { k: 'Auto-title sessions', v: 'On' },
      { k: 'Export format', v: 'Markdown' },
    ]},
    { h: 'DATA', items: [
      { k: 'Sync', v: 'iCloud' },
      { k: 'Delete after', v: '—' },
    ]},
  ];
  return (
    <PaperPhone>
      <PhoneScreen>
        <div style={{ paddingTop: 4, paddingBottom: 10 }}>
          <div style={{ fontFamily: SKETCH.hand, fontSize: 26, fontWeight: 700 }}>Settings</div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map(g => (
            <div key={g.h}>
              <div style={{
                fontFamily: SKETCH.mono, fontSize: 9, letterSpacing: 1.4,
                color: SKETCH.muted, fontWeight: 700, paddingLeft: 4, marginBottom: 6,
              }}>· {g.h} ·</div>
              <SBox rounded={14} filled={SKETCH.paper} style={{ overflow: 'hidden' }}>
                {g.items.map((it, i) => (
                  <div key={it.k} style={{
                    padding: '11px 14px',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    borderBottom: i === g.items.length - 1 ? 'none' : `1px dashed ${SKETCH.faint}`,
                    fontFamily: SKETCH.body, fontSize: 13,
                  }}>
                    <span>{it.k}</span>
                    <span style={{ color: SKETCH.muted, fontSize: 12 }}>{it.v} ›</span>
                  </div>
                ))}
              </SBox>
            </div>
          ))}
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

// ═════════════════════════════════════════════════════════════
// HANDOFF LANDING — opened via URL with session ID
// User was chatting with an agent (Discord etc.), agent handed off
// a link like walkytalk.ai/s/A7F3-K9P2 → this screen confirms and
// drops into driving mode.
// ═════════════════════════════════════════════════════════════
function HandoffLanding({ state = 'loading' }) {
  // state: 'loading' | 'ready' (shown as two stacked mocks)
  return (
    <PaperPhone>
      <PhoneScreen style={{ padding: '12px 18px 16px' }}>
        {/* fake browser-ish chrome showing the URL */}
        <SBox rounded={10} filled={SKETCH.paperAlt} style={{
          padding: '6px 10px', marginTop: 2, marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted,
        }}>
          <span>🔒</span>
          <span style={{ color: SKETCH.ink }}>walkytalk.ai</span>
          <span>/s/</span>
          <span style={{ color: SKETCH.accent, fontWeight: 700 }}>A7F3-K9P2</span>
        </SBox>

        {/* logo */}
        <div style={{
          fontFamily: SKETCH.hand, fontSize: 30, fontWeight: 700,
          lineHeight: 1, textAlign: 'center', marginTop: 8,
        }}>WalkyTalkAI</div>

        {/* handoff card */}
        <div style={{ marginTop: 30 }}>
          <SBox rounded={18} thick filled={SKETCH.paper} style={{ padding: '18px 16px' }}>
            <div style={{
              fontFamily: SKETCH.mono, fontSize: 10, letterSpacing: 1.4,
              color: SKETCH.muted, fontWeight: 700, marginBottom: 10,
            }}>· HANDOFF FROM AGENT ·</div>

            {/* source agent */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <SCircle size={36} filled="#5865F2"><span style={{ fontSize: 14, color: '#fff' }}>◈</span></SCircle>
              <div>
                <div style={{ fontFamily: SKETCH.body, fontSize: 13, fontWeight: 700 }}>
                  PRD Brainstorm Agent
                </div>
                <div style={{ fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted, letterSpacing: 0.5 }}>
                  Discord · 9 msgs · 4 min ago
                </div>
              </div>
            </div>

            {/* context preview */}
            <div style={{
              padding: '10px 12px', borderRadius: 10,
              background: SKETCH.paperAlt, border: `1px dashed ${SKETCH.faint}`,
              fontFamily: SKETCH.body, fontSize: 12, lineHeight: 1.4,
              color: SKETCH.muted, fontStyle: 'italic',
            }}>
              "…ok, let's switch to voice. Opening WalkyTalkAI with our context — just tap the button when you're ready."
            </div>

            {/* session meta */}
            <div style={{
              marginTop: 14, display: 'flex', justifyContent: 'space-between',
              fontFamily: SKETCH.mono, fontSize: 10, color: SKETCH.muted, letterSpacing: 0.8,
            }}>
              <span>SESSION <b style={{ color: SKETCH.ink }}>A7F3-K9P2</b></span>
              <span>{state === 'loading' ? 'LOADING CONTEXT…' : 'READY'}</span>
            </div>
          </SBox>
        </div>

        <div style={{ flex: 1 }} />

        {/* CTA — big tap-to-continue */}
        <SCircle size={180} thick filled={state === 'loading' ? SKETCH.paperAlt : SKETCH.ink}
          style={{ alignSelf: 'center', marginBottom: 16, opacity: state === 'loading' ? 0.55 : 1 }}>
          <div style={{ textAlign: 'center', color: state === 'loading' ? SKETCH.muted : '#fff' }}>
            <div style={{ fontSize: 52 }}>{state === 'loading' ? '◐' : '●'}</div>
            <div style={{
              fontFamily: SKETCH.mono, fontSize: 11, letterSpacing: 1.5, fontWeight: 700, marginTop: 8,
            }}>
              {state === 'loading' ? 'LOADING' : 'TAP TO TALK'}
            </div>
          </div>
        </SCircle>

        <div style={{
          fontFamily: SKETCH.note, fontSize: 16, color: SKETCH.muted,
          textAlign: 'center', lineHeight: 1.3, padding: '0 10px',
        }}>
          {state === 'loading'
            ? 'Pulling in the conversation so far…'
            : 'Picking up where you left off. The agent already knows the context.'}
        </div>
      </PhoneScreen>
    </PaperPhone>
  );
}

Object.assign(window, { HistoryList, TranscriptDetail, EmptyState, Settings, HandoffLanding });
