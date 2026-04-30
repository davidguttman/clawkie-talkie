import { describe, expect, it } from 'vitest';
import {
  configuredSttProviders,
  configuredTtsProviders,
  DEFAULT_PROVIDER_OPTION_ID,
  providerSelectLabel,
  isDefaultSttSelection,
  isDefaultTtsSelection,
  nextSttSelectionAfterModelChange,
  nextSttSelectionAfterProviderChange,
  nextTtsSelectionAfterProviderChange,
  nextTtsSelectionAfterVoiceChange,
  sttProviderValueForSelection,
  sttCatalogStatusText,
  ttsProviderValueForSelection,
  ttsCatalogStatusText,
  voicesForSelection,
  withLegacyVoiceSelection,
  withSttSelection,
  withTtsSelection,
} from '../client/src/screens/Settings';
import type { Settings } from '../client/src/storage';
import type { SttCatalog, TtsCatalog } from '../client/src/voice/protocol';

function catalog(overrides: Partial<TtsCatalog> = {}): TtsCatalog {
  return {
    activeProvider: 'openai',
    generatedAt: '2026-04-28T00:00:00.000Z',
    providers: [
      {
        id: 'unconfigured',
        name: 'Unconfigured',
        configured: false,
        selected: false,
        available: false,
        models: ['unconfigured-model'],
        voices: [{ id: 'ghost', name: 'Ghost' }],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        configured: true,
        selected: true,
        available: true,
        models: ['gpt-4o-mini-tts', 'gpt-4o-tts'],
        voices: [
          { id: 'alloy', name: 'Alloy' },
          { id: 'nova', name: 'Nova' },
        ],
      },
      {
        id: 'offline',
        name: 'Offline Provider',
        configured: true,
        selected: false,
        available: false,
        models: ['offline-model'],
        voices: [{ id: 'offline-voice', name: 'Offline Voice' }],
      },
    ],
    ...overrides,
  };
}

describe('SettingsScreen legacy voice selection', () => {
  it('updates canonical TTS voice while preserving provider and model fields', () => {
    const settings: Settings = {
      voice: 'rex',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'rex' },
      format: 'md',
      timestamps: false,
    };

    expect(withLegacyVoiceSelection(settings, 'nova')).toEqual({
      ...settings,
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
    });
  });
});

describe('SettingsScreen TTS catalog helpers', () => {
  it('sorts configured and available providers before unavailable or unconfigured providers', () => {
    expect(configuredTtsProviders(catalog()).map((provider) => provider.id)).toEqual([
      'openai',
      'offline',
      'unconfigured',
    ]);
  });

  it('selecting a provider chooses its default model and first voice when the current voice is invalid', () => {
    const [provider] = configuredTtsProviders(catalog());

    expect(nextTtsSelectionAfterProviderChange(provider, { voice: 'not-in-provider' })).toEqual({
      providerId: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
    });
  });

  it('treats an empty saved TTS selection as Default instead of the catalog active provider', () => {
    const providers = configuredTtsProviders(catalog());

    expect(ttsProviderValueForSelection(providers, {})).toBe(DEFAULT_PROVIDER_OPTION_ID);
    expect(isDefaultTtsSelection({})).toBe(true);
    expect(ttsCatalogStatusText(catalog(), undefined, true)).toBe(
      'OpenClaw will choose voice defaults',
    );
  });

  it('keeps stale TTS provider ids distinct so Default can clear them', () => {
    const providers = configuredTtsProviders(catalog());

    expect(ttsProviderValueForSelection(providers, { providerId: 'missing-provider' })).toBe(
      'missing-provider',
    );
    expect(ttsProviderValueForSelection(providers, { voice: 'legacy-voice' })).not.toBe(
      DEFAULT_PROVIDER_OPTION_ID,
    );
  });

  it('selecting a configured available provider with no voices clears the previous provider voice', () => {
    const emptyVoiceProvider = configuredTtsProviders(catalog({
      providers: [
        ...catalog().providers,
        {
          id: 'empty-provider',
          name: 'Empty Provider',
          configured: true,
          selected: false,
          available: true,
          models: ['empty-model'],
          voices: [],
        },
      ],
    })).find((provider) => provider.id === 'empty-provider');
    const settings: Settings = {
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      format: 'md',
      timestamps: false,
    };

    expect(emptyVoiceProvider).toBeDefined();
    const next = nextTtsSelectionAfterProviderChange(emptyVoiceProvider!, settings.tts);

    expect(next).toEqual({ providerId: 'empty-provider', model: 'empty-model' });
    expect(withTtsSelection(settings, next)).toEqual({
      ...settings,
      voice: '',
      tts: { providerId: 'empty-provider', model: 'empty-model' },
    });
  });

  it('selecting a voice preserves provider and model', () => {
    expect(
      nextTtsSelectionAfterVoiceChange(
        { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
        { id: 'nova', label: 'Nova' },
      ),
    ).toEqual({ providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' });
  });

  it('choosing Default for TTS clears provider, model, canonical voice, and legacy voice', () => {
    const settings: Settings = {
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'xai', model: 'grok-stt' },
      speed: 1.05,
      format: 'md',
      timestamps: false,
    };

    expect(withTtsSelection(settings, {})).toEqual({
      ...settings,
      voice: '',
      tts: {},
    });
  });

  it('falls back to a disabled current saved voice label while the catalog is loading', () => {
    expect(voicesForSelection(null, { voice: 'Samantha (en-US)' })).toEqual([
      { id: 'Samantha (en-US)', label: 'Samantha (en-US)', disabled: true },
    ]);
  });

  it('marks unconfigured providers as not selectable', () => {
    const unconfigured = configuredTtsProviders(catalog()).find(
      (provider) => provider.id === 'unconfigured',
    );

    expect(unconfigured?.selectable).toBe(false);
  });

  it('reports a TTS catalog status hint for status row consumers', () => {
    expect(ttsCatalogStatusText(null, undefined)).toBe('Connect to daemon to load voices');
  });

  it('keeps voice-based providers without models selectable and writes provider+voice without model', () => {
    const providers = configuredTtsProviders(catalog({
      providers: [
        ...catalog().providers,
        {
          id: 'xai',
          name: 'xAI',
          configured: true,
          selected: false,
          available: true,
          models: [],
          voices: [
            { id: 'eve', name: 'Eve' },
            { id: 'rex', name: 'Rex' },
          ],
        },
      ],
    }));
    const xai = providers.find((provider) => provider.id === 'xai');

    expect(xai?.selectable).toBe(true);
    expect(xai?.label).toBe('xAI');
    expect(nextTtsSelectionAfterProviderChange(xai!, {
      providerId: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
    })).toEqual({ providerId: 'xai', voice: 'eve' });
  });

  it('marks providers with no voices and no models as unselectable and labels them', () => {
    const providers = configuredTtsProviders(catalog({
      providers: [
        ...catalog().providers,
        {
          id: 'volcengine',
          name: 'Volcengine',
          configured: true,
          selected: false,
          available: true,
          models: [],
          voices: [],
        },
      ],
    }));
    const empty = providers.find((provider) => provider.id === 'volcengine');

    expect(empty?.selectable).toBe(false);
    expect(providerSelectLabel(empty!).toLowerCase()).toContain('no voices');
  });

  it('does not append a "no models" suffix to voice-based providers', () => {
    const providers = configuredTtsProviders(catalog({
      providers: [
        ...catalog().providers,
        {
          id: 'xai',
          name: 'xAI',
          configured: true,
          selected: false,
          available: true,
          models: [],
          voices: [{ id: 'eve', name: 'Eve' }],
        },
      ],
    }));
    const xai = providers.find((provider) => provider.id === 'xai');

    expect(providerSelectLabel(xai!)).toBe('xAI');
  });
});

function sttCatalog(overrides: Partial<SttCatalog> = {}): SttCatalog {
  return {
    activeProvider: 'xai',
    generatedAt: '2026-04-29T00:00:00.000Z',
    providers: [
      {
        id: 'unconfigured',
        name: 'Unconfigured',
        configured: false,
        selected: false,
        available: false,
        models: ['nope'],
      },
      {
        id: 'xai',
        name: 'xAI',
        configured: true,
        selected: true,
        available: true,
        models: ['grok-stt'],
      },
      {
        id: 'no-model',
        name: 'No Model',
        configured: true,
        selected: false,
        available: true,
        models: [],
      },
    ],
    ...overrides,
  };
}

describe('SettingsScreen STT catalog helpers', () => {
  it('sorts configured/available STT providers first', () => {
    expect(configuredSttProviders(sttCatalog()).map((provider) => provider.id)).toEqual([
      'xai',
      'no-model',
      'unconfigured',
    ]);
  });

  it('marks STT providers without a model as not selectable and labels them', () => {
    const providers = configuredSttProviders(sttCatalog());
    const noModel = providers.find((provider) => provider.id === 'no-model');
    expect(noModel?.selectable).toBe(false);
    expect(noModel?.label.toLowerCase()).toContain('no model');
  });

  it('selecting an STT provider writes its id and preferred model', () => {
    const [provider] = configuredSttProviders(sttCatalog());
    expect(nextSttSelectionAfterProviderChange(provider, {})).toEqual({
      providerId: 'xai',
      model: 'grok-stt',
    });
  });

  it('treats an empty saved STT selection as Default instead of the catalog active provider', () => {
    const providers = configuredSttProviders(sttCatalog());

    expect(sttProviderValueForSelection(providers, {})).toBe(DEFAULT_PROVIDER_OPTION_ID);
    expect(isDefaultSttSelection({})).toBe(true);
    expect(sttCatalogStatusText(sttCatalog(), undefined, true)).toBe(
      'OpenClaw will choose transcription defaults',
    );
  });

  it('keeps stale STT provider ids distinct so Default can clear them', () => {
    const providers = configuredSttProviders(sttCatalog());

    expect(sttProviderValueForSelection(providers, { providerId: 'missing-provider' })).toBe(
      'missing-provider',
    );
    expect(sttProviderValueForSelection(providers, { model: 'legacy-model' })).not.toBe(
      DEFAULT_PROVIDER_OPTION_ID,
    );
  });

  it('changing only the STT model preserves provider and TTS settings', () => {
    const settings: Settings = {
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'openai', model: 'whisper-1' },
      format: 'md',
      timestamps: false,
    };

    const nextSelection = nextSttSelectionAfterModelChange(settings.stt, 'whisper-large');
    expect(nextSelection).toEqual({ providerId: 'openai', model: 'whisper-large' });

    const updated = withSttSelection(settings, nextSelection);
    expect(updated).toEqual({
      ...settings,
      stt: { providerId: 'openai', model: 'whisper-large' },
    });
    expect(updated.tts).toBe(settings.tts);
    expect(updated.voice).toBe('nova');
  });

  it('TTS selection updates do not touch the STT selection', () => {
    const settings: Settings = {
      voice: 'rex',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'rex' },
      stt: { providerId: 'xai', model: 'grok-stt' },
      format: 'md',
      timestamps: false,
    };

    expect(
      withTtsSelection(settings, { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' }).stt,
    ).toEqual({ providerId: 'xai', model: 'grok-stt' });
    expect(withLegacyVoiceSelection(settings, 'nova').stt).toEqual({
      providerId: 'xai',
      model: 'grok-stt',
    });
  });

  it('shows separate status text for the transcription catalog distinct from the voice catalog', () => {
    expect(sttCatalogStatusText(null, undefined)).not.toBe(ttsCatalogStatusText(null, undefined));
    expect(sttCatalogStatusText(null, undefined).toLowerCase()).toContain('transcription');
  });
});
