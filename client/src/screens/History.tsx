import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';

export function HistoryScreen({
  onBack,
  compact = false,
}: {
  onBack: () => void;
  compact?: boolean;
}) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="History" subtitle="LOCAL DEVICE" onBack={onBack} />
      <ScrollBody pad={compact ? 2 : 22} column>
        <EmptyState
          title="No local history"
          body="Clawkie-Talkie does not keep a local session archive on this phone. Conversation records stay with the OpenClaw session target."
        />
      </ScrollBody>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
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
        ≡
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
        {title}
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
        {body}
      </div>
    </div>
  );
}
