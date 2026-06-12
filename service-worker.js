const CACHE = "stn-care-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./routine.data.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];
const APP_SHELL = new Set(ASSETS);

async function fetchFresh(asset) {
  const url = new URL(asset, self.location);
  url.searchParams.set("sw", CACHE);
  return fetch(new Request(url, { cache: "reload" }));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map(async (asset) => {
      const response = await fetchFresh(asset);
      if (response && response.ok) await cache.put(asset, response);
    }));
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const staleKeys = keys.filter((key) => key.startsWith("stn-care-") && key !== CACHE);
    await Promise.all(staleKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clientsList.find((client) => "focus" in client);
    if (existing) {
      await existing.focus();
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow("./");
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const sameOrigin = url.origin === self.location.origin;
    const key = sameOrigin && (url.pathname.endsWith("/") || url.pathname.endsWith("/stn-skin-care/"))
      ? "./"
      : `.${url.pathname.slice(self.location.pathname.replace(/service-worker\.js$/, "").length - 1)}`;
    const preferFresh = event.request.mode === "navigate" || (sameOrigin && APP_SHELL.has(key));

    try {
      const response = preferFresh ? await fetch(new Request(event.request, { cache: "reload" })) : await fetch(event.request);
      const cache = await caches.open(CACHE);
      if (response && response.ok) cache.put(preferFresh && APP_SHELL.has(key) ? key : event.request, response.clone()).catch(() => {});
      return response;
    } catch (err) {
      const cached = await caches.match(preferFresh && APP_SHELL.has(key) ? key : event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") {
        const fallback = await caches.match("./index.html");
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
