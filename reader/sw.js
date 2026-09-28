/* kill-switch SW — replaces the old editor's cache-first worker.
   Clears every legacy cache, unregisters nothing but claims clients,
   and never caches anything itself. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", () => {}); // pass-through, no caching
