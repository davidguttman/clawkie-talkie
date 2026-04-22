import { useState, type ReactNode } from 'react';
import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';
import type { Settings, ProviderId, ApiKeyStatus } from '../storage';

// Ported from docs/design/hifi-screens.jsx. xAI key entry is real and
// writes straight to the localStorage-backed settings store via setSettings.
// Voice, speed, export format stay visible so the layout doesn't shift when
// they become real — but they're informational in V1.

const PROVIDERS: Record<
  ProviderId,
  { name: string; placeholder: string; consoleUrl: string; letter: string; glyphBg: string; glyphFg: string }
> = {
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

export function SettingsScreen({
  onBack,
  settings,
  setSettings,
  compact = false,
}: {
  onBack: () => void;
  settings: Settings;
  setSettings: (next: Settings) => void;
  compact?: boolean;
}) {
  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings({ ...settings, [k]: v });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="Settings" onBack={onBack} />
      <ScrollBody pad={compact ? 2 : 22}>
        <SettingsSection title="API KEY">
          <ApiKeyRow
            provider={settings.provider}
            setProvider={(v) => update('provider', v)}
            keys={settings.apiKeys}
            setKey={(p, v) => {
              const nextStatus: ApiKeyStatus = v ? 'ok' : 'unset';
              setSettings({
                ...settings,
                apiKeys: { ...settings.apiKeys, [p]: v },
                apiKeyStatuses: { ...settings.apiKeyStatuses, [p]: nextStatus },
              });
            }}
            statuses={settings.apiKeyStatuses}
            compact={compact}
          />
        </SettingsSection>

        <SettingsSection title="VOICE">
          <SettingsRow label="AI voice" value={settings.voice} compact={compact} />
          <SliderRow
            label="Speaking speed"
            value={settings.speed}
            setValue={(v) => update('speed', v)}
            min={0.75}
            max={1.5}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
          />
        </SettingsSection>

        <SettingsSection title="EXPORT">
          <SegmentedRow
            label="Format"
            value={settings.format}
            setValue={(v) => update('format', v)}
            options={[
              { id: 'md', label: 'Markdown' },
              { id: 'txt', label: 'Text' },
              { id: 'json', label: 'JSON' },
            ]}
            compact={compact}
          />
          <ToggleRow
            label="Include timestamps"
            value={settings.timestamps}
            setValue={(v) => update('timestamps', v)}
          />
        </SettingsSection>

      </ScrollBody>

      {/* Anchored footer — stays visible at the bottom of the screen so the
          lower mobile zone reads as an intentional surface rather than empty
          space. */}
      <div
        style={{
          borderTop: `1px solid ${HIFI.stroke}`,
          background: HIFI.surface,
          padding: '12px 4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          letterSpacing: 1.2,
          color: HIFI.ink2,
          fontWeight: 600,
          boxSizing: 'border-box',
          maxWidth: '100%',
        }}
      >
        <span>CLAWKIE-TALKIE</span>
        <span style={{ color: HIFI.ink3 }}>PHASE 0</span>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          letterSpacing: 1.6,
          color: HIFI.ink2,
          fontWeight: 700,
          marginBottom: 10,
          paddingLeft: 2,
        }}
      >
        {title}
      </div>
      <div
        style={{
          background: HIFI.surface,
          borderRadius: 14,
          border: `1px solid ${HIFI.stroke}`,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SettingsRow({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  // On narrow phones, stack label above value so neither has to fight for
  // horizontal room. On desktop, keep the hi-fi's inline label · value row.
  if (compact) {
    return (
      <div
        style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${HIFI.stroke}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
        }}
      >
        <div style={{ fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans }}>
          {label}
        </div>
        <div
          style={{
            fontSize: 12,
            color: HIFI.ink2,
            fontFamily: HIFI.fonts.mono,
            letterSpacing: 0.4,
            wordBreak: 'break-word',
          }}
        >
          {value}
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        padding: '13px 14px',
        borderBottom: `1px solid ${HIFI.stroke}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 13,
          color: HIFI.ink,
          fontFamily: HIFI.fonts.sans,
          flexShrink: 0,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: HIFI.ink2,
          fontFamily: HIFI.fonts.mono,
          letterSpacing: 0.4,
          textAlign: 'right',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ApiKeyRow({
  provider,
  setProvider,
  keys,
  setKey,
  statuses,
  compact,
}: {
  provider: ProviderId;
  setProvider: (v: ProviderId) => void;
  keys: Record<ProviderId, string>;
  setKey: (p: ProviderId, v: string) => void;
  statuses: Record<ProviderId, ApiKeyStatus>;
  compact?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);

  const cfg = PROVIDERS[provider];
  const value = keys[provider] || '';
  // Derive status from the value first — a present key can't read as NOT SET.
  // The stored status is only respected when it's actively telling us something
  // more specific (in-flight check or a known-invalid flag from a future phase).
  const stored = statuses[provider];
  const status: ApiKeyStatus = value
    ? stored === 'checking' || stored === 'invalid'
      ? stored
      : 'ok'
    : 'unset';
  const last4 = value.slice(-4);

  const statusConfig: Record<ApiKeyStatus, { color: string; label: string; dot: boolean }> = {
    unset: { color: HIFI.ink3, label: 'NOT SET', dot: false },
    checking: { color: '#ff9e3b', label: 'CHECKING', dot: true },
    ok: { color: '#4ed29a', label: 'SAVED', dot: true },
    invalid: { color: '#ef6155', label: 'INVALID', dot: true },
  };
  const sc = statusConfig[status];

  return (
    <div style={{ padding: '14px 14px 12px' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: compact ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: compact ? 'stretch' : 'center',
          marginBottom: 10,
          gap: compact ? 8 : 10,
          minWidth: 0,
        }}
      >
        <div style={{ position: 'relative', minWidth: 0 }}>
          <button
            onClick={() => setDropOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 11px',
              borderRadius: 8,
              background: HIFI.surface2,
              border: `1px solid ${HIFI.stroke}`,
              color: HIFI.ink,
              cursor: 'pointer',
              fontFamily: HIFI.fonts.sans,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <ProviderGlyph cfg={cfg} />
            <span>{cfg.name}</span>
            <span style={{ color: HIFI.ink3, fontSize: 9, marginLeft: 2 }}>▾</span>
          </button>
          {dropOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                background: HIFI.surface2,
                border: `1px solid ${HIFI.strokeStrong}`,
                borderRadius: 10,
                padding: 4,
                zIndex: 10,
                boxShadow: '0 8px 20px rgba(0,0,0,0.45)',
                minWidth: 180,
              }}
            >
              {(Object.entries(PROVIDERS) as [ProviderId, (typeof PROVIDERS)[ProviderId]][]).map(
                ([id, p]) => {
                  const on = provider === id;
                  const hasKey = !!keys[id];
                  return (
                    <button
                      key={id}
                      onClick={() => {
                        setProvider(id);
                        setDropOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 7,
                        background: on ? HIFI.ink + '14' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: HIFI.ink,
                        textAlign: 'left',
                        fontFamily: HIFI.fonts.sans,
                        fontSize: 13,
                      }}
                    >
                      <ProviderGlyph cfg={p} />
                      <span style={{ flex: 1 }}>{p.name}</span>
                      {hasKey && (
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: '50%',
                            background: '#4ed29a',
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </button>
                  );
                },
              )}
            </div>
          )}
        </div>

        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 9,
            letterSpacing: 1.2,
            fontWeight: 700,
            color: sc.color,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {sc.dot && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: sc.color,
                boxShadow: `0 0 6px ${sc.color}`,
                animation:
                  status === 'checking' ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
              }}
            />
          )}
          {sc.label}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: compact ? 'column' : 'row',
          alignItems: 'stretch',
          gap: 8,
          marginBottom: 10,
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            background: HIFI.surface2,
            borderRadius: 10,
            border: `1px solid ${focus ? '#ff9e3b' : HIFI.stroke}`,
            padding: '12px 14px',
            transition: 'border-color 150ms',
            minWidth: 0,
          }}
        >
          <input
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => setKey(provider, e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder={cfg.placeholder}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: HIFI.ink,
              fontFamily: HIFI.fonts.mono,
              fontSize: 13,
              letterSpacing: 0.3,
            }}
          />
        </div>
        <button
          onClick={() => setReveal((r) => !r)}
          style={{
            padding: compact ? '10px 14px' : '0 14px',
            minWidth: compact ? 0 : 56,
            width: compact ? '100%' : 'auto',
            background: 'transparent',
            border: `1px solid ${HIFI.stroke}`,
            borderRadius: 10,
            color: HIFI.ink2,
            cursor: 'pointer',
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.2,
          }}
        >
          {reveal ? 'HIDE KEY' : 'SHOW KEY'}
        </button>
      </div>

      {value && !reveal && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 10,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            letterSpacing: 0.8,
          }}
        >
          <span style={{ color: HIFI.ink3 }}>ENDS IN</span>
          <span style={{ color: HIFI.ink2, letterSpacing: 1.4, fontWeight: 600 }}>
            …{last4}
          </span>
        </div>
      )}

      <div
        style={{
          fontFamily: HIFI.fonts.sans,
          fontSize: 12,
          color: HIFI.ink2,
          lineHeight: 1.55,
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          minWidth: 0,
        }}
      >
        Stored on this device only, never sent anywhere except {cfg.name}.
        <br />
        <a
          href={cfg.consoleUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            color: '#ff9e3b',
            textDecoration: 'none',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          Get a key ↗
        </a>
      </div>
    </div>
  );
}

function ProviderGlyph({
  cfg,
}: {
  cfg: { letter: string; glyphBg: string; glyphFg: string };
}) {
  return (
    <span
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        background: cfg.glyphBg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: HIFI.fonts.sans,
        fontWeight: 700,
        color: cfg.glyphFg,
        fontSize: 10,
        flexShrink: 0,
      }}
    >
      {cfg.letter}
    </span>
  );
}

function ToggleRow({
  label,
  sub,
  value,
  setValue,
}: {
  label: string;
  sub?: string;
  value: boolean;
  setValue: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        padding: '13px 14px',
        borderBottom: `1px solid ${HIFI.stroke}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans }}>{label}</div>
        {sub && (
          <div
            style={{
              fontSize: 11,
              color: HIFI.ink3,
              fontFamily: HIFI.fonts.sans,
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      <button
        onClick={() => setValue(!value)}
        style={{
          width: 40,
          height: 24,
          borderRadius: 12,
          position: 'relative',
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
          background: value ? '#ff9e3b' : HIFI.surface2,
          boxShadow: value ? '0 0 10px rgba(255,158,59,0.4)' : 'none',
          transition: 'background 200ms',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 18 : 2,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: value ? '#000' : HIFI.ink3,
            transition: 'left 200ms',
          }}
        />
      </button>
    </div>
  );
}

function SliderRow({
  label,
  value,
  setValue,
  min,
  max,
  step,
  format,
}: {
  label: string;
  value: number;
  setValue: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}) {
  return (
    <div style={{ padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: HIFI.ink, fontFamily: HIFI.fonts.sans }}>{label}</div>
        <div
          style={{
            fontSize: 12,
            color: '#ff9e3b',
            fontFamily: HIFI.fonts.mono,
            fontWeight: 600,
          }}
        >
          {format ? format(value) : value}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setValue(parseFloat(e.target.value))}
        style={{
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          accentColor: '#ff9e3b',
          display: 'block',
          margin: 0,
        }}
      />
    </div>
  );
}

function SegmentedRow<T extends string>({
  label,
  value,
  setValue,
  options,
  compact,
}: {
  label: string;
  value: T;
  setValue: (v: T) => void;
  options: { id: T; label: string }[];
  compact?: boolean;
}) {
  // On narrow phones the single-row segmented control can't fit three
  // labels comfortably. Reflow to a vertical list of full-width buttons —
  // same pick-one semantics, just stacked.
  return (
    <div style={{ padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}` }}>
      <div
        style={{
          fontSize: 13,
          color: HIFI.ink,
          fontFamily: HIFI.fonts.sans,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: compact ? 'column' : 'row',
          gap: compact ? 6 : 4,
          padding: compact ? 0 : 3,
          borderRadius: 10,
          background: compact ? 'transparent' : HIFI.surface2,
          border: compact ? 'none' : `1px solid ${HIFI.stroke}`,
          minWidth: 0,
        }}
      >
        {options.map((o) => {
          const on = value === o.id;
          return (
            <button
              key={o.id}
              onClick={() => setValue(o.id)}
              style={{
                flex: compact ? 'none' : 1,
                width: compact ? '100%' : 'auto',
                minWidth: 0,
                padding: compact ? '10px 12px' : '7px 6px',
                borderRadius: compact ? 9 : 7,
                background: on ? HIFI.ink : compact ? HIFI.surface2 : 'transparent',
                color: on ? '#000' : HIFI.ink2,
                border: compact ? `1px solid ${on ? HIFI.ink : HIFI.stroke}` : 'none',
                cursor: 'pointer',
                fontFamily: HIFI.fonts.mono,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: 'uppercase',
                transition: 'all 160ms',
                textAlign: compact ? 'left' : 'center',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
