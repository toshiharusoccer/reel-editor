const CACHE_NAME = "reel-editor-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isAppShell = url.origin === location.origin;
  const isFFmpegAsset = url.hostname.includes("jsdelivr.net");

  if (isAppShell) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
  } else if (isFFmpegAsset) {
    // cache the (large) ffmpeg core files so repeat visits skip the download
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      })
    );
  }
});
