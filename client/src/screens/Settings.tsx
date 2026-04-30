import { useEffect, type ReactNode } from 'react';
import { HIFI } from '../tokens';
import { ScreenHeader, ScrollBody } from '../components/ScreenChrome';
import type { Settings } from '../storage';
import type { SttCatalog, SttSelection, TtsCatalog, TtsSelection } from '../voice/protocol';

// TTS provider credentials are NOT stored on the phone — OpenClaw owns
// provider auth. This screen only edits on-device voice / export preferences.

export const DEFAULT_PROVIDER_OPTION_ID = '__default__';
const STALE_PROVIDER_OPTION_ID = '__saved_provider__';

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

export interface SttProviderOption {
  id: string;
  label: string;
  configured: boolean;
  selected: boolean;
  available: boolean;
  selectable: boolean;
  models: string[];
}

export function SettingsScreen({
  onBack,
  settings,
  setSettings,
  ttsCatalog,
  onRefreshTtsCatalog,
  sttCatalog,
  onRefreshSttCatalog,
  compact = false,
}: {
  onBack: () => void;
  settings: Settings;
  setSettings: (next: Settings) => void;
  ttsCatalog: TtsCatalog | null;
  onRefreshTtsCatalog?: () => void;
  sttCatalog: SttCatalog | null;
  onRefreshSttCatalog?: () => void;
  compact?: boolean;
}) {
  useEffect(() => {
    if (!ttsCatalog) onRefreshTtsCatalog?.();
  }, [ttsCatalog, onRefreshTtsCatalog]);
  useEffect(() => {
    if (!sttCatalog) onRefreshSttCatalog?.();
  }, [sttCatalog, onRefreshSttCatalog]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings({ ...settings, [k]: v });
  const updateTtsSelection = (selection: TtsSelection) =>
    setSettings(withTtsSelection(settings, selection));
  const updateSttSelection = (selection: SttSelection) =>
    setSettings(withSttSelection(settings, selection));

  const providerOptions = configuredTtsProviders(ttsCatalog);
  const currentProvider = providerForSelection(providerOptions, settings.tts);
  const ttsProviderValue = ttsProviderValueForSelection(providerOptions, settings.tts);
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
  const statusText = ttsCatalogStatusText(
    ttsCatalog,
    currentProvider,
    isDefaultTtsSelection(settings.tts),
  );

  const sttProviderOptions = configuredSttProviders(sttCatalog);
  const currentSttProvider = sttProviderForSelection(sttProviderOptions, settings.stt);
  const sttProviderValue = sttProviderValueForSelection(sttProviderOptions, settings.stt);
  const effectiveSttSelection: SttSelection = currentSttProvider
    ? {
        providerId: currentSttProvider.id,
        ...(preferredSttModel(currentSttProvider, settings.stt)
          ? { model: preferredSttModel(currentSttProvider, settings.stt) }
          : {}),
      }
    : settings.stt;
  const sttStatusText = sttCatalogStatusText(
    sttCatalog,
    currentSttProvider,
    isDefaultSttSelection(settings.stt),
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: HIFI.ink }}>
      <ScreenHeader title="Settings" onBack={onBack} />
      <ScrollBody pad={compact ? 2 : 22}>
        <SettingsSection title="TRANSCRIPTION">
          <SelectRow
            label="Provider"
            value={sttProviderValue}
            setValue={(providerId) => {
              if (providerId === DEFAULT_PROVIDER_OPTION_ID) {
                updateSttSelection({});
                return;
              }
              const provider = sttProviderOptions.find((option) => option.id === providerId);
              if (!provider?.selectable) return;
              updateSttSelection(nextSttSelectionAfterProviderChange(provider, settings.stt));
            }}
            options={[
              { id: DEFAULT_PROVIDER_OPTION_ID, label: 'Default' },
              ...staleProviderOption(settings.stt, currentSttProvider, sttProviderOptions),
              ...(sttProviderOptions.length > 0
                ? sttProviderOptions.map((provider) => ({
                    id: provider.id,
                    label: provider.label,
                    disabled: !provider.selectable,
                  }))
                : [{ id: '', label: 'Loading from daemon...', disabled: true }]),
            ]}
          />
          {currentSttProvider && currentSttProvider.models.length > 1 && (
            <SelectRow
              label="Model"
              value={effectiveSttSelection.model ?? currentSttProvider.models[0] ?? ''}
              setValue={(model) => {
                if (!currentSttProvider.selectable) return;
                updateSttSelection(nextSttSelectionAfterModelChange(effectiveSttSelection, model));
              }}
              options={currentSttProvider.models.map((model) => ({ id: model, label: model }))}
              disabled={!currentSttProvider.selectable}
            />
          )}
          <StatusRow text={sttStatusText} onRefresh={onRefreshSttCatalog} />
        </SettingsSection>

        <SettingsSection title="VOICE">
          <SelectRow
            label="Provider"
            value={ttsProviderValue}
            setValue={(providerId) => {
              if (providerId === DEFAULT_PROVIDER_OPTION_ID) {
                updateTtsSelection({});
                return;
              }
              const provider = providerOptions.find((option) => option.id === providerId);
              if (!provider?.selectable) return;
              updateTtsSelection(nextTtsSelectionAfterProviderChange(provider, settings.tts));
            }}
            options={[
              { id: DEFAULT_PROVIDER_OPTION_ID, label: 'Default' },
              ...staleProviderOption(settings.tts, currentProvider, providerOptions),
              ...(providerOptions.length > 0
                ? providerOptions.map((provider) => ({
                    id: provider.id,
                    label: providerSelectLabel(provider),
                    disabled: !provider.selectable,
                  }))
                : [{ id: '', label: 'Loading from daemon...', disabled: true }]),
            ]}
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
          {currentProvider && (
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
          )}
          <StatusRow text={statusText} onRefresh={onRefreshTtsCatalog} />
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
      selectable:
        provider.configured
        && provider.available
        && (provider.models.length > 0 || provider.voices.length > 0),
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
  const provider = providerForSelection(providers, selection);
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

export function withSttSelection(settings: Settings, selection: SttSelection): Settings {
  return { ...settings, stt: selection };
}

export function isDefaultTtsSelection(selection: TtsSelection): boolean {
  return !selection.providerId && !selection.model && !selection.voice;
}

export function isDefaultSttSelection(selection: SttSelection): boolean {
  return !selection.providerId && !selection.model;
}

export function ttsProviderValueForSelection(
  providers: TtsProviderOption[],
  selection: TtsSelection,
): string {
  return providerForSelection(providers, selection)?.id
    ?? selection.providerId
    ?? (isDefaultTtsSelection(selection) ? undefined : STALE_PROVIDER_OPTION_ID)
    ?? DEFAULT_PROVIDER_OPTION_ID;
}

export function sttProviderValueForSelection(
  providers: SttProviderOption[],
  selection: SttSelection,
): string {
  return sttProviderForSelection(providers, selection)?.id
    ?? selection.providerId
    ?? (isDefaultSttSelection(selection) ? undefined : STALE_PROVIDER_OPTION_ID)
    ?? DEFAULT_PROVIDER_OPTION_ID;
}

export function configuredSttProviders(catalog: SttCatalog | null): SttProviderOption[] {
  if (!catalog) return [];
  return catalog.providers
    .map((provider) => {
      const selectable = provider.configured && provider.available && provider.models.length > 0;
      const baseLabel = provider.name || provider.id;
      const label = provider.configured && provider.available && provider.models.length === 0
        ? `${baseLabel} (no model)`
        : baseLabel;
      return {
        id: provider.id,
        label,
        configured: provider.configured,
        selected: provider.selected || provider.id === catalog.activeProvider,
        available: provider.available,
        selectable,
        models: [...provider.models],
      };
    })
    .sort((a, b) => providerRank(a) - providerRank(b)
      || Number(b.selected) - Number(a.selected)
      || a.label.localeCompare(b.label));
}

export function nextSttSelectionAfterProviderChange(
  provider: SttProviderOption,
  current: SttSelection = {},
): SttSelection {
  if (!provider.selectable) return { ...current };
  const model = preferredSttModel(provider, current);
  return {
    providerId: provider.id,
    ...(model ? { model } : {}),
  };
}

export function nextSttSelectionAfterModelChange(
  selection: SttSelection,
  model: string,
): SttSelection {
  return {
    ...selection,
    model,
  };
}

export function ttsCatalogStatusText(
  catalog: TtsCatalog | null,
  provider: TtsProviderOption | undefined,
  isDefaultSelection = false,
): string {
  if (isDefaultSelection) return 'OpenClaw will choose voice defaults';
  if (!catalog) return 'Connect to daemon to load voices';
  if (!provider?.selectable) return 'Provider unavailable';
  return 'Loaded from daemon';
}

export function sttCatalogStatusText(
  catalog: SttCatalog | null,
  provider: SttProviderOption | undefined,
  isDefaultSelection = false,
): string {
  if (isDefaultSelection) return 'OpenClaw will choose transcription defaults';
  if (!catalog) return 'Connect to daemon to load transcription providers';
  if (provider && provider.models.length === 0) return 'Transcription provider has no selectable models';
  if (!provider?.selectable) return 'Transcription provider unavailable';
  return 'Loaded from daemon';
}

function sttProviderForSelection(
  providers: SttProviderOption[],
  selection: SttSelection,
): SttProviderOption | undefined {
  if (!selection.providerId) return undefined;
  return providers.find((provider) => provider.id === selection.providerId);
}

function preferredSttModel(provider: SttProviderOption, selection: SttSelection): string | undefined {
  if (selection.model && provider.models.includes(selection.model)) return selection.model;
  return provider.models[0];
}

export function providerSelectLabel(provider: TtsProviderOption): string {
  if (
    provider.configured
    && provider.available
    && provider.models.length === 0
    && provider.voices.length === 0
  ) {
    return `${provider.label} (no voices)`;
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
  selection: TtsSelection,
): TtsProviderOption | undefined {
  if (!selection.providerId) return undefined;
  return providers.find((provider) => provider.id === selection.providerId);
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

function staleProviderOption<T extends { id: string }>(
  selection: { providerId?: string; model?: string; voice?: string },
  currentProvider: T | undefined,
  providerOptions: T[],
): Array<{ id: string; label: string; disabled: true }> {
  const providerId = selection.providerId;
  if (!providerId || currentProvider || providerOptions.some((provider) => provider.id === providerId)) {
    if (!providerId && (selection.model || selection.voice)) {
      return [{ id: STALE_PROVIDER_OPTION_ID, label: 'Saved selection (unavailable)', disabled: true }];
    }
    return [];
  }
  return [{ id: providerId, label: `${providerId} (unavailable)`, disabled: true }];
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
