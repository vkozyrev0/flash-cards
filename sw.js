// Tiny offline-first service worker for Ukrainian Cards.
// The HTML embeds all data inline, so caching the HTML alone makes the app fully offline.
// Bump CACHE_VERSION when shipping new HTML/assets so old caches are evicted.

const CACHE_VERSION = 'ukr-cards-v1';
const ASSETS = [
  './language-cards.html',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Only cache same-origin requests; let translation API calls hit the network normally.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        // Cache successful responses on the fly so the app survives going offline.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./language-cards.html'))
    )
  );
});
