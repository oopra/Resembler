/* Service worker. The point of it here is not offline-for-its-own-sake: it is that the face mesh is
   about 16 MB of runtime and model, and nobody should download that twice. Two strategies:
     • The mesh and its model (/vendor, /models): CACHE-FIRST and never revalidated. They are pinned
       versions that only change when this file's VERSION does, so re-checking them costs a round
       trip to learn nothing.
     • Everything else (the page, CSS, JS): NETWORK-FIRST with a cache fallback, so a new deploy
       shows up immediately and the app still opens with the network off.
   Bump VERSION on release to retire the old caches. */
const VERSION = 'v1';
const SHELL = 'shell-' + VERSION;
const HEAVY = 'mesh-' + VERSION;
const CORE = ['./', './index.html', './css/styles.css', './js/faces.js', './js/measure.js',
              './js/mesh.js', './js/resemble.js', './js/app.js', './manifest.webmanifest',
              './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== HEAVY).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function cacheFirst(req, cacheName) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(cacheName).then((c) => c.put(req, copy)); }
    return res;
  }));
}
function networkFirst(req) {
  return fetch(req)
    .then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/') || url.pathname.includes('/models/')) {
    e.respondWith(cacheFirst(req, HEAVY));
    return;
  }
  e.respondWith(networkFirst(req));
});
