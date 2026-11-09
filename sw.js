/* PrOS Service Worker — v2
 * Strategies:
 *  - Navigation requests: network-first, offline fallback to cached shell
 *  - Local core assets: cache-first (precached at install)
 *  - CDN assets (Tailwind/Lucide/Chart.js): stale-while-revalidate
 *  - Install is tolerant: precache failures don't block activation
 */
const CACHE_NAME = 'pros-cache-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://placehold.co/100x100/1e293b/10b981?text=U',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Tolerant precache: one flaky CDN must not break the whole install
    await Promise.allSettled([
      ...APP_SHELL.map(url => cache.add(url)),
      ...CDN_ASSETS.map(url => cache.add(url)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req.url.startsWith('http')) return;
  if (req.method !== 'GET') return;

  // 1. Navigations: network-first with offline shell fallback
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match('./index.html');
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 2. Local files: cache-first, then network (and backfill cache)
  if (new URL(req.url).origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (e) {
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 3. CDNs: stale-while-revalidate (instant from cache, refresh in background)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const refresh = fetch(req).then(res => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const fresh = await refresh;
    return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
