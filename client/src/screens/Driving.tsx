import { useEffect, useMemo, useRef, useState } from 'react';
import { HIFI, type AccentKey } from '../tokens';
import { ButtonAura, LiveWave } from '../components/Phone';
import { useDrivingLoop, type DrivingState } from '../voice/drivingLoop';
import { createLocalReplyProvider, type ReplyResult } from '../voice/reply';
import type { Settings } from '../storage';

// Visual layout ported from docs/design/hifi-driving.jsx, now driven by a
// real state machine: Web Speech API STT while recording, xAI chat (or
// stub) for the reply, and SpeechSynthesis for audible playback. The
// daemon/WebRTC transport will later replace the ReplyProvider + STT
// transport behind this same UI without further layout changes.

const WAVE_BARS = 28;

export function DrivingScreen({
  accent = 'amber',
  fontMode = 'mono',
  onReplay,
  onHistory,
  onSettings,
  compact = false,
  settings,
}: {
  accent?: AccentKey;
  fontMode?: 'mono' | 'sans';
  onReplay?: () => void;
  onHistory?: () => void;
  onSettings?: () => void;
  compact?: boolean;
  settings?: Settings;
}) {
  const accentCfg = HIFI.accents[accent] || HIFI.accents.amber;

  // Read the xAI key freshly at call time so the Settings screen edits
  // take effect on the very next turn without a remount.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const replyProvider = useMemo(
    () =>
      createLocalReplyProvider({
        getApiKey: () => settingsRef.current?.apiKeys?.xai || '',
      }),
    [],
  );

  const ttsOptions = useMemo(
    () => ({
      rate: settings?.speed ?? 1.05,
    }),
    [settings?.speed],
  );

  const loop = useDrivingLoop({ replyProvider, ttsOptions });

  const { state, liveText, lastTurn, replySource, intensities, error, sttSupported, tap } = loop;

  // Ambient idle waveform drift — keeps the panel feeling alive when no
  // turn is in flight. The driving loop owns intensities for non-idle
  // states.
  const [idleIntensities, setIdleIntensities] = useState<number[]>(() =>
    Array(WAVE_BARS).fill(0.12),
  );
  useEffect(() => {
    if (state !== 'idle') return;
    let raf = 0;
    const tick = (t: number) => {
      const next = Array.from({ length: WAVE_BARS }, (_, i) => {
        const v = 0.16 + Math.sin(t / 900 + i * 0.55) * 0.05;
        return Math.max(0.08, Math.min(1, Math.abs(v)));
      });
      setIdleIntensities(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const isRec = state === 'recording';
  const isAI = state === 'ai';
  const isThink = state === 'thinking';
  const isIdle = state === 'idle';

  const stateColor = isRec
    ? accentCfg.rec
    : isAI
      ? HIFI.ai
      : isThink
        ? HIFI.think
        : HIFI.ink3;
  const stateGlow = isRec
    ? accentCfg.recGlow
    : isAI
      ? HIFI.aiGlow
      : isThink
        ? HIFI.thinkGlow
        : 'transparent';

  const baseFont = fontMode === 'sans' ? HIFI.fonts.sans : HIFI.fonts.mono;
  // Compact gutter raised from 2 → 8 so the top-right status pill + gear
  // always sit well inside the viewport on narrow phones, where
  // MobileShell's overflow-x:hidden would otherwise clip them.
  const sidePad = compact ? 8 : 22;

  // Compact uses the shorter "REPLY" label — the full "READING REPLY"
  // wouldn't fit alongside the CLWK label and gear button on narrow phones.
  const statePill = isRec
    ? 'REC'
    : isAI
      ? compact
        ? 'REPLY'
        : 'READING REPLY'
      : isThink
        ? 'THINKING'
        : 'READY';
  const btnLabel = isRec
    ? 'TAP TO STOP'
    : isAI
      ? 'TAP TO SILENCE'
      : isThink
        ? 'THINKING…'
        : 'TAP TO TALK';

  const caption = pickCaption({
    state,
    stateColor,
    liveText,
    lastTurn,
    accentRec: accentCfg.rec,
  });

  const waveIntensities = isIdle ? idleIntensities : intensities;

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
      {/* header — compact drops the state pill to guarantee the gear fits
          on narrow phones. State is still conveyed in the caption panel
          below (label, color, caret). Desktop keeps the full pill layout. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingBottom: 10,
          gap: compact ? 8 : 10,
          minWidth: 0,
          width: '100%',
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
        {!compact && (
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
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: stateColor,
                boxShadow: `0 0 8px ${stateColor}`,
                animation:
                  isRec || isAI || isThink ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
              }}
            />
            {statePill}
          </div>
        )}
        {/* Desktop keeps the gear in the header. On compact, settings moves
            to the footer action row where it cannot be clipped. */}
        {!compact && onSettings && (
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

      {/* caption + waveform panel */}
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
        <Caption caption={caption} baseFont={baseFont} replySource={replySource} error={error} sttSupported={sttSupported} />
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
            intensities={waveIntensities}
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
          onTap={tap}
          state={state}
          stateColor={stateColor}
          stateGlow={stateGlow}
          label={btnLabel}
          accentRec={accentCfg.rec}
        />
      </div>

      {/* footer — on compact, settings lives here (stacked full-width row)
          because the header icon wasn't surviving real-device rendering.
          Desktop keeps the 2-column REPLAY/HISTORY layout since it has the
          gear in the header. */}
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
        {compact && onSettings && (
          <FooterButton
            icon="⚙"
            label="SETTINGS"
            onClick={onSettings}
            compact={compact}
          />
        )}
      </div>
    </div>
  );
}

interface CaptionData {
  label: string;
  color: string;
  text: string;
  live: boolean;
}

function pickCaption({
  state,
  stateColor,
  liveText,
  lastTurn,
  accentRec,
}: {
  state: DrivingState;
  stateColor: string;
  liveText: string;
  lastTurn: { who: 'user' | 'ai'; text: string } | null;
  accentRec: string;
}): CaptionData {
  if (state === 'recording') {
    return {
      label: 'YOU · LIVE',
      color: accentRec,
      text: liveText || 'Listening…',
      live: true,
    };
  }
  if (state === 'ai') {
    return { label: 'AI · READING ALOUD', color: stateColor, text: liveText || '…', live: true };
  }
  if (state === 'thinking') {
    return { label: 'THINKING', color: stateColor, text: '…', live: false };
  }
  if (lastTurn) {
    return {
      label: lastTurn.who === 'user' ? 'YOU · LAST' : 'AI · LAST',
      color: HIFI.ink3,
      text: lastTurn.text || '—',
      live: false,
    };
  }
  return {
    label: 'READY',
    color: HIFI.ink3,
    text: 'Tap to start. Tap again to stop.',
    live: false,
  };
}

function Caption({
  caption,
  baseFont,
  replySource,
  error,
  sttSupported,
}: {
  caption: CaptionData;
  baseFont: string;
  replySource: ReplyResult['source'] | null;
  error: string | null;
  sttSupported: boolean;
}) {
  const showStubBadge = caption.label === 'AI · READING ALOUD' && replySource === 'stub';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 96 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.6,
          color: caption.color,
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {caption.live && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: caption.color,
              animation: 'pulseDot 1.2s ease-in-out infinite',
              boxShadow: `0 0 6px ${caption.color}`,
            }}
          />
        )}
        <span style={{ flex: 1 }}>{caption.label}</span>
        {showStubBadge && (
          <span style={{ color: HIFI.ink3, fontSize: 9, letterSpacing: 1.2, fontWeight: 600 }}>
            STUB
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 16,
          lineHeight: 1.5,
          color: HIFI.ink,
          fontWeight: 400,
          fontFamily: baseFont,
          wordBreak: 'break-word',
        }}
      >
        {caption.text}
        {caption.live && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 16,
              background: caption.color,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'caret 0.9s step-end infinite',
            }}
          />
        )}
      </div>
      {(error || !sttSupported) && (
        <div
          style={{
            marginTop: 10,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            letterSpacing: 1,
            color: '#ef6155',
            fontWeight: 600,
          }}
        >
          {!sttSupported
            ? 'SPEECH RECOGNITION UNAVAILABLE — USE CHROME / EDGE'
            : `STT ERROR · ${error}`}
        </div>
      )}
    </div>
  );
}

function PTTButton({
  onTap,
  state,
  stateColor,
  stateGlow,
  label,
  accentRec: _accentRec,
}: {
  onTap: () => void;
  state: DrivingState;
  stateColor: string;
  stateGlow: string;
  label: string;
  accentRec: string;
}) {
  const [pressed, setPressed] = useState(false);
  const disabled = state === 'thinking';

  const isIdle = state === 'idle';
  const isRec = state === 'recording';
  const isAI = state === 'ai';

  const pressScale = pressed ? 0.94 : isRec ? 1.02 : 1;

  return (
    <button
      onClick={() => {
        if (disabled) return;
        try {
          navigator.vibrate && navigator.vibrate(18);
        } catch {
          // vibration unsupported — fine
        }
        onTap();
      }}
      onPointerDown={() => !disabled && setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      disabled={disabled}
      style={{
        position: 'relative',
        width: 208,
        height: 208,
        borderRadius: '50%',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
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
      }}
    >
      <ButtonAura active={isRec || isAI} color={stateColor} />
      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center' }}>
        <div style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>
          {isRec ? '■' : isAI ? '◉' : state === 'thinking' ? '◐' : '●'}
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.8,
            marginTop: 12,
          }}
        >
          {label}
        </div>
      </div>
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
