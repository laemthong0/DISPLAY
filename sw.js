const CACHE_PREFIX = "laemthong-display-shell-";
const CACHE_NAME = CACHE_PREFIX + "v7";
const APP_SHELL = ["./", "./index.html", "./control.html", "./display-config.js", "./site.webmanifest", "./favicon.svg", "./favicon.png", "./apple-touch-icon.png"];
const SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Cache only the shell, under a fixed key; _ts/version checks must not grow
  // storage indefinitely or serve an old release manifest when offline.
  url.search = "";
  if (!SHELL_URLS.has(url.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(url.href, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});
