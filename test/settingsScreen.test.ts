import { describe, expect, it } from 'vitest';
import {
  configuredTtsProviders,
  nextTtsSelectionAfterProviderChange,
  nextTtsSelectionAfterVoiceChange,
  voicesForSelection,
  withLegacyVoiceSelection,
  withTtsSelection,
} from '../client/src/screens/Settings';
import type { Settings } from '../client/src/storage';
import type { TtsCatalog } from '../client/src/voice/protocol';

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
      speed: 1.05,
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
      speed: 1.05,
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

  it('marks configured available providers without models as not selectable and ignores provider changes', () => {
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
          voices: [{ id: 'alloy', name: 'Alloy' }],
        },
      ],
    }));
    const modelLessProvider = providers.find((provider) => provider.id === 'xai');
    const current: Settings['tts'] = {
      providerId: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
    };

    expect(modelLessProvider?.selectable).toBe(false);
    expect(nextTtsSelectionAfterProviderChange(modelLessProvider!, current)).toEqual(current);
  });
});
