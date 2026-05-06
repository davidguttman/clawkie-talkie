import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import {
  appleTouchIconSizes,
  iconSizes,
  manifestIconSizes,
  maskableIconSizes,
  splashSizes,
} from '../scripts/pwa-assets-meta.mjs';
import { injectPwaHtml } from '../client/vite/pwaPlugin';

const root = resolve(__dirname, '..');
const publicDir = resolve(root, 'client/public');
const splashSourcePath = resolve(root, 'scripts/pwa-source/clawkie-splash-source.png');

function readPngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

type HeaderMap = Record<string, string | undefined>;

type ServiceWorkerHelpers = {
  PRECACHE_ASSETS: string[];
  shouldBypass: (request: MockRequest, url: URL) => boolean;
  hasSensitiveQuery: (url: URL) => boolean;
  isHtmlRequest: (request: MockRequest, url: URL) => boolean;
  isUpdateSensitiveAsset: (url: URL) => boolean;
  isRangeRequest: (request: MockRequest) => boolean;
  isStaticAsset: (url: URL) => boolean;
  cacheFirst: (request: MockRequest) => Promise<Response>;
  putIfCacheable: (request: MockRequest, response: Response) => Promise<void>;
};

type MockRequest = {
  method: string;
  mode: string;
  url: string;
  headers: { get: (name: string) => string | null };
};

function mockRequest(path: string, headers: HeaderMap = {}, method = 'GET'): MockRequest {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method,
    mode: 'same-origin',
    url: `https://clawkie.test${path}`,
    headers: {
      get(name: string) {
        return normalizedHeaders[name.toLowerCase()] ?? null;
      },
    },
  };
}

function loadServiceWorkerHelpers(overrides: { caches?: unknown; fetch?: unknown } = {}): ServiceWorkerHelpers {
  const sw = readFileSync(resolve(publicDir, 'sw.js'), 'utf8');
  const context = {
    URL,
    Response,
    fetch: overrides.fetch ?? (async () => { throw new Error('Unexpected fetch'); }),
    self: {
      location: { origin: 'https://clawkie.test' },
      addEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: overrides.caches ?? {},
    console,
  };

  createContext(context);
  runInContext(
    `${sw}\n` +
      `globalThis.__helpers = { PRECACHE_ASSETS, shouldBypass, hasSensitiveQuery, isHtmlRequest, isUpdateSensitiveAsset, isRangeRequest, isStaticAsset, cacheFirst, putIfCacheable };`,
    context,
  );

  return (context as typeof context & { __helpers: ServiceWorkerHelpers }).__helpers;
}

describe('PWA metadata and assets', () => {
  it('defines an installable Clawkie-Talkie manifest with regular and maskable icons', () => {
    const manifestPath = resolve(publicDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      short_name: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    };

    expect(manifest).toMatchObject({
      name: 'Clawkie-Talkie',
      short_name: 'Clawkie-Talkie',
      scope: '/',
      display: 'standalone',
      background_color: '#0a0a0b',
      theme_color: '#0a0a0b',
    });

    // Do not set a static start_url: installed-app launch should default to
    // the current install document URL so /voice and /dashboard hash args are preserved.
    expect(manifest).not.toHaveProperty('start_url');

    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(
      manifestIconSizes.map((size) => `${size}x${size}`),
    ));
    expect(manifest.icons.filter((icon) => icon.purpose === 'maskable').map((icon) => icon.sizes)).toEqual(
      maskableIconSizes.map((size) => `${size}x${size}`),
    );

    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(existsSync(resolve(publicDir, icon.src.slice(1)))).toBe(true);
    }
  });

  it('ships generated Clawkie-Talkie icon and Apple splash PNG assets at the linked sizes', () => {
    expect(existsSync(splashSourcePath), splashSourcePath).toBe(true);
    expect(readPngSize(splashSourcePath)).toEqual({ width: 926, height: 1698 });

    for (const size of iconSizes) {
      const path = resolve(publicDir, `icons/icon-${size}x${size}.png`);
      expect(existsSync(path), path).toBe(true);
      expect(readPngSize(path)).toEqual({ width: size, height: size });
    }

    for (const size of maskableIconSizes) {
      const path = resolve(publicDir, `icons/icon-maskable-${size}x${size}.png`);
      expect(existsSync(path), path).toBe(true);
      expect(readPngSize(path)).toEqual({ width: size, height: size });
    }

    expect(existsSync(resolve(publicDir, 'icons/apple-touch-icon.png'))).toBe(true);
    for (const size of appleTouchIconSizes) {
      const path = resolve(publicDir, `icons/apple-touch-icon-${size}x${size}.png`);
      expect(existsSync(path), path).toBe(true);
      expect(readPngSize(path)).toEqual({ width: size, height: size });
    }

    for (const [width, height] of splashSizes) {
      const path = resolve(publicDir, `splash/apple-splash-${width}-${height}.png`);
      expect(existsSync(path), path).toBe(true);
      expect(readPngSize(path)).toEqual({ width, height });
    }
  });

  it.each(['client/index.html', 'client/voice.html', 'client/voice/index.html', 'client/dashboard/index.html'])('%s receives PWA metadata and SW registration from the Vite transform', (entry) => {
    const sourceHtml = readFileSync(resolve(root, entry), 'utf8');
    const html = injectPwaHtml(sourceHtml);
    const document = new JSDOM(html).window.document;

    expect(sourceHtml).not.toContain('<link rel="manifest" href="/manifest.json" />');
    expect(sourceHtml).not.toContain('apple-touch-startup-image');
    expect(sourceHtml).not.toContain("register('/sw.js')");

    expect(document.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe('/manifest.json');
    expect(document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute('content')).toBe('yes');
    expect(document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content')).toBe('yes');
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('Clawkie-Talkie');
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/icons/apple-touch-icon.png');
    expect(document.querySelector('link[rel="icon"][sizes="192x192"]')?.getAttribute('href')).toBe('/icons/icon-192x192.png');

    const splashLinks = Array.from(document.querySelectorAll('link[rel="apple-touch-startup-image"]'));
    expect(splashLinks).toHaveLength(splashSizes.length);
    expect(splashLinks.map((link) => link.getAttribute('href'))).toEqual(
      splashSizes.map(([width, height]) => `/splash/apple-splash-${width}-${height}.png`),
    );
    expect(Array.from(document.querySelectorAll('script')).some((script) => script.textContent?.includes("navigator.serviceWorker") && script.textContent.includes("register('/sw.js')"))).toBe(true);
  });

  it('classifies service-worker cache routing without caching voice/session traffic', () => {
    const helpers = loadServiceWorkerHelpers();
    const url = (path: string) => new URL(path, 'https://clawkie.test');

    expect(helpers.PRECACHE_ASSETS).toEqual(expect.arrayContaining(['/voice/', '/voice.html', '/dashboard/', '/manifest.json', '/sw.js']));

    expect(helpers.shouldBypass(mockRequest('/voice/', { upgrade: 'websocket' }), url('/voice/'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/voice/', { accept: 'text/event-stream' }), url('/voice/'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/voice/?session=abc'), url('/voice/?session=abc'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/api/say'), url('/api/say'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/signal/join'), url('/signal/join'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/subscribe'), url('/subscribe'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/socket'), url('/socket'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/ws'), url('/ws'))).toBe(true);
    expect(helpers.shouldBypass(mockRequest('/icons/icon-192x192.png'), url('/icons/icon-192x192.png'))).toBe(false);
    expect(helpers.shouldBypass(mockRequest('/music/hold.mp3', { range: 'bytes=0-1023' }), url('/music/hold.mp3'))).toBe(true);

    expect(helpers.isRangeRequest(mockRequest('/music/hold.mp3', { range: 'bytes=0-1023' }))).toBe(true);
    expect(helpers.isRangeRequest(mockRequest('/music/hold.mp3'))).toBe(false);

    expect(helpers.hasSensitiveQuery(url('/voice/?peer=abc'))).toBe(true);
    expect(helpers.hasSensitiveQuery(url('/voice/?utm_source=test'))).toBe(false);

    expect(helpers.isHtmlRequest(mockRequest('/voice/', { accept: 'text/html' }), url('/voice/'))).toBe(true);
    expect(helpers.isHtmlRequest(mockRequest('/voice.html'), url('/voice.html'))).toBe(true);
    expect(helpers.isUpdateSensitiveAsset(url('/assets/app.js'))).toBe(true);
    expect(helpers.isUpdateSensitiveAsset(url('/assets/app.css'))).toBe(true);
    expect(helpers.isUpdateSensitiveAsset(url('/manifest.json'))).toBe(true);
    expect(helpers.isUpdateSensitiveAsset(url('/icons/icon-192x192.png'))).toBe(false);

    expect(helpers.isStaticAsset(url('/icons/icon-192x192.png'))).toBe(true);
    expect(helpers.isStaticAsset(url('/splash/apple-splash-1290-2796.png'))).toBe(true);
    expect(helpers.isStaticAsset(url('/music/hold.mp3'))).toBe(true);
    expect(helpers.isStaticAsset(url('/fixtures/sample.wav'))).toBe(true);
    expect(helpers.isStaticAsset(url('/audio/worklet.js'))).toBe(true);
    expect(helpers.isStaticAsset(url('/api/say'))).toBe(false);
  });

  it('lets hold-music Range requests use the network without cache failures becoming 503s', async () => {
    let putCount = 0;
    const rangeResponse = new Response('partial audio', { status: 206, statusText: 'Partial Content' });
    const helpers = loadServiceWorkerHelpers({
      fetch: async () => rangeResponse,
      caches: {
        match: async () => undefined,
        open: async () => ({
          put: async () => {
            putCount += 1;
            throw new Error('Cache API rejects partial content');
          },
        }),
      },
    });

    const response = await helpers.cacheFirst(mockRequest('/music/hold.mp3', { range: 'bytes=0-1023' }));

    expect(response).toBe(rangeResponse);
    expect(response.status).toBe(206);
    expect(putCount).toBe(0);
  });

  it('treats runtime cache writes as best-effort after a successful network fetch', async () => {
    let putCount = 0;
    const networkResponse = new Response('audio', { status: 200 });
    const helpers = loadServiceWorkerHelpers({
      fetch: async () => networkResponse,
      caches: {
        match: async () => undefined,
        open: async () => ({
          put: async () => {
            putCount += 1;
            throw new Error('Quota exceeded');
          },
        }),
      },
    });

    const response = await helpers.cacheFirst(mockRequest('/music/hold.mp3'));

    expect(response).toBe(networkResponse);
    expect(response.status).toBe(200);
    expect(putCount).toBe(1);
  });

});
