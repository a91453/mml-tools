const CACHE = '__CACHE_NAME__';
const ASSETS = __PRECACHE__;
// cache:'reload' bypasses the browser HTTP cache (lesson from the earlier frontend's sw.js).
// A plain addAll may be answered from an HTTP cache that still holds the previous
// release, which would store old modules under this release's cache name.
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path => new Request(path, { cache: 'reload' }))))));
// Never skipWaiting on install: a live review must not mix old/new Canonical
// modules. The page applies a waiting release only on an explicit user request,
// after its task queue is idle and its project is saved (studio/web/pwa-update.mjs).
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', event => event.waitUntil((async () => {
  // Prefix-scoped cleanup: the origin may host other apps' caches.
  for (const key of await caches.keys()) if (key.startsWith('mml-studio-v1-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const allowed = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
  if (!allowed.has(url.href)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request).then(hit => hit || fetch(event.request))));
});
