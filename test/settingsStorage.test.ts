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
  it('returns defaults when nothing is stored', async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates legacy free-form voice strings to the default voice id', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'Samantha (en-US)', speed: 1.05, format: 'md', timestamps: false }),
    );
    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings().voice).toBe('eve');
  });

  it('keeps a recognized voice id intact', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'rex', speed: 1.05, format: 'txt', timestamps: true }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings();
    expect(settings.voice).toBe('rex');
    expect(settings.format).toBe('txt');
    expect(settings.timestamps).toBe(true);
  });

  it('exposes export settings without importing the rest of the Settings shape', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'leo', speed: 1.2, format: 'json', timestamps: true }),
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
