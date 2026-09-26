// Offline-first service worker for Ukrainian Cards.
// App shell (HTML + card JSON) is network-first so shipped updates reach installed users.
// Other same-origin assets are cache-first. Translation API calls are left on the network.

const CACHE_VERSION = 'ukr-cards-v3';
const ASSETS = [
  './language-cards.html',
  './ukr-cards-categorized.json',
  './lexicon.json',
  './manifest.json',
  './icon.svg',
  './index.html',
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

function isAppShell(req, url) {
  if (req.mode === 'navigate' || req.destination === 'document') return true;
  const path = url.pathname;
  return path.endsWith('.html') || path.endsWith('.json') || path.endsWith('/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Translation proxy: never cached, and GET /api/health must reach the server every time.
  if (url.pathname.startsWith('/api/')) return;

  if (isAppShell(req, url)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate' || req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
          return caches.match('./language-cards.html');
        }
        return Response.error();
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
