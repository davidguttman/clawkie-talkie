import { type ReactNode } from 'react';
import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';
import { VOICE_IDS, VOICE_LABELS, type Settings } from '../storage';

// xAI API keys are NOT stored on the phone — the daemon holds the key via
// the repo-root `.env`. This screen only edits on-device voice / export
// preferences.

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
        <SettingsSection title="VOICE">
          <SegmentedRow
            label="AI voice"
            value={settings.voice}
            setValue={(v) => update('voice', v)}
            options={VOICE_IDS.map((id) => ({ id, label: VOICE_LABELS[id] }))}
            compact={compact}
          />
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
