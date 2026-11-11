// App-shell cache so the installed app opens instantly and shows a clear offline state.
// API responses (financial data) are never cached by the service worker.
const CACHE = 'br-shell-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request).then(r => { caches.open(CACHE).then(c => c.put('/', r.clone())); return r; }).catch(() => caches.match('/'))); return; }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/ocr/'))
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })));
});
