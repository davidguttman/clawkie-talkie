import { useEffect, useState } from 'react';
import { HIFI, type AccentKey } from '../tokens';
import { ButtonAura, LiveWave } from '../components/Phone';

// Visual-only port of docs/design/hifi-driving.jsx. The IDLE → REC → THINK →
// AI state machine is intentionally NOT wired here — it comes online in
// Phase 2 (xAI STT/TTS) once WebRTC is in place. For Phase 0 this screen
// renders the IDLE layout faithfully so the shell lands.

type DrivingState = 'idle' | 'recording' | 'thinking' | 'ai';

const WAVE_BARS = 28;

export function DrivingScreen({
  accent = 'amber',
  fontMode = 'mono',
  onReplay,
  onHistory,
  onSettings,
  compact = false,
}: {
  accent?: AccentKey;
  fontMode?: 'mono' | 'sans';
  onReplay?: () => void;
  onHistory?: () => void;
  onSettings?: () => void;
  compact?: boolean;
}) {
  const accentCfg = HIFI.accents[accent] || HIFI.accents.amber;
  const state: DrivingState = 'idle';
  const [intensities, setIntensities] = useState<number[]>(() =>
    Array(WAVE_BARS).fill(0.12),
  );

  // ambient bar drift so idle screen feels alive, without implementing the
  // real state machine.
  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      const next = Array.from({ length: WAVE_BARS }, (_, i) => {
        const v = 0.16 + Math.sin(t / 900 + i * 0.55) * 0.05;
        return Math.max(0.08, Math.min(1, Math.abs(v)));
      });
      setIntensities(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const stateColor = HIFI.ink3;
  const stateGlow = 'transparent';
  const baseFont = fontMode === 'sans' ? HIFI.fonts.sans : HIFI.fonts.mono;

  const sidePad = compact ? 2 : 22;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: compact ? `8px ${sidePad}px 10px` : `12px ${sidePad}px 14px`,
        color: HIFI.ink,
        fontFamily: baseFont,
        minWidth: 0,
        width: '100%',
        boxSizing: 'border-box',
        maxWidth: '100%',
      }}
    >
      {/* header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 10,
          gap: 10,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 1.2,
            color: HIFI.ink2,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {compact ? 'CLWK · f3c1' : 'CLWK · f3c1 · discord'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div
            style={{
              display: 'inline-flex',
              gap: 5,
              alignItems: 'center',
              padding: '3px 9px',
              borderRadius: 20,
              border: `1px solid ${stateColor}55`,
              background: `${stateColor}11`,
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1.2,
              color: stateColor,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: stateColor,
                boxShadow: `0 0 8px ${stateColor}`,
              }}
            />
            READY
          </div>
          {onSettings && (
            <button
              onClick={onSettings}
              style={{
                width: 30,
                height: 30,
                borderRadius: 10,
                background: 'transparent',
                border: `1px solid ${HIFI.stroke}`,
                color: HIFI.ink2,
                cursor: 'pointer',
                fontFamily: HIFI.fonts.mono,
                fontSize: 15,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                boxSizing: 'border-box',
                appearance: 'none',
                WebkitAppearance: 'none',
                padding: 0,
              }}
              aria-label="Settings"
            >
              ⚙
            </button>
          )}
        </div>
      </div>

      {/* caption + waveform live in a single anchored panel so the top half
          reads as one composition instead of two drifting strips. */}
      <div
        style={{
          border: `1px solid ${HIFI.stroke}`,
          borderRadius: 16,
          background: HIFI.surface,
          padding: compact ? '10px 12px 8px' : '14px 16px 10px',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        <IdleCaption baseFont={baseFont} />
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${HIFI.stroke}`,
            display: 'flex',
            justifyContent: 'center',
            minWidth: 0,
          }}
        >
          <LiveWave
            intensities={intensities}
            color={stateColor}
            width="100%"
            height={34}
          />
        </div>
      </div>

      {/* BIG BUTTON */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          minHeight: 200,
          padding: '12px 0',
        }}
      >
        <PTTButton
          isRec={false}
          isAI={false}
          stateColor={accentCfg.rec}
          stateGlow={accentCfg.recGlow}
        />
      </div>

      {/* footer — stacks on narrow phones so each action gets the full width
          and the HISTORY label can never touch the right gutter. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : '1fr 1fr',
          gap: 8,
          marginTop: 8,
          minWidth: 0,
        }}
      >
        <FooterButton icon="↺" label="REPLAY" onClick={onReplay} compact={compact} />
        <FooterButton icon="≡" label="HISTORY" onClick={onHistory} compact={compact} />
      </div>
    </div>
  );
}

function IdleCaption({ baseFont }: { baseFont: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 96 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.6,
          color: HIFI.ink2,
          marginBottom: 8,
        }}
      >
        READY
      </div>
      <div
        style={{
          fontSize: 16,
          lineHeight: 1.5,
          color: HIFI.ink,
          fontWeight: 400,
          fontFamily: baseFont,
        }}
      >
        Tap to continue the conversation.
      </div>
      <div
        style={{
          marginTop: 10,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          letterSpacing: 1.4,
          color: HIFI.ink3,
          fontWeight: 600,
        }}
      >
        VOICE LOOP WIRES UP IN PHASE 2
      </div>
    </div>
  );
}

function PTTButton({
  isRec,
  isAI,
  stateColor,
  stateGlow,
}: {
  isRec: boolean;
  isAI: boolean;
  stateColor: string;
  stateGlow: string;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        position: 'relative',
        width: 208,
        height: 208,
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        background: `radial-gradient(circle at 30% 28%, ${pressed ? '#2a2a2e' : '#1a1a1d'} 0%, #0a0a0b 100%)`,
        boxShadow: `0 0 0 1px ${HIFI.strokeStrong}, inset 0 1px 0 rgba(255,255,255,0.06), 0 ${pressed ? 8 : 18}px ${pressed ? 20 : 40}px rgba(0,0,0,0.6)`,
        color: HIFI.ink,
        fontFamily: HIFI.fonts.mono,
        transform: `scale(${pressed ? 0.96 : 1})`,
        transition: 'transform 200ms cubic-bezier(0.2,1.4,0.4,1), box-shadow 200ms',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <ButtonAura active={isRec || isAI} color={stateColor} />
      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center' }}>
        <div style={{ fontSize: 48, lineHeight: 1, fontWeight: 500, color: stateColor }}>●</div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.8, marginTop: 12 }}>
          TAP TO TALK
        </div>
        <div
          style={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 1.4,
            marginTop: 6,
            color: HIFI.ink3,
          }}
        >
          (not wired yet)
        </div>
      </div>
      {/* stateGlow referenced to keep types happy when we swap behavior in */}
      <span style={{ display: 'none' }} data-glow={stateGlow} />
    </button>
  );
}

function FooterButton({
  icon,
  label,
  onClick,
  compact,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        height: compact ? 50 : 60,
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        borderRadius: 14,
        border: `1px solid ${HIFI.stroke}`,
        background: HIFI.surface,
        color: HIFI.ink,
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: HIFI.fonts.mono,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.4,
        transition: 'background 0.2s, border-color 0.2s',
        appearance: 'none',
        WebkitAppearance: 'none',
      }}
    >
      <span style={{ fontSize: 18, fontFamily: HIFI.fonts.sans }}>{icon}</span>
      {label}
    </button>
  );
}
