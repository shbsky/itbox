/* IT工具箱 Service Worker */
const CACHE = 'itbox-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css',
  './assets/js/util.js',
  './assets/js/data.js',
  './assets/js/tools-net.js',
  './assets/js/tools-linux.js',
  './assets/js/tools-db.js',
  './assets/js/tools-cloud.js',
  './assets/js/app.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map((u) => cache.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        return (await caches.match('./index.html')) ||
          new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) {
        caches.open(CACHE).then((c) => c.put(req, res.clone()));
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
