// Service worker for the PWA remote (ticket 04).
// Cache-first for the app shell; no runtime caching of anything else.

const CACHE = 'rsdoktorhut-v1';
const SHELL = [
  '.',
  'index.html',
  'style.css',
  'js/app.js',
  'js/model.js',
  'js/ble.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
