// Pins the export-settings boundary and migration behavior in
// `client/src/storage.ts`. Thread 3 (export/history) must be able to
// read export settings without importing the Settings UI surface, so
// `loadExportSettings()` returns a focused `{ format, timestamps }`
// view of the same persisted record.

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

describe('settings storage', () => {
  it('returns defaults with no selected TTS provider, model, or voice when nothing is stored', async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.tts.providerId).toBeUndefined();
    expect(settings.tts.model).toBeUndefined();
    expect(settings.tts.voice).toBeUndefined();
    expect(settings.stt).toEqual({});
  });

  it('persists a new STT provider/model selection intact', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        stt: { providerId: 'xai', model: 'grok-stt' },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.stt).toEqual({ providerId: 'xai', model: 'grok-stt' });
  });

  it('trims STT string fields and drops empty or non-string values', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        stt: { providerId: ' xai ', model: '   ' },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.stt).toEqual({ providerId: 'xai' });
  });

  it('drops non-string STT fields entirely', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        stt: { providerId: 42, model: ['nope'] },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.stt).toEqual({});
  });

  it('loads existing TTS-only records without an STT field unchanged', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
        voice: 'nova',
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.stt).toEqual({});
    expect(settings.tts).toEqual({ providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' });
  });

  it('saveSettings preserves the STT selection alongside TTS', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      voice: 'nova',
      stt: { providerId: 'xai', model: 'grok-stt' },
    });

    const raw = localStorage.getItem('clawkie.settings.v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.stt).toEqual({ providerId: 'xai', model: 'grok-stt' });
    expect(parsed.tts.voice).toBe('nova');
    expect(loadSettings().stt).toEqual({ providerId: 'xai', model: 'grok-stt' });
  });

  it('migrates a legacy voice into the dynamic TTS selection', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'rex', speed: 1.05, format: 'md', timestamps: false }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.tts.voice).toBe('rex');
    expect(settings.voice).toBe('rex');
    expect('speed' in settings).toBe(false);
  });

  it('persists a new dynamic TTS provider, model, and voice intact', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
        format: 'txt',
        timestamps: true,
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.tts).toEqual({ providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' });
    expect(settings.voice).toBe('nova');
    expect(settings.format).toBe('txt');
    expect(settings.timestamps).toBe(true);
  });

  it('trims dynamic TTS string fields and drops empty or non-string values', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        tts: { providerId: ' openai ', model: '   ', voice: 123 },
        voice: ' rex ',
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.tts).toEqual({ providerId: 'openai', voice: 'rex' });
    expect(settings.voice).toBe('rex');
  });

  it('saveSettings writes the new dynamic TTS shape without stale voice-id validation', async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'custom-provider', model: 'custom-model', voice: 'Samantha (en-US)' },
      voice: 'Samantha (en-US)',
      format: 'json',
      timestamps: true,
    });

    const raw = localStorage.getItem('clawkie.settings.v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.tts).toEqual({
      providerId: 'custom-provider',
      model: 'custom-model',
      voice: 'Samantha (en-US)',
    });
    expect(parsed.voice).toBe('Samantha (en-US)');
  });

  it('saveSettings preserves an updated legacy voice mirror over a stale TTS voice', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { voice: 'rex' },
      voice: 'leo',
    });

    const raw = localStorage.getItem('clawkie.settings.v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.tts.voice).toBe('leo');
    expect(parsed.voice).toBe('leo');
    expect(loadSettings().tts.voice).toBe('leo');
  });

  it('exposes export settings without importing the rest of the Settings shape', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'leo', format: 'json', timestamps: true }),
    );
    const { loadExportSettings, DEFAULT_EXPORT_SETTINGS } = await import('../client/src/storage');
    expect(loadExportSettings()).toEqual({ format: 'json', timestamps: true });
    expect(DEFAULT_EXPORT_SETTINGS).toEqual({ format: 'md', timestamps: false });
  });

  it('falls back to defaults when persisted record is corrupt', async () => {
    localStorage.setItem('clawkie.settings.v1', 'not-json');
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
