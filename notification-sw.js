/* Adonai Store — system pop-up helper (service worker).
 *
 * Its only job is to show operating-system notifications for store activity
 * and to bring the POS / Admin window forward when one is clicked. It has NO
 * fetch handler and caches nothing, so pages, prices and stock are always
 * loaded live from the server exactly as before.
 */
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

function sameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch (e) { return false; }
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data || {};
  const fallback = new URL("admin.html", self.registration.scope).href;
  const target = data.url && sameOrigin(new URL(data.url, self.registration.scope).href)
    ? new URL(data.url, self.registration.scope).href
    : fallback;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer a window that already shows the destination page, then any open
    // POS / Admin window. Each page navigates itself when it receives the message.
    const path = new URL(target).pathname;
    const match = windows.find(w => sameOrigin(w.url) && new URL(w.url).pathname === path)
      || windows.find(w => sameOrigin(w.url) && /\/(admin|pos)(\.html)?$/.test(new URL(w.url).pathname));
    if (match) {
      try { await match.focus(); } catch (e) {}
      match.postMessage({ type: "adonai-open-notification", url: target, id: data.id || "" });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
