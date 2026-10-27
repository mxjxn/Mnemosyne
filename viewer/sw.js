const CACHE = 'notes-shell-v45';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // App navigations (incl. query-param launches like /?capture=1):
  // network-first so deploys reach users immediately, cached shell as
  // offline fallback. A bare caches.match() misses precached '/' when
  // the URL carries a query string, so look up '/' for navigations.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/', clone));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }
  // API calls: network-first (always fresh data)
  if (e.request.url.includes('/api/')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Cache successful API responses for offline fallback
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

// ── Push notifications ──

self.addEventListener('push', (e) => {
  let data;
  try {
    data = e.data.json();
  } catch {
    data = { title: 'Knowledge Base', body: e.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'default',
    data: { url: data.url || '/' },
    vibrate: [100, 50, 100],
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'Knowledge Base', options)
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const url = e.notification.data?.url || '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(url);
    })
  );
});
