/* MNS Tours & Travels — service worker.
   Makes the app installable and lets it open without internet (last saved version).
   Pages are fetched fresh when online (network first), so updates show up straight away.
   Calls to the Cloudflare Worker are never cached. */
const CACHE = 'mns-tours-v2';
const FILES = ['./', './index.html', './driver.html', './manifest.json', './driver-manifest.json',
               './icon-192.png', './icon-512.png', './icon-192-maskable.png', './icon-512-maskable.png',
               './logo.png', './favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // API + fonts go straight to the network
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
