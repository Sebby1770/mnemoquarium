/* Offline shell for the game. Bump CACHE when the shell files change.
   three.js is large, so it is cached on first visit and never re-fetched
   unless the version in the URL changes. */
const CACHE = "mnemoquarium-deep-v1.11.0";
const SHELL = [
  "./",
  "./index.html",
  "./play.html",
  "./guide.html",
  "./site.css",
  "./src/site.js",
  "./press/reef.jpg",
  "./press/hangar.jpg",
  "./press/cabin.jpg",
  "./styles.css",
  "./icon.svg",
  "./manifest.webmanifest",
  "./vendor/three.module.min.js",
  "./engine.js",
  "./src/main.js",
  "./src/game.js",
  "./src/config.js",
  "./src/util.js",
  "./src/mnemo.js",
  "./src/bus.js",
  "./src/water.js",
  "./src/landmarks.js",
  "./src/sky.js",
  "./src/post.js",
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
  "./src/nav.js",
  "./src/quality.js",
  "./src/chart.js",
  "./src/stick.js",
  "./src/input.js",
  "./src/frame.js",
  "./src/ambient.js",
  "./src/walk.js",
  "./src/submodel.js",
  "./src/base.js",
  "./src/cabin.js",
  "./src/interior.js",
  "./src/dock-detail.js",
  "./src/giants.js",
  "./src/workshop.js",
  "./src/share.js",
  "./src/daily.js",
  "./src/analytics.js",
  "./src/photo.js",
  "./src/grade.js",
  "./src/goals.js",
  "./src/logbook.js",
  "./src/plankton.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // A partial shell cannot run offline. Keep the previous worker if any
      // required file fails instead of activating a broken set of modules.
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("mnemoquarium-deep-") && key !== CACHE).map((key) => caches.delete(key))))
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

  /* Network first, and past the HTTP cache too. A plain fetch() goes through
     the browser's own cache, and Pages serves everything with max-age=600, so
     for ten minutes after a deploy a returning player could be handed a mix
     of new and old modules — which is how a build breaks with no error worth
     reading. "no-cache" revalidates every request (a cheap 304 when nothing
     changed); the cache below is only for playing offline. */
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(event.request);
        if (hit) return hit;
        // A phrase or daily query changes the sea, not the app shell. Serve
        // the right page offline; never hand HTML to a failed module import.
        if (event.request.mode === "navigate") {
          const page = url.pathname.endsWith("/play.html") ? "./play.html"
            : url.pathname.endsWith("/guide.html") ? "./guide.html" : "./index.html";
          const shell = await cache.match(page);
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
