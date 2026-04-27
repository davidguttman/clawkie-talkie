import type { ReactNode } from 'react';
import { HIFI } from '../tokens';

// iPhone-ish dark OLED frame. Ported from docs/design/hifi-phone.jsx.
export function HiFiPhone({
  children,
  width = 390,
  height = 844,
}: {
  children: ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 52,
        background: '#000',
        padding: 9,
        boxShadow:
          '0 0 0 1.5px #1e1e22, 0 40px 80px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.04) inset',
        position: 'relative',
        fontFamily: HIFI.fonts.sans,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 44,
          overflow: 'hidden',
          background: HIFI.bg,
          position: 'relative',
          color: HIFI.ink,
        }}
      >
        {/* dynamic island */}
        <div
          style={{
            position: 'absolute',
            top: 11,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 122,
            height: 36,
            borderRadius: 22,
            background: '#000',
            zIndex: 50,
          }}
        />
        {/* status bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 54,
            zIndex: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 30px',
            paddingTop: 16,
            fontFamily: HIFI.fonts.mono,
            fontSize: 14,
            fontWeight: 600,
            color: HIFI.ink,
          }}
        >
          <span>9:41</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
            <svg width="16" height="11" viewBox="0 0 16 11">
              <path d="M1 10V8 M5 10V6 M9 10V4 M13 10V1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <svg width="22" height="11" viewBox="0 0 22 11">
              <rect x="0.5" y="0.5" width="18" height="10" rx="2.5" fill="none" stroke="currentColor" opacity="0.5" />
              <rect x="2" y="2" width="15" height="7" rx="1.2" fill="currentColor" />
            </svg>
          </span>
        </div>
        <div style={{ position: 'absolute', inset: 0, paddingTop: 54, paddingBottom: 20 }}>{children}</div>
        {/* home indicator */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 134,
            height: 5,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.85)',
          }}
        />
      </div>
    </div>
  );
}

export function ButtonAura({
  active,
  color,
  intensity = 1,
}: {
  active: boolean;
  color: string;
  intensity?: number;
}) {
  if (!active) return null;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          inset: -28,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${color} 0%, transparent 70%)`,
          opacity: 0.55 * intensity,
          filter: 'blur(6px)',
          animation: 'auraBreathe 1.6s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: -56,
          borderRadius: '50%',
          border: `1.5px solid ${color}`,
          opacity: 0.3,
          animation: 'auraPulse 1.8s ease-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: -84,
          borderRadius: '50%',
          border: `1px solid ${color}`,
          opacity: 0.15,
          animation: 'auraPulse 1.8s ease-out infinite 0.4s',
        }}
      />
    </>
  );
}

export function LiveWave({
  intensities,
  color,
  width = 260,
  height = 40,
}: {
  intensities: number[];
  color: string;
  width?: number | string;
  height?: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        width,
        maxWidth: '100%',
        height,
        minWidth: 0,
      }}
    >
      {intensities.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            minWidth: 0,
            background: color,
            height: `${Math.max(6, v * 100)}%`,
            borderRadius: 2,
            transition: 'height 40ms ease-out',
            boxShadow: `0 0 8px ${color}66`,
          }}
        />
      ))}
    </div>
  );
}
