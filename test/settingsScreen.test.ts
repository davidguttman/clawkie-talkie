// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const holdMusicMock = vi.hoisted(() => {
  type MockController = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  const controllerInstances: MockController[] = [];
  const HoldMusicController = vi.fn(function MockHoldMusicController(this: MockController) {
    this.start = vi.fn();
    this.stop = vi.fn();
    controllerInstances.push(this);
  });
  const mock = {
    HoldMusicController,
    controllerInstances,
    muteListener: null as ((muted: boolean) => void) | null,
    setHoldMusicSettings: vi.fn(),
    subscribeHoldMusicMuted: vi.fn((listener: (muted: boolean) => void) => {
      mock.muteListener = listener;
      return () => {
        if (mock.muteListener === listener) mock.muteListener = null;
      };
    }),
  };
  return mock;
});

vi.mock('../client/src/voice/holdMusic', () => holdMusicMock);

import {
  SettingsScreen,
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
  withMusicEffects,
  withMusicMuted,
  withMusicTrackEnabled,
  withMusicVolume,
} from '../client/src/screens/Settings';
import type { Settings } from '../client/src/storage';
import { getHoldMusicTrackOptions } from '../client/src/voice/holdMusicCatalog';
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


describe('SettingsScreen toggle accessibility', () => {
  it('renders export and music toggles as named switches with touch-friendly hit targets', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const settings: Settings = {
      voice: '',
      tts: {},
      stt: {},
      format: 'md',
      timestamps: true,
      music: { muted: false, effects: true, volume: 1, disabledTracks: [] },
    };

    try {
      await act(async () => {
        root.render(createElement(SettingsScreen, {
          onBack: () => undefined,
          settings,
          setSettings: vi.fn(),
          ttsCatalog: null,
          sttCatalog: null,
          compact: true,
        }));
      });

      const switches = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'),
      );
      const switchByLabel = (label: string) => switches.find(
        (button) => button.getAttribute('aria-label') === label,
      );
      const includeTimestamps = switchByLabel('Include timestamps');
      const holdMusic = switchByLabel('Hold music');
      const audioEffects = switchByLabel('Audio effects');

      expect(includeTimestamps?.getAttribute('aria-checked')).toBe('true');
      expect(holdMusic?.getAttribute('aria-checked')).toBe('true');
      expect(audioEffects?.getAttribute('aria-checked')).toBe('true');

      for (const toggle of [includeTimestamps, holdMusic, audioEffects]) {
        expect(toggle).toBeDefined();
        expect(toggle?.style.width).toBe('44px');
        expect(toggle?.style.height).toBe('44px');
        expect(toggle?.style.minWidth).toBe('44px');
        expect(toggle?.style.minHeight).toBe('44px');

        const visualSwitch = toggle?.querySelector<HTMLElement>('[aria-hidden="true"]');
        expect(visualSwitch?.style.width).toBe('40px');
        expect(visualSwitch?.style.height).toBe('24px');
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it('renders song picker rows as named switches with positive enabled semantics', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdMusicMock.setHoldMusicSettings.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const initialSettings: Settings = {
      voice: '',
      tts: {},
      stt: {},
      format: 'md',
      timestamps: false,
      music: { muted: false, effects: true, volume: 1, disabledTracks: ['Soft Hold Tone.mp3'] },
    };

    function Harness() {
      const [settings, setSettings] = useState(initialSettings);
      return createElement(SettingsScreen, {
        onBack: () => undefined,
        settings,
        setSettings,
        ttsCatalog: null,
        sttCatalog: null,
        compact: true,
      });
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });

      expect(container.querySelector('input[type="checkbox"]')).toBeNull();

      await act(async () => {
        container.querySelector<HTMLDivElement>('[role="button"][aria-label="Songs, expand"]')?.click();
      });

      const softHoldTone = () => container.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="Soft Hold Tone"]',
      );
      const docksideHold = container.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="Dockside Hold"]',
      );

      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(container.querySelector('[aria-label="Soft Hold Tone.mp3"]')).toBeNull();
      expect(softHoldTone()?.getAttribute('aria-checked')).toBe('false');
      expect(docksideHold?.getAttribute('aria-checked')).toBe('true');
      expect(softHoldTone()?.style.width).toBe('44px');
      expect(softHoldTone()?.style.height).toBe('44px');

      await act(async () => {
        softHoldTone()?.click();
      });

      expect(softHoldTone()?.getAttribute('aria-checked')).toBe('true');
      expect(holdMusicMock.setHoldMusicSettings).toHaveBeenLastCalledWith({
        muted: false,
        effects: true,
        volume: 1,
        disabledTracks: [],
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it('reflects external hold music mute changes while settings is open', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdMusicMock.muteListener = null;
    holdMusicMock.subscribeHoldMusicMuted.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const initialSettings: Settings = {
      voice: '',
      tts: {},
      stt: {},
      format: 'md',
      timestamps: false,
      music: { muted: false, effects: true, volume: 1, disabledTracks: [] },
    };

    function Harness() {
      const [settings, setSettings] = useState(initialSettings);
      return createElement(SettingsScreen, {
        onBack: () => undefined,
        settings,
        setSettings,
        ttsCatalog: null,
        sttCatalog: null,
        compact: true,
      });
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      const holdMusicSwitch = () => container.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="Hold music"]',
      );

      expect(holdMusicSwitch()?.getAttribute('aria-checked')).toBe('true');
      expect(holdMusicMock.subscribeHoldMusicMuted).toHaveBeenCalledTimes(1);

      await act(async () => {
        holdMusicMock.muteListener?.(true);
      });

      expect(holdMusicSwitch()?.getAttribute('aria-checked')).toBe('false');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.unstubAllGlobals();
    }
  });


  it('updates hold music volume and owns a settings-only preview controller', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdMusicMock.setHoldMusicSettings.mockClear();
    holdMusicMock.HoldMusicController.mockClear();
    holdMusicMock.controllerInstances.length = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const initialSettings: Settings = {
      voice: '',
      tts: {},
      stt: {},
      format: 'md',
      timestamps: false,
      music: { muted: false, effects: true, volume: 0.5, disabledTracks: [] },
    };

    function Harness() {
      const [settings, setSettings] = useState(initialSettings);
      return createElement(SettingsScreen, {
        onBack: () => undefined,
        settings,
        setSettings,
        ttsCatalog: null,
        sttCatalog: null,
        compact: true,
      });
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });

      const volume = container.querySelector<HTMLInputElement>('input[aria-label="Hold music volume"]');
      expect(volume).toBeDefined();
      expect(volume?.type).toBe('range');
      expect(volume?.min).toBe('0');
      expect(volume?.max).toBe('1');
      expect(volume?.step).toBe('0.01');
      expect(volume?.value).toBe('0.5');

      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(volume, '0.42');
        volume!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      expect(holdMusicMock.setHoldMusicSettings).toHaveBeenLastCalledWith({
        muted: false,
        effects: true,
        volume: 0.42,
        disabledTracks: [],
      });
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Hold music volume"]')?.value).toBe('0.42');

      const startButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Start');
      const stopButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Stop');

      expect(holdMusicMock.HoldMusicController).not.toHaveBeenCalled();
      await act(async () => {
        startButton()?.click();
      });
      expect(holdMusicMock.HoldMusicController).toHaveBeenCalledTimes(1);
      expect(holdMusicMock.controllerInstances[0].start).toHaveBeenCalledTimes(1);
      expect(stopButton()).toBeDefined();

      await act(async () => {
        stopButton()?.click();
      });
      expect(holdMusicMock.controllerInstances[0].stop).toHaveBeenCalledTimes(1);
      expect(startButton()).toBeDefined();

      await act(async () => {
        startButton()?.click();
      });
      expect(holdMusicMock.HoldMusicController).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      if (holdMusicMock.controllerInstances[0]) {
        expect(holdMusicMock.controllerInstances[0].stop).toHaveBeenCalledTimes(1);
      }
      if (holdMusicMock.controllerInstances[1]) {
        expect(holdMusicMock.controllerInstances[1].stop).toHaveBeenCalledTimes(1);
      }
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it('disables the preview and stops it when every hold music track is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdMusicMock.setHoldMusicSettings.mockClear();
    holdMusicMock.HoldMusicController.mockClear();
    holdMusicMock.controllerInstances.length = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const trackOptions = getHoldMusicTrackOptions();
    const initialSettings: Settings = {
      voice: '',
      tts: {},
      stt: {},
      format: 'md',
      timestamps: false,
      music: { muted: false, effects: true, volume: 1, disabledTracks: [] },
    };

    function Harness() {
      const [settings, setSettings] = useState(initialSettings);
      return createElement(SettingsScreen, {
        onBack: () => undefined,
        settings,
        setSettings,
        ttsCatalog: null,
        sttCatalog: null,
        compact: true,
      });
    }

    const previewButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Start' || button.textContent === 'Stop');
    const songSwitch = (label: string) => container.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="${label.replace(/"/g, '\\"')}"]`,
    );

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });

      expect(previewButton()?.textContent).toBe('Start');
      expect(previewButton()?.disabled).toBe(false);

      await act(async () => {
        previewButton()?.click();
      });

      expect(holdMusicMock.HoldMusicController).toHaveBeenCalledTimes(1);
      expect(holdMusicMock.controllerInstances[0].start).toHaveBeenCalledTimes(1);
      expect(previewButton()?.textContent).toBe('Stop');
      expect(previewButton()?.disabled).toBe(false);

      await act(async () => {
        container.querySelector<HTMLDivElement>('[role="button"][aria-label="Songs, expand"]')?.click();
      });

      for (const track of trackOptions) {
        await act(async () => {
          songSwitch(track.label)?.click();
        });
      }

      expect(holdMusicMock.setHoldMusicSettings).toHaveBeenLastCalledWith({
        muted: false,
        effects: true,
        volume: 1,
        disabledTracks: trackOptions.map((track) => track.id),
      });
      expect(holdMusicMock.controllerInstances[0].stop).toHaveBeenCalledTimes(1);
      expect(previewButton()?.textContent).toBe('Start');
      expect(previewButton()?.disabled).toBe(true);

      await act(async () => {
        previewButton()?.click();
      });
      expect(holdMusicMock.HoldMusicController).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.unstubAllGlobals();
    }
  });


});

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


describe('SettingsScreen music helpers', () => {
  it('toggles hold music mute and audio effects without touching voice/export settings', () => {
    const settings: Settings = {
      voice: 'nova',
      tts: { providerId: 'openai', voice: 'nova' },
      stt: { providerId: 'xai', model: 'grok-stt' },
      format: 'json',
      timestamps: true,
      music: { muted: false, effects: true, volume: 1, disabledTracks: [] },
    };

    expect(withMusicMuted(settings, true)).toEqual({
      ...settings,
      music: { muted: true, effects: true, volume: 1, disabledTracks: [] },
    });
    expect(withMusicEffects(settings, false)).toEqual({
      ...settings,
      music: { muted: false, effects: false, volume: 1, disabledTracks: [] },
    });
    expect(withMusicVolume(settings, 0.25)).toEqual({
      ...settings,
      music: { muted: false, effects: true, volume: 0.25, disabledTracks: [] },
    });
  });

  it('toggles individual songs off and back on with a stable disabled-track list', () => {
    const settings: Settings = {
      voice: '',
      tts: {},
      stt: {},
      format: 'md',
      timestamps: false,
      music: { muted: false, effects: true, volume: 1, disabledTracks: ['Soft Hold Tone.mp3'] },
    };

    expect(withMusicTrackEnabled(settings, 'Dockside Hold.mp3', false).music.disabledTracks).toEqual([
      'Soft Hold Tone.mp3',
      'Dockside Hold.mp3',
    ]);
    expect(withMusicTrackEnabled(settings, 'Soft Hold Tone.mp3', true).music.disabledTracks).toEqual([]);
  });
});

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
