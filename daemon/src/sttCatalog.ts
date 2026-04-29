import type { SttCatalog } from './protocol.js';
import { getSttCatalogWithOpenClawInfer } from './openclawInfer.js';

export const DEFAULT_STT_CATALOG_TTL_MS = 60_000;

export interface SttCatalogCacheOptions {
  loadCatalog: () => Promise<SttCatalog>;
  ttlMs: number;
}

export interface SttCatalogCache {
  get(): Promise<SttCatalog>;
}

export function createEmptySttCatalog(): SttCatalog {
  return {
    activeProvider: undefined,
    generatedAt: new Date().toISOString(),
    providers: [],
  };
}

export function createSttCatalogCache(options: SttCatalogCacheOptions): SttCatalogCache {
  let cached: SttCatalog | undefined;
  let expiresAt = 0;

  return {
    async get(): Promise<SttCatalog> {
      const now = Date.now();
      if (cached && now < expiresAt) return cached;

      try {
        const catalog = await options.loadCatalog();
        cached = catalog;
        expiresAt = Date.now() + options.ttlMs;
        return catalog;
      } catch {
        if (!cached) cached = createEmptySttCatalog();
        expiresAt = Date.now() + options.ttlMs;
        return cached;
      }
    },
  };
}

export const defaultSttCatalogCache = createSttCatalogCache({
  loadCatalog: () => getSttCatalogWithOpenClawInfer(),
  ttlMs: DEFAULT_STT_CATALOG_TTL_MS,
});
