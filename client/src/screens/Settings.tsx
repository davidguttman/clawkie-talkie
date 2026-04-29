import { useEffect, type ReactNode } from 'react';
import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';
import type { Settings } from '../storage';
import type { TtsCatalog, TtsSelection } from '../voice/protocol';

// TTS provider credentials are NOT stored on the phone — OpenClaw owns
// provider auth. This screen only edits on-device voice / export preferences.

export interface TtsVoiceOption {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface TtsProviderOption {
  id: string;
  label: string;
  configured: boolean;
  selected: boolean;
  available: boolean;
  selectable: boolean;
  models: string[];
  voices: TtsVoiceOption[];
}

export function SettingsScreen({
  onBack,
  settings,
  setSettings,
  ttsCatalog,
  onRefreshTtsCatalog,
  compact = false,
}: {
  onBack: () => void;
  settings: Settings;
  setSettings: (next: Settings) => void;
  ttsCatalog: TtsCatalog | null;
  onRefreshTtsCatalog?: () => void;
  compact?: boolean;
}) {
  useEffect(() => {
    if (!ttsCatalog) onRefreshTtsCatalog?.();
  }, [ttsCatalog, onRefreshTtsCatalog]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings({ ...settings, [k]: v });
  const updateTtsSelection = (selection: TtsSelection) =>
    setSettings(withTtsSelection(settings, selection));

  const providerOptions = configuredTtsProviders(ttsCatalog);
  const currentProvider = providerForSelection(providerOptions, ttsCatalog, settings.tts);
  const effectiveSelection: TtsSelection = currentProvider
    ? {
        providerId: currentProvider.id,
        model: preferredModel(currentProvider, settings.tts),
        voice: preferredVoice(currentProvider, settings.tts),
      }
    : settings.tts;
  const voiceOptions = voicesForSelection(ttsCatalog, effectiveSelection);
  const selectedVoice = voiceOptions.some((voice) => voice.id === effectiveSelection.voice)
    ? effectiveSelection.voice ?? ''
    : voiceOptions[0]?.id ?? '';
  const statusText = !ttsCatalog
    ? 'Connect to daemon to load voices'
    : currentProvider && currentProvider.models.length === 0
      ? 'Provider has no selectable models'
      : !currentProvider?.selectable
        ? 'Provider unavailable'
        : 'Loaded from daemon';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="Settings" onBack={onBack} />
      <ScrollBody pad={compact ? 2 : 22}>
        <SettingsSection title="VOICE">
          <SelectRow
            label="Provider"
            value={currentProvider?.id ?? ''}
            setValue={(providerId) => {
              const provider = providerOptions.find((option) => option.id === providerId);
              if (!provider?.selectable) return;
              updateTtsSelection(nextTtsSelectionAfterProviderChange(provider, settings.tts));
            }}
            options={providerOptions.length > 0
              ? providerOptions.map((provider) => ({
                  id: provider.id,
                  label: providerSelectLabel(provider),
                  disabled: !provider.selectable,
                }))
              : [{ id: '', label: 'Loading from daemon…', disabled: true }]}
            disabled={!ttsCatalog || providerOptions.length === 0}
          />
          {currentProvider && currentProvider.models.length > 1 && (
            <SelectRow
              label="Model"
              value={effectiveSelection.model ?? currentProvider.models[0] ?? ''}
              setValue={(model) => {
                if (!currentProvider.selectable) return;
                updateTtsSelection({
                  providerId: currentProvider.id,
                  model,
                  voice: preferredVoice(currentProvider, settings.tts),
                });
              }}
              options={currentProvider.models.map((model) => ({ id: model, label: model }))}
              disabled={!currentProvider.selectable}
            />
          )}
          <SelectRow
            label="Voice"
            value={selectedVoice}
            setValue={(voiceId) => {
              if (!currentProvider?.selectable) return;
              const voice = voiceOptions.find((option) => option.id === voiceId);
              if (!voice || voice.disabled) return;
              updateTtsSelection(nextTtsSelectionAfterVoiceChange(effectiveSelection, voice));
            }}
            options={voiceOptions.length > 0
              ? voiceOptions
              : [{ id: '', label: 'No voices available', disabled: true }]}
            disabled={!currentProvider?.selectable || voiceOptions.every((voice) => voice.disabled)}
          />
          <StatusRow text={statusText} onRefresh={onRefreshTtsCatalog} />
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

export function configuredTtsProviders(catalog: TtsCatalog | null): TtsProviderOption[] {
  if (!catalog) return [];
  return catalog.providers
    .map((provider) => ({
      id: provider.id,
      label: provider.name || provider.id,
      configured: provider.configured,
      selected: provider.selected || provider.id === catalog.activeProvider,
      available: provider.available,
      selectable: provider.configured && provider.available && provider.models.length > 0,
      models: [...provider.models],
      voices: provider.voices.map((voice) => ({ id: voice.id, label: voice.name || voice.id })),
    }))
    .sort((a, b) => providerRank(a) - providerRank(b)
      || Number(b.selected) - Number(a.selected)
      || a.label.localeCompare(b.label));
}

export function voicesForSelection(
  catalog: TtsCatalog | null,
  selection: TtsSelection,
): TtsVoiceOption[] {
  if (!catalog) {
    return selection.voice ? [{ id: selection.voice, label: selection.voice, disabled: true }] : [];
  }

  const providers = configuredTtsProviders(catalog);
  const provider = providerForSelection(providers, catalog, selection);
  if (!provider) {
    return selection.voice ? [{ id: selection.voice, label: selection.voice, disabled: true }] : [];
  }

  return provider.voices.map((voice) => ({
    ...voice,
    disabled: !provider.selectable || voice.disabled,
  }));
}

export function nextTtsSelectionAfterProviderChange(
  provider: TtsProviderOption,
  current: TtsSelection = {},
): TtsSelection {
  if (!provider.selectable) return { ...current };
  return {
    providerId: provider.id,
    ...(preferredModel(provider, current) ? { model: preferredModel(provider, current) } : {}),
    ...(preferredVoice(provider, current) ? { voice: preferredVoice(provider, current) } : {}),
  };
}

export function nextTtsSelectionAfterVoiceChange(
  selection: TtsSelection,
  voice: TtsVoiceOption,
): TtsSelection {
  return {
    ...selection,
    voice: voice.id,
  };
}

export function withLegacyVoiceSelection(settings: Settings, voice: string): Settings {
  return withTtsSelection(settings, { ...settings.tts, voice });
}

export function withTtsSelection(settings: Settings, selection: TtsSelection): Settings {
  return {
    ...settings,
    voice: selection.voice ?? '',
    tts: selection,
  };
}

function providerSelectLabel(provider: TtsProviderOption): string {
  if (provider.configured && provider.available && provider.models.length === 0) {
    return `${provider.label} (no models)`;
  }
  return provider.label;
}

function providerRank(
  provider: Pick<TtsProviderOption, 'selectable' | 'configured' | 'available'>,
): number {
  if (provider.selectable) return 0;
  if (provider.configured && provider.available) return 1;
  if (provider.configured) return 2;
  if (provider.available) return 3;
  return 4;
}

function providerForSelection(
  providers: TtsProviderOption[],
  catalog: TtsCatalog | null,
  selection: TtsSelection,
): TtsProviderOption | undefined {
  return providers.find((provider) => provider.id === selection.providerId)
    ?? providers.find((provider) => provider.selected)
    ?? providers.find((provider) => provider.id === catalog?.activeProvider)
    ?? providers.find((provider) => provider.selectable)
    ?? providers[0];
}

function preferredModel(provider: TtsProviderOption, selection: TtsSelection): string | undefined {
  if (selection.model && provider.models.includes(selection.model)) return selection.model;
  return provider.models[0];
}

function preferredVoice(provider: TtsProviderOption, selection: TtsSelection): string | undefined {
  if (selection.voice && provider.voices.some((voice) => voice.id === selection.voice)) {
    return selection.voice;
  }
  return provider.voices[0]?.id;
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

function SelectRow<T extends string>({
  label,
  value,
  setValue,
  options,
  disabled = false,
}: {
  label: string;
  value: T;
  setValue: (v: T) => void;
  options: { id: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}) {
  return (
    <div style={{ padding: '13px 14px', borderBottom: `1px solid ${HIFI.stroke}` }}>
      <label
        style={{
          display: 'block',
          fontSize: 13,
          color: HIFI.ink,
          fontFamily: HIFI.fonts.sans,
          marginBottom: 8,
        }}
      >
        {label}
      </label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value as T)}
        style={{
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          borderRadius: 9,
          border: `1px solid ${HIFI.stroke}`,
          background: disabled ? HIFI.surface2 : HIFI.surface,
          color: disabled ? HIFI.ink3 : HIFI.ink,
          fontFamily: HIFI.fonts.sans,
          fontSize: 13,
          padding: '9px 10px',
        }}
      >
        {options.map((option) => (
          <option key={option.id || option.label} value={option.id} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatusRow({ text, onRefresh }: { text: string; onRefresh?: () => void }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${HIFI.stroke}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
      }}
    >
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          letterSpacing: 1,
          color: HIFI.ink3,
          textTransform: 'uppercase',
        }}
      >
        {text}
      </div>
      {onRefresh && (
        <button
          onClick={onRefresh}
          style={{
            border: `1px solid ${HIFI.stroke}`,
            borderRadius: 8,
            background: HIFI.surface2,
            color: HIFI.ink2,
            cursor: 'pointer',
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1,
            padding: '6px 8px',
            textTransform: 'uppercase',
          }}
        >
          Refresh
        </button>
      )}
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
