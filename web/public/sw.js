/*
 * Rune offline service worker (hand-rolled, no workbox).
 *
 * The app is fully client-side: the document lives in localStorage and the
 * only network traffic is optional share/sync to the Hono server under /api/*
 * and /d/*. Those MUST NOT be cached — they are always live. Everything else
 * is a static, content-hashed app shell that can run offline.
 *
 * Strategy:
 *   - /assets/*            cache-first, network fallback  (Vite hashes these
 *                          names and they are immutable, so a hit is always
 *                          correct; a miss populates the cache).
 *   - navigations / HTML   network-first, cache fallback  (so a fresh index.html
 *                          — which references the latest hashed bundles — wins
 *                          when online, but we still boot offline).
 *   - other same-origin    cache-first, network fallback  (manifest, icons).
 *   - /api/*, /d/*         never intercepted (live share/sync).
 *   - cross-origin         never intercepted.
 *
 * Bump CACHE_VERSION to invalidate every client's shell on next activate.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `rune-shell-${CACHE_VERSION}`;

// The minimal shell we can name up-front. Hashed /assets/* bundles are cached
// lazily on first fetch (their names are unknowable to a static worker).
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Best-effort: a single missing file must not abort the whole install.
      await Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      );
      // Take over as soon as installed rather than waiting for all tabs to close.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('rune-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// Never touch live server surfaces — share publish + raw snapshot bytes.
function isNetworkOnly(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/');
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) || (await cache.match('/index.html'));
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever handle GETs; leave POST /api/publish etc. alone.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (fonts already inline to /assets, but be defensive) — bypass.
  if (url.origin !== self.location.origin) return;

  // Live server surfaces — never cache, never intercept.
  if (isNetworkOnly(url)) return;

  // Navigations / HTML documents — network-first so the freshest shell wins.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Immutable, content-hashed bundles — cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else same-origin (manifest, icons) — cache-first.
  event.respondWith(cacheFirst(request));
});
