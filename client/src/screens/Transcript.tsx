import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';

export function TranscriptScreen({
  sessionId,
  onBack,
  compact = false,
}: {
  sessionId?: string;
  onBack: () => void;
  compact?: boolean;
}) {
  const subtitle = sessionId ? compactSessionLabel(sessionId) : 'NO SESSION';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="Transcript" subtitle={subtitle} onBack={onBack} />
      <ScrollBody pad={compact ? 2 : 22} column>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 12,
            padding: '24px 10px',
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              border: `1px solid ${HIFI.stroke}`,
              background: HIFI.surface,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: HIFI.ink3,
              fontFamily: HIFI.fonts.mono,
              fontSize: 22,
            }}
          >
            ↺
          </div>
          <div
            style={{
              fontFamily: HIFI.fonts.mono,
              fontSize: 15,
              fontWeight: 700,
              color: HIFI.ink,
              letterSpacing: 0.4,
            }}
          >
            Transcript is not stored here
          </div>
          <div
            style={{
              fontFamily: HIFI.fonts.sans,
              fontSize: 13,
              lineHeight: 1.5,
              color: HIFI.ink2,
              maxWidth: 300,
            }}
          >
            Voice turns are posted through the daemon to the bound OpenClaw
            session target. This phone only keeps the active driving controls.
          </div>
        </div>
      </ScrollBody>
    </div>
  );
}

function compactSessionLabel(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 22) return trimmed.toUpperCase();
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-8)}`.toUpperCase();
}
