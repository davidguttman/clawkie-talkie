// Sketchy wireframe primitives - low-fi, hand-drawn feel
// Uses CSS filter tricks for a sketchy border, Caveat/Kalam for handwritten text

const SKETCH = {
  ink: '#1a1a1a',
  paper: '#fafaf7',
  paperAlt: '#f3f1e8',
  muted: '#8a8880',
  faint: '#d9d6cc',
  accent: '#d94a2c',        // recording red (warm, not neon)
  accentSoft: '#f0c9bd',
  ai: '#2b5d7a',            // AI speaking (deep teal-blue)
  aiSoft: '#c9dbe4',
  hand: '"Kalam", "Architects Daughter", "Caveat", cursive',
  note: '"Caveat", "Kalam", cursive',
  body: '"Kalam", system-ui, sans-serif',
  mono: '"JetBrains Mono", "Courier New", monospace',
};

// ---------- Sketchy box (hand-drawn rectangle via double border + tilt) ----------
function SBox({ children, style = {}, rounded = 8, dashed = false, filled = null, thick = false }) {
  return (
    <div style={{
      border: `${thick ? 2 : 1.5}px ${dashed ? 'dashed' : 'solid'} ${SKETCH.ink}`,
      borderRadius: rounded,
      background: filled || 'transparent',
      boxShadow: '1px 1.5px 0 rgba(0,0,0,0.08)',
      position: 'relative',
      ...style,
    }}>{children}</div>
  );
}

// ---------- Sketchy circle ----------
function SCircle({ size = 80, style = {}, dashed = false, filled = null, thick = false, children }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `${thick ? 2.5 : 1.5}px ${dashed ? 'dashed' : 'solid'} ${SKETCH.ink}`,
      background: filled || 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '1px 1.5px 0 rgba(0,0,0,0.08)',
      ...style,
    }}>{children}</div>
  );
}

// ---------- Scribble line (placeholder text) ----------
function Scribble({ w = 120, h = 8, style = {} }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: h/2,
      background: `repeating-linear-gradient(90deg, ${SKETCH.ink} 0 ${w*0.6}px, transparent ${w*0.6}px ${w*0.8}px, ${SKETCH.ink} ${w*0.8}px ${w}px)`,
      opacity: 0.35,
      ...style,
    }} />
  );
}

// Multi-line scribble
function ScribbleLines({ lines = 3, lastWidth = '60%', style = {} }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} style={{
          height: 6, borderRadius: 3, background: SKETCH.ink, opacity: 0.25,
          width: i === lines - 1 ? lastWidth : '100%',
        }} />
      ))}
    </div>
  );
}

// ---------- Hand-labeled callout / annotation ----------
function Annotation({ children, style = {}, rotate = -1.5 }) {
  return (
    <div style={{
      fontFamily: SKETCH.note, fontSize: 18, color: SKETCH.ink,
      transform: `rotate(${rotate}deg)`,
      ...style,
    }}>{children}</div>
  );
}

// Arrow (from-to points as {x,y} within a container)
function Arrow({ from, to, curve = 0, dashed = false, color = SKETCH.ink, style = {} }) {
  const mx = (from.x + to.x) / 2 + curve;
  const my = (from.y + to.y) / 2 - Math.abs(curve) * 0.3;
  const w = Math.max(from.x, to.x) + 20;
  const h = Math.max(from.y, to.y) + 20;
  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, width: w, height: h, pointerEvents: 'none', overflow: 'visible', ...style }}>
      <defs>
        <marker id={`arr-${color.replace('#','')}`} markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </marker>
      </defs>
      <path
        d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
        fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round"
        strokeDasharray={dashed ? '5 4' : 'none'}
        markerEnd={`url(#arr-${color.replace('#','')})`}
      />
    </svg>
  );
}

// Hand-drawn wave form (for audio states)
function Waveform({ width = 200, height = 40, bars = 20, state = 'idle', style = {} }) {
  const seed = (i) => {
    // pseudo-random deterministic heights
    const v = Math.sin(i * 2.3) * Math.cos(i * 1.7);
    return Math.abs(v);
  };
  const color = state === 'recording' ? SKETCH.accent
             : state === 'ai' ? SKETCH.ai
             : SKETCH.ink;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, width, height, ...style }}>
      {Array.from({ length: bars }).map((_, i) => {
        const base = state === 'idle' ? 0.1 : seed(i) * 0.9 + 0.1;
        return (
          <div key={i} style={{
            flex: 1, background: color,
            height: `${base * 100}%`, minHeight: 3,
            borderRadius: 2, opacity: state === 'idle' ? 0.25 : 0.75,
          }} />
        );
      })}
    </div>
  );
}

// Status chip
function StatusChip({ state, style = {} }) {
  const cfg = {
    idle:       { label: 'READY',       bg: '#e8e6dd',    fg: SKETCH.ink,     dot: SKETCH.muted },
    recording:  { label: 'REC',         bg: SKETCH.accentSoft, fg: SKETCH.accent, dot: SKETCH.accent },
    thinking:   { label: 'THINKING...', bg: '#f0ebd6',    fg: '#8a6d1f',      dot: '#d4a72c' },
    ai:         { label: 'AI SPEAKING', bg: SKETCH.aiSoft,fg: SKETCH.ai,      dot: SKETCH.ai },
  }[state] || { label: state, bg: '#eee', fg: '#333', dot: '#888' };
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 20, background: cfg.bg,
      fontFamily: SKETCH.mono, fontSize: 10, fontWeight: 600,
      letterSpacing: 1.2, color: cfg.fg, border: `1px solid ${cfg.fg}22`,
      ...style,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot,
        animation: state === 'recording' || state === 'thinking' ? 'sketchpulse 1.2s ease-in-out infinite' : 'none' }} />
      {cfg.label}
    </div>
  );
}

// Paper card (background for a phone frame that feels drawn)
function PaperPhone({ children, style = {}, width = 340, height = 720 }) {
  return (
    <div style={{
      width, height, borderRadius: 42,
      border: `2px solid ${SKETCH.ink}`,
      background: SKETCH.paper,
      boxShadow: '3px 4px 0 rgba(0,0,0,0.06), 0 20px 40px rgba(0,0,0,0.08)',
      position: 'relative', overflow: 'hidden',
      fontFamily: SKETCH.body,
      ...style,
    }}>
      {/* notch */}
      <div style={{
        position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
        width: 90, height: 22, borderRadius: 14,
        background: SKETCH.ink,
      }} />
      {/* status bar bits */}
      <div style={{
        position: 'absolute', top: 18, left: 24, fontFamily: SKETCH.mono,
        fontSize: 11, fontWeight: 600, color: SKETCH.ink,
      }}>9:41</div>
      <div style={{
        position: 'absolute', top: 18, right: 24, fontFamily: SKETCH.mono,
        fontSize: 10, color: SKETCH.ink, display: 'flex', gap: 4, alignItems: 'center',
      }}>
        <span>•••</span>
        <span style={{ border: `1px solid ${SKETCH.ink}`, borderRadius: 2, padding: '0 3px', fontSize: 8 }}>87</span>
      </div>
      {/* home indicator */}
      <div style={{
        position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
        width: 110, height: 4, borderRadius: 2, background: SKETCH.ink, opacity: 0.4,
      }} />
      {children}
    </div>
  );
}

// Inner screen container (respects phone chrome)
function PhoneScreen({ children, style = {}, bg = SKETCH.paper }) {
  return (
    <div style={{
      position: 'absolute', top: 48, left: 0, right: 0, bottom: 20,
      padding: '8px 20px 16px', background: bg,
      display: 'flex', flexDirection: 'column',
      ...style,
    }}>{children}</div>
  );
}

Object.assign(window, {
  SKETCH, SBox, SCircle, Scribble, ScribbleLines, Annotation, Arrow,
  Waveform, StatusChip, PaperPhone, PhoneScreen,
});
