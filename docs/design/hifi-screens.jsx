// hifi-screens.jsx — History, Transcript, Handoff, Settings screens
// All share the same phone-viewport chrome (22px side pad, dark OLED).

// --- mock data ---------------------------------------------------------------
// Each session has a handoff code, title, timestamp, duration, turn count,
// and a short preview line. Stable so it feels like a real product.

// Parse a session string. Handoff URL format:
//   ?session=agent:<agentName>:<app>:<channelId>[:<threadId>]
// The `app` (discord/whatsapp/slack/telegram) is OpenClaw's integration —
// per-user pretty constant, but some users bridge multiple.
// `channelId` is the parent channel/DM (stable, always present).
// `threadId` is optional and often just a unix timestamp from a Discord
// thread with no first message yet.
window.parseSession = function parseSession(raw) {
  const parts = raw.split(':');
  const out = {
    raw,
    agent:     parts[1] || 'main',
    app:       parts[2] || 'discord',
    channelId: parts[3] || null,
    threadId:  parts[4] || null,
  };
  return out;
};

// Session records. `id` is the canonical session string (what goes on the
// URL, url-encoded). Everything else is display.
// Most sessions are from one app — this user is 4/5 Discord, 1 WhatsApp.
window.HIFI_SESSIONS = [
  {
    id: 'agent:main:discord:1495266157463208138:1766284491',
    when: 'Today, 3:42pm',
    duration: '14:08',
    turns: 18,
    lastLine: "You can't backspace at seventy miles an hour, and it turns out that's a feature.",
    active: true,
    channelName: '#ai-writing',
    threadName: null,       // thread is a bare timestamp, no human name
  },
  {
    id: 'agent:main:discord:1487112330095788192',
    when: 'Yesterday, 8:12am',
    duration: '22:40',
    turns: 31,
    lastLine: "Try it with the team name moved to step three and see what happens.",
    channelName: '#product',
    threadName: 'onboarding v3 rethink',
  },
  {
    id: 'agent:main:discord:1491008377213210112',
    when: 'Mon, 9:04am',
    duration: '06:22',
    turns: 9,
    lastLine: "Three things this week: retention dip, Stripe migration, hiring.",
    channelName: '#standup',
    threadName: null,
  },
  {
    id: 'agent:main:whatsapp:15551234567@c.us',
    when: 'Sat, 11:15am',
    duration: '38:51',
    turns: 42,
    lastLine: "He walked in and the whole room stopped, which is exactly what he wanted.",
    channelName: 'Gym crew',   // whatsapp chat name
    threadName: null,
  },
  {
    id: 'agent:main:discord:1489113008224701001:1748293847',
    when: 'Thu, 7:02pm',
    duration: '11:44',
    turns: 14,
    lastLine: "I keep framing it as a work problem but it's really about my dad.",
    channelName: '#journal',
    threadName: null,
  },
];

// App presentation — icon color + letter badge + display name.
// "Source" in the model = which OpenClaw integration carries this session.
window.HIFI_APPS = {
  discord:  { name: 'Discord',  bg: '#5865F2', letter: 'D' },
  whatsapp: { name: 'WhatsApp', bg: '#25D366', letter: 'W' },
  slack:    { name: 'Slack',    bg: '#4A154B', letter: 'S' },
  telegram: { name: 'Telegram', bg: '#229ED9', letter: 'T' },
};
// Back-compat alias — keep HIFI_SOURCES working for anything that still uses it.
window.HIFI_SOURCES = window.HIFI_APPS;

// Expanded transcript for the active session (blog post drafting).
window.HIFI_FULL_TRANSCRIPT = [
  { who: 'user', text: "Okay, I'm in the car now, let me just keep rolling on the blog post — I want to draft the whole opening out loud and we'll fix it up later." },
  { who: 'ai', text: 'Perfect. Go.' },
  { who: 'user', text: "So the hook, the thing I keep coming back to, is that commuting is actually the only place where you're forced to think in full sentences." },
  { who: 'ai', text: 'Good frame. Why full sentences specifically?' },
  { who: 'user', text: "Because you can't edit. You can't re-open a tab, you can't go to the whiteboard. You just have to keep the thought going until it lands somewhere." },
  { who: 'ai', text: "Right — the interface falls away, so the only unit of thought available is the spoken sentence." },
  { who: 'user', text: "Exactly. What's the counterargument? Someone could say you think better at a desk with tools." },
  { who: 'ai', text: 'The counter is that tools create affordances for editing, not for thinking. At a desk you start shaping words before you have the idea. In the car you have to finish the thought because you can\'t backspace.' },
  { who: 'user', text: "That's the line. 'You can't backspace.' Save that, it's going in the piece." },
  { who: 'ai', text: 'Saved. Want me to draft the opening two paragraphs?' },
  { who: 'user', text: 'Yeah, go for it.' },
  { who: 'ai', text: "Here's a draft: The best ideas I've had this year came between exits 42 and 58 on the interstate, with nothing but my voice and a road. No whiteboards, no docs, no outline. Just the pressure of having to finish a sentence before the next merge. You can't backspace at seventy miles an hour, and it turns out that's a feature." },
];

// --- shared chrome -----------------------------------------------------------

function ScreenHeader({ title, right, onBack, subtitle }) {
  return (
    <div style={{
      padding: '8px 22px 10px', borderBottom: `1px solid ${HIFI.stroke}`,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      {onBack && (
        <button onClick={onBack} style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'transparent', border: `1px solid ${HIFI.stroke}`,
          color: HIFI.ink, cursor: 'pointer', fontSize: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: HIFI.fonts.mono,
        }}>‹</button>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 15, fontWeight: 600,
          letterSpacing: 0.5, color: HIFI.ink,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</div>
        {subtitle && (
          <div style={{
            fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 500,
            letterSpacing: 1.2, color: HIFI.ink3, marginTop: 2,
          }}>{subtitle}</div>
        )}
      </div>
      {right}
    </div>
  );
}

function ScrollBody({ children, pad = 22 }) {
  return (
    <div style={{
      flex: 1, overflowY: 'auto',
      padding: `12px ${pad}px 20px`,
    }}>
      {children}
    </div>
  );
}

// --- HISTORY -----------------------------------------------------------------

function HistoryScreen({ onOpen, onBack }) {
  const [query, setQuery] = React.useState('');
  const sessions = window.HIFI_SESSIONS;
  const filtered = sessions.filter(s => {
    if (!query) return true;
    const q = query.toLowerCase();
    return s.lastLine.toLowerCase().includes(q) ||
           (s.channelName || '').toLowerCase().includes(q) ||
           (s.threadName || '').toLowerCase().includes(q) ||
           s.id.toLowerCase().includes(q);
  });

  const totalMin = sessions.reduce((acc, s) => {
    const [m, sec] = s.duration.split(':').map(Number);
    return acc + m + sec/60;
  }, 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader
        title="History"
        subtitle={`${sessions.length} SESSIONS · ${Math.round(totalMin)} MIN TOTAL`}
        onBack={onBack}
      />

      {/* search */}
      <div style={{ padding: '12px 22px 8px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: HIFI.surface, border: `1px solid ${HIFI.stroke}`,
          borderRadius: 12, padding: '10px 14px',
        }}>
          <span style={{ color: HIFI.ink3, fontSize: 14, fontFamily: HIFI.fonts.mono }}>⌕</span>
          <input
            value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search transcripts…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: HIFI.ink, fontFamily: HIFI.fonts.sans, fontSize: 13,
            }} />
        </div>
      </div>

      <ScrollBody pad={16}>
        {filtered.map(s => (
          <SessionRow key={s.id} s={s} onOpen={() => onOpen(s.id)} />
        ))}
        {filtered.length === 0 && (
          <div style={{
            padding: 40, textAlign: 'center', fontFamily: HIFI.fonts.mono,
            fontSize: 12, color: HIFI.ink3, letterSpacing: 1,
          }}>NO MATCHES</div>
        )}
      </ScrollBody>
    </div>
  );
}

function SessionRow({ s, onOpen }) {
  const [hover, setHover] = React.useState(false);
  const sess = window.parseSession(s.id);
  const app = window.HIFI_APPS[sess.app] || window.HIFI_APPS.discord;

  // Thread label: human name if we have one, otherwise a bare unix timestamp
  // gets rendered as a short form ("thread 1766284491").
  const threadLabel = s.threadName
    ? s.threadName
    : sess.threadId
      ? `thread ${sess.threadId.slice(-10)}`
      : null;

  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '12px 12px 14px',
        background: hover ? HIFI.surface : 'transparent',
        border: 'none', borderBottom: `1px solid ${HIFI.stroke}`,
        color: HIFI.ink, cursor: 'pointer',
        borderRadius: 8, marginBottom: 2,
        transition: 'background 120ms',
        fontFamily: 'inherit',
      }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 8, marginBottom: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span style={{
            width: 18, height: 18, borderRadius: 5, background: app.bg,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: HIFI.fonts.sans, fontWeight: 700, color: 'white', fontSize: 10,
            flexShrink: 0,
          }}>{app.letter}</span>
          <span style={{
            fontFamily: HIFI.fonts.mono, fontSize: 11, letterSpacing: 0.4,
            color: s.active ? '#ff9e3b' : HIFI.ink, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {s.channelName || sess.channelId}
            {threadLabel && <>
              <span style={{ color: HIFI.ink4, margin: '0 4px' }}>›</span>
              <span style={{ color: HIFI.ink2, fontWeight: 500 }}>{threadLabel}</span>
            </>}
          </span>
        </div>
        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink3,
          letterSpacing: 0.8, flexShrink: 0,
        }}>{s.when}</div>
      </div>
      <div style={{
        fontSize: 13, color: HIFI.ink, lineHeight: 1.45,
        marginBottom: 10, fontFamily: HIFI.fonts.sans, fontWeight: 400,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>{s.lastLine}</div>
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center',
        fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink3,
        letterSpacing: 1,
      }}>
        <span>{s.duration}</span>
        <span style={{ color: HIFI.ink4 }}>·</span>
        <span>{s.turns} TURNS</span>
        {s.active && (
          <span style={{
            marginLeft: 'auto', padding: '2px 7px', borderRadius: 10,
            background: '#ff9e3b22', color: '#ff9e3b', fontWeight: 700,
            letterSpacing: 1.4, fontSize: 9,
          }}>ACTIVE</span>
        )}
      </div>
    </button>
  );
}

// --- TRANSCRIPT --------------------------------------------------------------

function TranscriptScreen({ sessionId, onBack }) {
  const session = window.HIFI_SESSIONS.find(s => s.id === sessionId) || window.HIFI_SESSIONS[0];
  const sess = window.parseSession(session.id);
  const app = window.HIFI_APPS[sess.app] || window.HIFI_APPS.discord;
  const threadLabel = session.threadName
    ? session.threadName
    : sess.threadId
      ? `thread ${sess.threadId.slice(-10)}`
      : null;
  const turns = window.HIFI_FULL_TRANSCRIPT;
  const [menu, setMenu] = React.useState(false);
  const [toast, setToast] = React.useState('');

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 1600);
  };

  const sessionUrl = `https://walkytalk.ai/?session=${encodeURIComponent(session.id)}`;

  const asMarkdown = () => {
    const locator = session.channelName + (threadLabel ? ` › ${threadLabel}` : '');
    const head = `# WalkyTalk session\n\n_${session.when} · ${session.duration} · ${session.turns} turns · ${app.name} · ${locator}_\n\n${sessionUrl}\n\n---\n\n`;
    const body = turns.map(t => {
      const label = t.who === 'user' ? '**You**' : '**WalkyTalk**';
      return `${label}: ${t.text}`;
    }).join('\n\n');
    return head + body;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asMarkdown());
      showToast('COPIED TO CLIPBOARD');
    } catch(e) {
      showToast('COPY FAILED');
    }
    setMenu(false);
  };

  const share = () => {
    try { navigator.clipboard && navigator.clipboard.writeText(sessionUrl); } catch(e){}
    showToast('SHARE LINK COPIED');
    setMenu(false);
  };

  const exportMd = () => {
    const blob = new Blob([asMarkdown()], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `walkytalk-${(session.channelName || 'session').replace(/[^a-z0-9]/gi,'-').toLowerCase()}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('DOWNLOADED .MD');
    setMenu(false);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink, position: 'relative' }}>
      <ScreenHeader
        title={session.channelName || sess.channelId}
        subtitle={`${threadLabel ? threadLabel.toUpperCase() + ' · ' : ''}${session.when.toUpperCase()} · ${session.duration}`}
        onBack={onBack}
        right={
          <button onClick={() => setMenu(m => !m)} style={{
            width: 36, height: 36, borderRadius: 10,
            background: menu ? HIFI.surface2 : 'transparent',
            border: `1px solid ${HIFI.stroke}`,
            color: HIFI.ink, cursor: 'pointer', fontSize: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: HIFI.fonts.mono, lineHeight: 1,
          }}>⋯</button>
        }
      />

      {/* action menu */}
      {menu && (
        <div style={{
          position: 'absolute', top: 54, right: 16, zIndex: 10,
          background: HIFI.surface2, border: `1px solid ${HIFI.strokeStrong}`,
          borderRadius: 12, padding: 4, minWidth: 170,
          boxShadow: '0 14px 30px rgba(0,0,0,0.6)',
        }}>
          <MenuItem icon="⧉" label="Copy as Markdown" onClick={copy} />
          <MenuItem icon="↗" label="Share link" onClick={share} />
          <MenuItem icon="↓" label="Export .md" onClick={exportMd} />
        </div>
      )}

      <ScrollBody pad={18}>
        {/* handoff origin card — where did this session come from */}
        <div style={{
          padding: '10px 14px', borderRadius: 12,
          background: HIFI.surface, border: `1px solid ${HIFI.stroke}`,
          marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10,
          fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink2,
          letterSpacing: 0.6,
        }}>
          <span style={{
            width: 22, height: 22, borderRadius: 6, background: app.bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: HIFI.fonts.sans, fontWeight: 700, color: 'white', fontSize: 12,
            flexShrink: 0,
          }}>{app.letter}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: HIFI.ink3, fontSize: 9, letterSpacing: 1.4, marginBottom: 2 }}>
              HANDED OFF FROM {app.name.toUpperCase()}
            </div>
            <div style={{
              color: HIFI.ink, fontFamily: HIFI.fonts.mono, fontSize: 11, fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {session.channelName || sess.channelId}
              {threadLabel && <>
                <span style={{ color: HIFI.ink4, margin: '0 5px' }}>›</span>
                <span style={{ color: HIFI.ink2, fontWeight: 500 }}>{threadLabel}</span>
              </>}
            </div>
          </div>
        </div>

        {turns.map((t, i) => (
          <TurnBubble key={i} turn={t} />
        ))}

        <div style={{
          marginTop: 18, padding: '12px 0', textAlign: 'center',
          fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink3,
          letterSpacing: 1.4,
        }}>
          · END OF TRANSCRIPT ·
        </div>
      </ScrollBody>

      {/* toast */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: 24, left: '50%',
          transform: 'translateX(-50%)',
          padding: '9px 16px', borderRadius: 22,
          background: HIFI.ink, color: '#000',
          fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 700,
          letterSpacing: 1.4, zIndex: 20,
          boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
        }}>{toast}</div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '10px 12px', borderRadius: 8,
        background: hover ? HIFI.surface : 'transparent',
        border: 'none', color: HIFI.ink, cursor: 'pointer',
        fontFamily: HIFI.fonts.sans, fontSize: 12, fontWeight: 500,
        textAlign: 'left',
      }}>
      <span style={{ width: 16, color: HIFI.ink2, fontFamily: HIFI.fonts.mono }}>{icon}</span>
      {label}
    </button>
  );
}

function TurnBubble({ turn }) {
  const isUser = turn.who === 'user';

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontFamily: HIFI.fonts.mono, fontSize: 9, fontWeight: 700,
        letterSpacing: 1.6, marginBottom: 4,
        color: isUser ? '#ff9e3b' : HIFI.ai,
      }}>
        {isUser ? 'YOU' : 'WALKYTALK'}
      </div>
      <div style={{
        fontFamily: HIFI.fonts.sans, fontSize: 14, lineHeight: 1.55,
        color: isUser ? HIFI.ink : HIFI.ink2,
        fontWeight: isUser ? 500 : 400,
      }}>{turn.text}</div>
    </div>
  );
}

// --- HANDOFF LANDING ---------------------------------------------------------
// walkytalk.ai/s/A7F3-K9P2 — what the user sees when they tap the link from
// a Discord/Slack/Claude message.

function HandoffScreen({ onEnter, onBack }) {
  // Real URL the user taps from their chat app. Session slug encodes
  // agent:app:channelId[:threadId] — OpenClaw constructs this when the
  // agent drops the link.
  const sessionId = 'agent:main:discord:1495266157463208138:1766284491';
  const sess = window.parseSession(sessionId);
  const app = window.HIFI_APPS[sess.app] || window.HIFI_APPS.discord;
  const encoded = encodeURIComponent(sessionId);
  // Demo: pretend the agent passed a channel name hint too (?c=ai-writing).
  const channelHint = '#ai-writing';
  const threadLabel = sess.threadId ? `thread ${sess.threadId.slice(-10)}` : null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      {/* fake browser bar */}
      <div style={{
        padding: '6px 14px 8px', borderBottom: `1px solid ${HIFI.stroke}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <button onClick={onBack} style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'transparent', border: `1px solid ${HIFI.stroke}`,
          color: HIFI.ink2, cursor: 'pointer', fontFamily: HIFI.fonts.mono, fontSize: 14,
        }}>‹</button>
        <div style={{
          flex: 1, padding: '6px 12px', borderRadius: 20,
          background: HIFI.surface, border: `1px solid ${HIFI.stroke}`,
          fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink2,
          letterSpacing: 0, display: 'flex', alignItems: 'center', gap: 6,
          overflow: 'hidden', minWidth: 0,
        }}>
          <span style={{ color: '#4ed29a', flexShrink: 0 }}>⚲</span>
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0, flex: 1,
          }}>clawkietalkie.ai/?session={encoded}</span>
        </div>
      </div>

      <ScrollBody pad={22}>
        {/* logo + tagline */}
        <div style={{ textAlign: 'center', padding: '18px 0 10px' }}>
          <div style={{
            fontFamily: HIFI.fonts.mono, fontSize: 11, letterSpacing: 2,
            color: HIFI.ink3, fontWeight: 700, marginBottom: 4,
          }}>CLAWKIE<span style={{ color: '#ff9e3b' }}>-TALKIE</span></div>
          <div style={{
            fontFamily: HIFI.fonts.mono, fontSize: 10, letterSpacing: 1.4,
            color: HIFI.ink3, marginBottom: 18,
          }}>A WALKY-TALKY FOR YOUR BRAIN</div>
        </div>

        {/* handoff card — no title, no briefing. Just: who sent you here. */}
        <div style={{
          padding: '22px 20px', borderRadius: 18,
          background: `linear-gradient(160deg, ${HIFI.surface} 0%, #151518 100%)`,
          border: `1px solid ${HIFI.strokeStrong}`,
          marginBottom: 16,
        }}>
          <div style={{
            fontFamily: HIFI.fonts.mono, fontSize: 10, letterSpacing: 1.6,
            color: '#ff9e3b', fontWeight: 700, marginBottom: 14,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#ff9e3b',
              animation: 'pulseDot 1.2s ease-in-out infinite',
              boxShadow: '0 0 8px #ff9e3b',
            }} />
            NEW SESSION
          </div>

          {/* Source + context, big and clear */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20,
          }}>
            <span style={{
              width: 44, height: 44, borderRadius: 10, background: app.bg,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontSize: 20, fontFamily: HIFI.fonts.sans, fontWeight: 700,
              flexShrink: 0,
            }}>{app.letter}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontFamily: HIFI.fonts.mono, fontSize: 10, letterSpacing: 1.4,
                color: HIFI.ink3, fontWeight: 700, marginBottom: 3,
              }}>FROM {app.name.toUpperCase()}</div>
              <div style={{
                fontFamily: HIFI.fonts.sans, fontSize: 17, fontWeight: 600, color: HIFI.ink,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {channelHint}
              </div>
              {threadLabel && (
                <div style={{
                  fontFamily: HIFI.fonts.mono, fontSize: 11, color: HIFI.ink3,
                  marginTop: 2, letterSpacing: 0.4,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>› {threadLabel}</div>
              )}
            </div>
          </div>

          <button
            onClick={onEnter}
            style={{
              width: '100%', padding: '16px',
              background: '#ff9e3b', color: '#000',
              border: 'none', borderRadius: 14,
              fontFamily: HIFI.fonts.mono, fontSize: 13, fontWeight: 700,
              letterSpacing: 1.6, cursor: 'pointer',
              boxShadow: '0 0 24px rgba(255,158,59,0.4)',
            }}>
            START TALKING →
          </button>
        </div>

        {/* small reassurance — no briefing, no title claim */}
        <div style={{
          padding: '14px 16px', borderRadius: 12,
          border: `1px solid ${HIFI.stroke}`, background: HIFI.surface,
          marginBottom: 12, fontFamily: HIFI.fonts.sans, fontSize: 12,
          color: HIFI.ink2, lineHeight: 1.55,
        }}>
          Anything you record will be linked back to this {app.name} conversation
          so you can pick up either side, any time.
        </div>

        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 9, letterSpacing: 1.2,
          color: HIFI.ink4, textAlign: 'center', padding: '12px 0',
        }}>
          END-TO-END ENCRYPTED
        </div>
      </ScrollBody>
    </div>
  );
}

function SessionField({ label, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        fontFamily: HIFI.fonts.mono, fontSize: 9, letterSpacing: 1.4,
        color: HIFI.ink3, fontWeight: 700, width: 68, flexShrink: 0,
      }}>{label}</div>
      <div style={{
        fontFamily: HIFI.fonts.mono, fontSize: 12, color: HIFI.ink,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        minWidth: 0, flex: 1,
      }}>{children}</div>
    </div>
  );
}

// --- SETTINGS ----------------------------------------------------------------

function SettingsScreen({ onBack, settings, setSettings }) {
  const update = (k, v) => setSettings(prev => ({ ...prev, [k]: v }));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="Settings" onBack={onBack} />
      <ScrollBody pad={22}>

        <SettingsSection title="API KEY">
          <ApiKeyRow
            provider={settings.provider}
            setProvider={v => update('provider', v)}
            keys={settings.apiKeys}
            setKey={(p, v) => update('apiKeys', { ...settings.apiKeys, [p]: v })}
            statuses={settings.apiKeyStatuses}
          />
        </SettingsSection>

        <SettingsSection title="VOICE">
          <SettingsRow label="AI voice" value={settings.voice} />
          <SliderRow
            label="Speaking speed"
            value={settings.speed} setValue={v => update('speed', v)}
            min={0.75} max={1.5} step={0.05}
            format={v => `${v.toFixed(2)}×`}
          />
        </SettingsSection>

        <SettingsSection title="EXPORT">
          <SegmentedRow
            label="Format"
            value={settings.format} setValue={v => update('format', v)}
            options={[
              { id: 'md',   label: 'Markdown' },
              { id: 'txt',  label: 'Text' },
              { id: 'json', label: 'JSON' },
            ]}
          />
          <ToggleRow
            label="Include timestamps"
            value={settings.timestamps} setValue={v => update('timestamps', v)}
          />
        </SettingsSection>

        <div style={{
          padding: '20px 0 10px', textAlign: 'center',
          fontFamily: HIFI.fonts.mono, fontSize: 9, letterSpacing: 1.2,
          color: HIFI.ink4,
        }}>
          WALKYTALK v0.3.2 · BUILD 184
        </div>
      </ScrollBody>
    </div>
  );
}

function SettingsSection({ title, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontFamily: HIFI.fonts.mono, fontSize: 9, letterSpacing: 1.6,
        color: HIFI.ink3, fontWeight: 700, marginBottom: 8, paddingLeft: 2,
      }}>{title}</div>
      <div style={{
        background: HIFI.surface, borderRadius: 14,
        border: `1px solid ${HIFI.stroke}`, overflow: 'hidden',
      }}>{children}</div>
    </div>
  );
}

function SettingsRow({ label, value }) {
  return (
    <div style={{
      padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans }}>{label}</div>
      <div style={{
        fontSize: 12, color: HIFI.ink3, fontFamily: HIFI.fonts.mono,
        letterSpacing: 0.4, textAlign: 'right',
      }}>{value}</div>
    </div>
  );
}

// API key input — provider dropdown + masked key + status.
// Supports multiple providers (xAI, OpenAI). User picks one at a time;
// keys for each are stored independently so switching doesn't wipe them.
// - Masked by default; toggle reveals.
// - Shows per-provider connection status.
// - Paste-friendly: large tap target, monospace input.
function ApiKeyRow({ provider, setProvider, keys, setKey, statuses }) {
  const [reveal, setReveal] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  const [dropOpen, setDropOpen] = React.useState(false);

  const cfg = PROVIDERS[provider] || PROVIDERS.xai;
  const value = (keys && keys[provider]) || '';
  const rawStatus = statuses && statuses[provider];
  const status = rawStatus || (value ? 'ok' : 'unset');
  const masked = value ? '•'.repeat(Math.max(0, value.length - 4)) + value.slice(-4) : '';

  const statusConfig = {
    unset:    { color: HIFI.ink3, label: 'NOT SET',   dot: false },
    checking: { color: '#ff9e3b', label: 'CHECKING',  dot: true  },
    ok:       { color: '#4ed29a', label: 'CONNECTED', dot: true  },
    invalid:  { color: '#ef6155', label: 'INVALID',   dot: true  },
  }[status];

  return (
    <div style={{ padding: '14px 14px 12px' }}>
      {/* Provider dropdown + status */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 10, gap: 10,
      }}>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setDropOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 11px', borderRadius: 8,
              background: HIFI.surface2, border: `1px solid ${HIFI.stroke}`,
              color: HIFI.ink, cursor: 'pointer',
              fontFamily: HIFI.fonts.sans, fontSize: 13, fontWeight: 500,
            }}>
            <ProviderGlyph cfg={cfg} />
            <span>{cfg.name}</span>
            <span style={{ color: HIFI.ink3, fontSize: 9, marginLeft: 2 }}>▾</span>
          </button>
          {dropOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              background: HIFI.surface2, border: `1px solid ${HIFI.strokeStrong}`,
              borderRadius: 10, padding: 4, zIndex: 10,
              boxShadow: '0 8px 20px rgba(0,0,0,0.45)',
              minWidth: 180,
            }}>
              {Object.entries(PROVIDERS).map(([id, p]) => {
                const on = provider === id;
                const hasKey = !!(keys && keys[id]);
                return (
                  <button key={id}
                    onClick={() => { setProvider(id); setDropOpen(false); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      width: '100%', padding: '8px 10px', borderRadius: 7,
                      background: on ? HIFI.ink + '14' : 'transparent',
                      border: 'none', cursor: 'pointer',
                      color: HIFI.ink, textAlign: 'left',
                      fontFamily: HIFI.fonts.sans, fontSize: 13,
                    }}>
                    <ProviderGlyph cfg={p} />
                    <span style={{ flex: 1 }}>{p.name}</span>
                    {hasKey && <span style={{
                      width: 5, height: 5, borderRadius: '50%', background: '#4ed29a',
                      flexShrink: 0,
                    }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 9, letterSpacing: 1.2,
          fontWeight: 700, color: statusConfig.color,
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          {statusConfig.dot && (
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: statusConfig.color,
              boxShadow: `0 0 6px ${statusConfig.color}`,
              animation: status === 'checking' ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
            }} />
          )}
          {statusConfig.label}
        </div>
      </div>

      {/* Input row with show/hide toggle */}
      <div style={{
        display: 'flex', alignItems: 'stretch', gap: 6,
        marginBottom: 8,
      }}>
        <div style={{
          flex: 1,
          background: HIFI.surface2, borderRadius: 9,
          border: `1px solid ${focus ? '#ff9e3b' : HIFI.stroke}`,
          padding: '10px 12px',
          transition: 'border-color 150ms',
          minWidth: 0,
        }}>
          <input
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={e => setKey(provider, e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder={cfg.placeholder}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: '100%', background: 'transparent', border: 'none',
              outline: 'none', color: HIFI.ink,
              fontFamily: HIFI.fonts.mono, fontSize: 12,
              letterSpacing: 0.3,
            }}
          />
        </div>
        <button
          onClick={() => setReveal(r => !r)}
          style={{
            padding: '0 12px', minWidth: 44,
            background: 'transparent', border: `1px solid ${HIFI.stroke}`,
            borderRadius: 9, color: HIFI.ink2, cursor: 'pointer',
            fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 600,
            letterSpacing: 1,
          }}>{reveal ? 'HIDE' : 'SHOW'}</button>
      </div>

      {/* Masked preview when not focused + something is set */}
      {value && !focus && !reveal && (
        <div style={{
          fontFamily: HIFI.fonts.mono, fontSize: 10, color: HIFI.ink3,
          letterSpacing: 0.4, marginBottom: 8,
        }}>{masked}</div>
      )}

      {/* Helper text + link — copy is per-provider */}
      <div style={{
        fontFamily: HIFI.fonts.sans, fontSize: 11, color: HIFI.ink3,
        lineHeight: 1.5,
      }}>
        Stored on this device only, never sent anywhere except {cfg.name}.{' '}
        <a href={cfg.consoleUrl} target="_blank" rel="noreferrer"
          style={{ color: '#ff9e3b', textDecoration: 'none', fontWeight: 600 }}>
          Get a key ↗
        </a>
      </div>
    </div>
  );
}

// Tiny colored square with a single-letter glyph. Used in the provider
// dropdown so rows are visually distinct at a glance.
function ProviderGlyph({ cfg }) {
  return (
    <span style={{
      width: 18, height: 18, borderRadius: 5, background: cfg.glyphBg,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: HIFI.fonts.sans, fontWeight: 700, color: cfg.glyphFg,
      fontSize: 10, flexShrink: 0,
    }}>{cfg.letter}</span>
  );
}

// Provider registry — name, placeholder, console URL, badge colors.
const PROVIDERS = {
  xai: {
    name: 'xAI',
    placeholder: 'xai-...',
    consoleUrl: 'https://console.x.ai',
    letter: 'X',
    glyphBg: '#000',
    glyphFg: '#fff',
  },
  openai: {
    name: 'OpenAI',
    placeholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com/api-keys',
    letter: 'O',
    glyphBg: '#10a37f',
    glyphFg: '#fff',
  },
};

// Row for a connected chat-app account: icon + name + account handle +
// "Primary" badge if it's the default. Tapping it would open a detail
// screen with disconnect/reauth actions (not implemented here — static demo).
function ToggleRow({ label, sub, value, setValue }) {
  return (
    <div style={{
      padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans }}>{label}</div>
        {sub && <div style={{
          fontSize: 11, color: HIFI.ink3, fontFamily: HIFI.fonts.sans,
          marginTop: 2, lineHeight: 1.4,
        }}>{sub}</div>}
      </div>
      <button onClick={() => setValue(!value)} style={{
        width: 40, height: 24, borderRadius: 12, position: 'relative',
        border: 'none', cursor: 'pointer', flexShrink: 0,
        background: value ? '#ff9e3b' : HIFI.surface2,
        boxShadow: value ? '0 0 10px rgba(255,158,59,0.4)' : 'none',
        transition: 'background 200ms',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: value ? 18 : 2,
          width: 20, height: 20, borderRadius: '50%',
          background: value ? '#000' : HIFI.ink3,
          transition: 'left 200ms',
        }} />
      </button>
    </div>
  );
}

function SliderRow({ label, value, setValue, min, max, step, format }) {
  return (
    <div style={{
      padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}`,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginBottom: 8,
      }}>
        <div style={{ fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans }}>{label}</div>
        <div style={{
          fontSize: 12, color: '#ff9e3b', fontFamily: HIFI.fonts.mono, fontWeight: 600,
        }}>{format ? format(value) : value}</div>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => setValue(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#ff9e3b' }}
      />
    </div>
  );
}

function SegmentedRow({ label, value, setValue, options }) {
  return (
    <div style={{
      padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}`,
    }}>
      <div style={{
        fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans, marginBottom: 8,
      }}>{label}</div>
      <div style={{
        display: 'flex', gap: 4, padding: 3, borderRadius: 10,
        background: HIFI.surface2, border: `1px solid ${HIFI.stroke}`,
      }}>
        {options.map(o => (
          <button key={o.id} onClick={() => setValue(o.id)} style={{
            flex: 1, padding: '7px 4px', borderRadius: 7,
            background: value === o.id ? HIFI.ink : 'transparent',
            color: value === o.id ? '#000' : HIFI.ink2,
            border: 'none', cursor: 'pointer',
            fontFamily: HIFI.fonts.mono, fontSize: 10, fontWeight: 700,
            letterSpacing: 1, textTransform: 'uppercase',
            transition: 'all 160ms',
          }}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { HistoryScreen, TranscriptScreen, HandoffScreen, SettingsScreen });
