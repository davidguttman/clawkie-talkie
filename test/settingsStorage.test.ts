// Pins the settings-storage boundary in `client/src/storage.ts`.
// Export prefs remain global for history/export consumers, while
// voice/provider settings are scoped by host peer id under `hosts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('dashboard host recovery storage', () => {
  it('remembers the last dashboard host for PWA launches', async () => {
    const { loadLastDashboardHostPeerId, saveLastDashboardHostPeerId } = await import('../client/src/storage');

    expect(loadLastDashboardHostPeerId()).toBeNull();
    saveLastDashboardHostPeerId(' host-1 ');

    expect(loadLastDashboardHostPeerId()).toBe('host-1');
  });
});

describe('settings storage', () => {
  it('returns defaults with no selected TTS provider, model, or voice when nothing is stored', async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    const settings = loadSettings('host-1');
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.tts.providerId).toBeUndefined();
    expect(settings.tts.model).toBeUndefined();
    expect(settings.tts.voice).toBeUndefined();
    expect(settings.stt).toEqual({});
  });

  it('ignores legacy global TTS, STT, and voice settings for a host-scoped load', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        voice: 'rex',
        tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
        stt: { providerId: 'xai', model: 'grok-stt' },
        format: 'txt',
        timestamps: true,
      }),
    );

    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1')).toEqual({
      voice: '',
      tts: {},
      stt: {},
      format: 'txt',
      timestamps: true,
    });
  });

  it('also ignores legacy global voice/provider settings when no host id is provided', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        voice: 'rex',
        tts: { providerId: 'openai', voice: 'nova' },
        stt: { providerId: 'xai' },
        format: 'json',
      }),
    );

    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings()).toEqual({
      voice: '',
      tts: {},
      stt: {},
      format: 'json',
      timestamps: false,
    });
  });

  it('loads TTS and STT selections from the matching host only', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        format: 'txt',
        timestamps: true,
        hosts: {
          'host-1': {
            tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
            stt: { providerId: 'xai', model: 'grok-stt' },
            voice: 'nova',
          },
          'host-2': {
            tts: { providerId: 'other', voice: 'other-voice' },
            stt: { providerId: 'other-stt' },
            voice: 'other-voice',
          },
        },
      }),
    );

    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1')).toEqual({
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'xai', model: 'grok-stt' },
      format: 'txt',
      timestamps: true,
    });
    expect(loadSettings('missing-host')).toEqual({
      voice: '',
      tts: {},
      stt: {},
      format: 'txt',
      timestamps: true,
    });
  });

  it('trims host-scoped STT string fields and drops empty or non-string values', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': { stt: { providerId: ' xai ', model: '   ', extra: 42 } },
        },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1').stt).toEqual({ providerId: 'xai' });
  });

  it('drops non-string host-scoped STT fields entirely', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': { stt: { providerId: 42, model: ['nope'] } },
        },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1').stt).toEqual({});
  });

  it('trims host-scoped TTS fields and can use the host voice mirror', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': {
            tts: { providerId: ' openai ', model: '   ', voice: 123 },
            voice: ' rex ',
          },
        },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings('host-1');
    expect(settings.tts).toEqual({ providerId: 'openai', voice: 'rex' });
    expect(settings.voice).toBe('rex');
  });

  it('saveSettings writes voice/provider settings only under the active host', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      voice: 'nova',
      stt: { providerId: 'xai', model: 'grok-stt' },
      format: 'json',
      timestamps: true,
    }, 'host-1');

    const raw = localStorage.getItem('clawkie.settings.v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual({
      format: 'json',
      timestamps: true,
      hosts: {
        'host-1': {
          voice: 'nova',
          tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
          stt: { providerId: 'xai', model: 'grok-stt' },
        },
      },
    });
    expect(parsed.tts).toBeUndefined();
    expect(parsed.stt).toBeUndefined();
    expect(parsed.voice).toBeUndefined();
    expect(loadSettings('host-1').stt).toEqual({ providerId: 'xai', model: 'grok-stt' });
    expect(loadSettings('host-2').stt).toEqual({});
  });

  it('saveSettings preserves other host records while updating the current host', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        format: 'md',
        timestamps: false,
        hosts: {
          'host-2': { voice: 'ara', tts: { voice: 'ara' }, stt: { providerId: 'other' } },
        },
      }),
    );

    const { saveSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'custom-provider', model: 'custom-model', voice: 'Samantha (en-US)' },
      voice: 'Samantha (en-US)',
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.hosts['host-2']).toEqual({
      voice: 'ara',
      tts: { voice: 'ara' },
      stt: { providerId: 'other' },
    });
    expect(parsed.hosts['host-1']).toEqual({
      voice: 'Samantha (en-US)',
      tts: { providerId: 'custom-provider', model: 'custom-model', voice: 'Samantha (en-US)' },
      stt: {},
    });
  });

  it('saveSettings with no host only writes global export prefs and preserves existing hosts', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': { voice: 'nova', tts: { voice: 'nova' }, stt: {} },
        },
      }),
    );
    const { saveSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'openai', voice: 'rex' },
      voice: 'rex',
      stt: { providerId: 'xai' },
      format: 'txt',
      timestamps: true,
    });

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed).toEqual({
      format: 'txt',
      timestamps: true,
      hosts: {
        'host-1': { voice: 'nova', tts: { voice: 'nova' }, stt: {} },
      },
    });
  });

  it('saveSettings preserves an updated host voice mirror over a stale TTS voice', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { voice: 'rex' },
      voice: 'leo',
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.hosts['host-1'].tts.voice).toBe('leo');
    expect(parsed.hosts['host-1'].voice).toBe('leo');
    expect(loadSettings('host-1').tts.voice).toBe('leo');
  });

  it('saveSettings preserves Default TTS as empty host-scoped TTS and blank voice', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: {},
      voice: '',
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.hosts['host-1'].tts).toEqual({});
    expect(parsed.hosts['host-1'].voice).toBe('');
    expect(loadSettings('host-1').tts).toEqual({});
    expect(loadSettings('host-1').voice).toBe('');
  });

  it('exposes global export settings without applying legacy voice/provider settings', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'leo', tts: { voice: 'leo' }, format: 'json', timestamps: true }),
    );
    const { loadExportSettings, loadSettings, DEFAULT_EXPORT_SETTINGS } = await import('../client/src/storage');
    expect(loadExportSettings()).toEqual({ format: 'json', timestamps: true });
    expect(loadSettings('host-1').voice).toBe('');
    expect(DEFAULT_EXPORT_SETTINGS).toEqual({ format: 'md', timestamps: false });
  });

  it('falls back to defaults when persisted record is corrupt', async () => {
    localStorage.setItem('clawkie.settings.v1', 'not-json');
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    expect(loadSettings('host-1')).toEqual(DEFAULT_SETTINGS);
  });
});
