self.__PRECACHE__ = ["/assets/index-BhANsw66.css","/assets/index-BkAQ1Dda.js","/assets/worker-D_0vyfU-.js"];
self.__BUILD__ = "a82dc2a517ec";
// Offline support. Hashed /assets/* files are cached forever (cache-first);
// the shell, the wasm and the manifest are network-first with cache fallback
// so updates land when online and everything still works offline.
// __PRECACHE__ is replaced at build time with the hashed asset list.
const EXTRA = self.__PRECACHE__ || [];
const CACHE = "fable-poker-" + (self.__BUILD__ || "dev");

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll(
          ["/", "/solver.wasm", "/manifest.webmanifest", "/icon.svg"].concat(
            EXTRA
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.startsWith("/assets/")) {
    // content-hashed: immutable, cache-first
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((resp) => {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return resp;
          })
      )
    );
  } else {
    // shell / wasm / manifest: network-first, fall back to cache offline
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return resp;
        })
        .catch(() =>
          caches
            .match(e.request)
            .then((hit) => hit || caches.match("/"))
        )
    );
  }
});
