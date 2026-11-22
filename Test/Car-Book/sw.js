/* MNS Tours & Travels — service worker.
   Makes the app installable and lets it open without internet (last saved version).
   Pages are fetched fresh when online (network first), so updates show up straight away.
   Calls to the Cloudflare Worker are never cached. */
const CACHE = 'mns-tours-v16';
const SHARE_CACHE = 'mns-share';   // holds one shared file until the app picks it up
const FILES = ['./', './index.html', './driver.html', './manifest.json', './uber-report.js',
               './logo-192.png', './logo-512.png', './logo-192-maskable.png', './logo-512-maskable.png',
               './logo.png', './favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Share → "MNS Tours & Travels" (Android): keep the shared Uber CSV, then open the app, which imports it
  if (e.request.method === 'POST' && url.searchParams.has('share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData(), f = fd.get('file');
        if (f && typeof f.text === 'function') {
          const c = await caches.open(SHARE_CACHE);
          await c.put('./shared-file', new Response(await f.text(), { headers: { 'X-Name': encodeURIComponent(f.name || 'report.csv') } }));
        }
      } catch (err) { /* nothing shared — the app just opens */ }
      return Response.redirect('./index.html?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // API + fonts go straight to the network
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
