import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildInferTtsProvidersCommand,
  getTtsCatalogWithOpenClawInfer,
  parseInferTtsProviders,
} from '../daemon/src/openclawInfer';
import { createTtsCatalogCache } from '../daemon/src/ttsCatalog';


afterEach(() => {
  vi.useRealTimers();
});

describe('createTtsCatalogCache', () => {
  it('calls loadCatalog once for repeated reads within TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const catalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const loadCatalog = vi.fn(async () => catalog);
    const cache = createTtsCatalogCache({ loadCatalog, ttlMs: 1000 });

    await expect(cache.get()).resolves.toBe(catalog);
    vi.advanceTimersByTime(999);
    await expect(cache.get()).resolves.toBe(catalog);

    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it('refreshes after TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const first = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const second = {
      activeProvider: 'elevenlabs',
      generatedAt: '2026-04-28T00:01:00.000Z',
      providers: [],
    };
    const loadCatalog = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const cache = createTtsCatalogCache({ loadCatalog, ttlMs: 1000 });

    await expect(cache.get()).resolves.toBe(first);
    vi.advanceTimersByTime(1000);
    await expect(cache.get()).resolves.toBe(second);

    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it('returns the previous catalog when refresh fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const previous = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const loadCatalog = vi.fn()
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error('catalog unavailable'));
    const cache = createTtsCatalogCache({ loadCatalog, ttlMs: 1000 });

    await expect(cache.get()).resolves.toBe(previous);
    vi.advanceTimersByTime(1000);
    await expect(cache.get()).resolves.toBe(previous);

    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it('caches a safe empty catalog within TTL when initial load fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const loadCatalog = vi.fn(async () => {
      throw new Error('catalog unavailable');
    });
    const cache = createTtsCatalogCache({ loadCatalog, ttlMs: 1000 });

    const first = await cache.get();
    vi.advanceTimersByTime(999);
    const second = await cache.get();

    expect(first).toEqual({
      activeProvider: undefined,
      generatedAt: expect.any(String),
      providers: [],
    });
    expect(second).toBe(first);
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it('extends TTL for the previous catalog when refresh fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const previous = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const next = {
      activeProvider: 'elevenlabs',
      generatedAt: '2026-04-28T00:01:01.000Z',
      providers: [],
    };
    const loadCatalog = vi.fn()
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce(next);
    const cache = createTtsCatalogCache({ loadCatalog, ttlMs: 1000 });

    await expect(cache.get()).resolves.toBe(previous);
    vi.advanceTimersByTime(1000);
    await expect(cache.get()).resolves.toBe(previous);
    vi.advanceTimersByTime(999);
    await expect(cache.get()).resolves.toBe(previous);

    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it('returns a safe empty catalog when initial load fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
    const loadCatalog = vi.fn(async () => {
      throw new Error('catalog unavailable');
    });
    const cache = createTtsCatalogCache({ loadCatalog, ttlMs: 1000 });

    await expect(cache.get()).resolves.toEqual({
      activeProvider: undefined,
      generatedAt: expect.any(String),
      providers: [],
    });
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });
});

describe('buildInferTtsProvidersCommand', () => {
  it('builds the OpenClaw infer TTS providers command', () => {
    expect(buildInferTtsProvidersCommand()).toEqual({
      command: 'openclaw',
      args: ['infer', 'tts', 'providers', '--json'],
    });
  });
});

describe('parseInferTtsProviders', () => {
  it('normalizes provider JSON from the OpenClaw infer CLI shape', () => {
    const catalog = parseInferTtsProviders(
      JSON.stringify({
        providers: [
          {
            available: true,
            configured: true,
            selected: true,
            id: 'openai',
            name: 'OpenAI',
            models: ['gpt-4o-mini-tts'],
            voices: ['alloy', 'nova'],
          },
        ],
        active: 'openai',
      }),
    );

    expect(catalog).toEqual({
      activeProvider: 'openai',
      generatedAt: expect.any(String),
      providers: [
        {
          available: true,
          configured: true,
          selected: true,
          id: 'openai',
          name: 'OpenAI',
          models: ['gpt-4o-mini-tts'],
          voices: [
            { id: 'alloy', name: 'alloy' },
            { id: 'nova', name: 'nova' },
          ],
        },
      ],
    });
  });

  it('accepts voices already shaped as objects', () => {
    const catalog = parseInferTtsProviders(
      JSON.stringify({
        providers: [
          {
            available: true,
            configured: true,
            selected: true,
            id: 'openai',
            name: 'OpenAI',
            models: ['gpt-4o-mini-tts'],
            voices: [{ id: 'nova', name: 'Nova' }],
          },
        ],
        active: 'openai',
      }),
    );

    expect(catalog.providers[0]?.voices).toEqual([{ id: 'nova', name: 'Nova' }]);
  });

  it('throws clear parser errors for invalid catalog payloads', () => {
    expect(() => parseInferTtsProviders('not json')).toThrow(/Invalid OpenClaw infer TTS providers JSON/i);
    expect(() => parseInferTtsProviders(JSON.stringify({ active: 'openai' }))).toThrow(
      /missing providers/i,
    );
    expect(() =>
      parseInferTtsProviders(
        JSON.stringify({
          providers: [{ name: 'OpenAI', models: [], voices: [] }],
          active: 'openai',
        }),
      ),
    ).toThrow(/provider missing id/i);
  });
});

describe('getTtsCatalogWithOpenClawInfer', () => {
  it('calls the providers command and returns the normalized catalog', async () => {
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];
    const signal = new AbortController().signal;

    const catalog = await getTtsCatalogWithOpenClawInfer({
      signal,
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify({
            providers: [
              {
                available: true,
                configured: true,
                selected: true,
                id: 'openai',
                name: 'OpenAI',
                models: ['gpt-4o-mini-tts'],
                voices: ['alloy'],
              },
            ],
            active: 'openai',
          }),
          stderr: '',
        };
      },
    });

    expect(calls).toEqual([{ ...buildInferTtsProvidersCommand(), signal }]);
    expect(catalog.providers[0]?.voices).toEqual([{ id: 'alloy', name: 'alloy' }]);
  });

  it('maps exec failures to a stable catalog error code', async () => {
    const failure = Object.assign(new Error('process failed'), { stderr: 'provider exploded' });

    await expect(
      getTtsCatalogWithOpenClawInfer({
        exec: async () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({
      code: 'openclaw_infer_tts_catalog_failed',
      message: expect.stringContaining('openclaw_infer_tts_catalog_failed'),
    });
  });
});
