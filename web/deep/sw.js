/* Offline shell for the deep. Bump CACHE when the shell files change.
   three.js is large, so it is cached on first visit and never re-fetched
   unless the version in the URL changes. */
const CACHE = "mnemoquarium-deep-v1.0.0";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./icon.svg",
  "./manifest.webmanifest",
  "./vendor/three.module.min.js",
  "../engine.js",
  "./src/main.js",
  "./src/game.js",
  "./src/config.js",
  "./src/util.js",
  "./src/mnemo.js",
  "./src/bus.js",
  "./src/geo.js",
  "./src/ecology.js",
  "./src/progression.js",
  "./src/save.js",
  "./src/world.js",
  "./src/vfx.js",
  "./src/fish.js",
  "./src/creatures.js",
  "./src/combat.js",
  "./src/sub.js",
  "./src/hud.js",
  "./src/audio.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One bad path must not sink the whole install, so each file is added alone.
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // three.js never changes for a given build: cache first, it is 650 KB.
  if (url.pathname.includes("/vendor/")) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })),
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./index.html"))),
  );
});
