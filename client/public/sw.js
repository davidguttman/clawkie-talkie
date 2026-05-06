/*
 * Service worker for Clawkie-Talkie.
 *
 * Voice-app safety rules:
 * - Never handles non-GET requests.
 * - Never caches API/signaling/SSE/websocket-like requests.
 * - Uses network-first for HTML and app bundles so updates win.
 * - Caches only same-origin public static assets: icons, splash screens,
 *   fonts/images, hold music, fixture audio, and audio worklets.
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `clawkie-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `clawkie-runtime-${CACHE_VERSION}`;
const CACHE_PREFIX = 'clawkie-';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/voice/',
  '/voice.html',
  '/dashboard/',
  '/manifest.json',
  '/sw.js',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-maskable-192x192.png',
  '/icons/icon-maskable-512x512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== STATIC_CACHE && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin !== self.location.origin) return;
  if (shouldBypass(request, url)) return;

  if (request.mode === 'navigate' || isHtmlRequest(request, url) || isUpdateSensitiveAsset(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

function shouldBypass(request, url) {
  if (isRangeRequest(request)) return true;
  if (request.headers.get('upgrade') === 'websocket') return true;
  if (request.headers.get('accept')?.includes('text/event-stream')) return true;
  if (hasSensitiveQuery(url)) return true;

  return url.pathname.startsWith('/api/') ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/signal') ||
    url.pathname.startsWith('/subscribe') ||
    url.pathname.startsWith('/socket') ||
    url.pathname.startsWith('/ws');
}

function hasSensitiveQuery(url) {
  for (const key of url.searchParams.keys()) {
    if (/token|key|secret|credential|session|room|peer|host|channel|target|account/i.test(key)) {
      return true;
    }
  }
  return false;
}

function isHtmlRequest(request, url) {
  return request.headers.get('accept')?.includes('text/html') || /\.html?$/.test(url.pathname);
}

function isUpdateSensitiveAsset(url) {
  return /\.(?:js|css|json)$/.test(url.pathname) &&
    !url.pathname.startsWith('/icons/') &&
    !url.pathname.startsWith('/splash/');
}

function isRangeRequest(request) {
  return request.headers.get('range') !== null;
}

function isStaticAsset(url) {
  const pathname = url.pathname;
  return pathname.startsWith('/icons/') ||
    pathname.startsWith('/splash/') ||
    pathname.startsWith('/music/') ||
    pathname.startsWith('/fixtures/') ||
    pathname.startsWith('/audio/') ||
    /\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|mp3|wav|pcm|m4a|ogg|woff2?|ttf|eot)$/.test(pathname);
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    await putIfCacheable(request, response);
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    await putIfCacheable(request, response);
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    if (request.mode === 'navigate') {
      if (new URL(request.url).pathname.startsWith('/dashboard')) {
        const dashboardCached = await caches.match('/dashboard/');
        if (dashboardCached) return dashboardCached;
      }
      const voiceCached = await caches.match('/voice/');
      if (voiceCached) return voiceCached;
      const indexCached = await caches.match('/index.html');
      if (indexCached) return indexCached;
    }

    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function putIfCacheable(request, response) {
  if (
    !response ||
    !response.ok ||
    response.type === 'opaque' ||
    response.status === 206 ||
    isRangeRequest(request)
  ) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || hasSensitiveQuery(url)) return;
  if (shouldBypass(request, url)) return;

  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
  } catch {
    // Cache writes are best-effort. Audio Range/partial responses and quota
    // failures must never turn a successful network fetch into a 503.
  }
}
