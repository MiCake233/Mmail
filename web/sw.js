/*!
 * Mmail · service worker for the web build / PWA
 * ---------------------------------------------------------------------------
 * Caches the app shell so the launcher opens offline; signing in still needs the network.
 * Bump CACHE on every release, otherwise clients keep the old shell.
 *
 * Bump CACHE when shipping changes, otherwise clients keep the old shell.
 */

const CACHE = 'mmail-shell-v2';

const SHELL = [
  './',
  './index.html',
  './src/styles.css',
  './src/providers.js',
  './src/i18n.js',
  './src/app.js',
  './assets/icon-192.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
