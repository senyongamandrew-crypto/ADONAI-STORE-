/* Adonai Delivery — offline shell for the rider app.
 *
 * Scope is /delivery only: the storefront, POS register and Admin Suite keep
 * their own caches and are never controlled by this worker. API requests are
 * NEVER cached — a delivery state must come from the server, never from a
 * stale service-worker response. Navigation is network-first so a deployed
 * update is visible on the next visit, with the shell as a fallback.
 */
const CACHE = "adonai-delivery-v2"; // v2: sign-in, check-in and connect screens
const SHELL = [
  "/delivery",
  "/css/delivery.css",
  "/js/delivery-app.js",
  "/manifest-delivery.json",
  "/assets/delivery-icon-192.png",
  "/assets/delivery-icon-512.png",
  "/assets/adonai-logo-horizontal-light.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;          // live data only
  if (url.pathname.startsWith("/notification")) return;  // SSE / SW endpoints

  const isShell = SHELL.some(path => url.pathname === path.split("?")[0]);
  if (!isShell) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match("/delivery")))
  );
});
