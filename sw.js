// Garde la page en mémoire dans le navigateur de la Tesla : elle s'ouvre ensuite même sans réseau
// (parking souterrain, Wi-Fi du T2C sans internet). À chaque ouverture avec réseau, la copie est mise à jour.
const CACHE = 'carplay-v5';
const FILES = ['./', './index.html', './app.js', './decoder-worker.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Réseau d'abord (2 s max), sinon la copie en mémoire.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      const r = await fetch(e.request, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
