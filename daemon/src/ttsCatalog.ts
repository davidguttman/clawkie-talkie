import type { TtsCatalog } from './protocol.js';
import { getTtsCatalogWithOpenClawInfer } from './openclawInfer.js';

export const DEFAULT_TTS_CATALOG_TTL_MS = 60_000;

export interface TtsCatalogCacheOptions {
  loadCatalog: () => Promise<TtsCatalog>;
  ttlMs: number;
}

export interface TtsCatalogCache {
  get(): Promise<TtsCatalog>;
}

export function createEmptyTtsCatalog(): TtsCatalog {
  return {
    activeProvider: undefined,
    generatedAt: new Date().toISOString(),
    providers: [],
  };
}

export function createTtsCatalogCache(options: TtsCatalogCacheOptions): TtsCatalogCache {
  let cached: TtsCatalog | undefined;
  let expiresAt = 0;

  return {
    async get(): Promise<TtsCatalog> {
      const now = Date.now();
      if (cached && now < expiresAt) return cached;

      try {
        const catalog = await options.loadCatalog();
        cached = catalog;
        expiresAt = Date.now() + options.ttlMs;
        return catalog;
      } catch {
        if (!cached) cached = createEmptyTtsCatalog();
        expiresAt = Date.now() + options.ttlMs;
        return cached;
      }
    },
  };
}

export const defaultTtsCatalogCache = createTtsCatalogCache({
  loadCatalog: () => getTtsCatalogWithOpenClawInfer(),
  ttlMs: DEFAULT_TTS_CATALOG_TTL_MS,
});
