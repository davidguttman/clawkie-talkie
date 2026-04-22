import type { ReactNode } from 'react';
import { HIFI } from '../tokens';

// Ported from docs/design/hifi-screens.jsx: shared phone-viewport chrome.

export function ScreenHeader({
  title,
  right,
  onBack,
  subtitle,
}: {
  title: string;
  right?: ReactNode;
  onBack?: () => void;
  subtitle?: string;
}) {
  return (
    <div
      style={{
        padding: '8px 22px 10px',
        borderBottom: `1px solid ${HIFI.stroke}`,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      {onBack && (
        <button
          onClick={onBack}
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'transparent',
            border: `1px solid ${HIFI.stroke}`,
            color: HIFI.ink,
            cursor: 'pointer',
            fontSize: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: HIFI.fonts.mono,
          }}
        >
          ‹
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 0.5,
            color: HIFI.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: 1.2,
              color: HIFI.ink3,
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}

export function ScrollBody({
  children,
  pad = 22,
  column = false,
}: {
  children: ReactNode;
  pad?: number;
  // When true, lays children out as a flex column so inline spacers can push
  // trailing elements to the bottom of the scroll region (used by Handoff).
  column?: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: `12px ${pad}px 20px`,
        display: column ? 'flex' : 'block',
        flexDirection: column ? 'column' : undefined,
        minHeight: 0,
      }}
    >
      {children}
    </div>
  );
}

export function DisabledRibbon({ label = 'PREVIEW — NOT LIVE IN V1' }: { label?: string }) {
  return (
    <div
      style={{
        padding: '9px 14px',
        margin: '10px 14px 0',
        borderRadius: 10,
        border: `1px dashed ${HIFI.strokeStrong}`,
        background: HIFI.surface,
        fontFamily: HIFI.fonts.mono,
        fontSize: 10,
        letterSpacing: 1.1,
        fontWeight: 700,
        color: HIFI.ink2,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {label}
    </div>
  );
}
