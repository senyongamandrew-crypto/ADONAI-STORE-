/* Adonai Store — background ticker for the notification bell.
 * Browsers slow main-page timers to about once a minute when the POS window is
 * minimised for a while. Dedicated worker timers keep their schedule, so new
 * orders still pop up (and ring) within seconds. Holds no data at all.
 */
"use strict";
const timers = new Map();
self.onmessage = event => {
  const data = event.data || {};
  if (data.cmd === "set" && typeof data.id === "number") {
    clearTimeout(timers.get(data.id));
    timers.set(data.id, setTimeout(() => { timers.delete(data.id); self.postMessage({ id: data.id }); },
      Math.max(0, Math.min(Number(data.ms) || 0, 600000))));
  } else if (data.cmd === "clear") {
    clearTimeout(timers.get(data.id));
    timers.delete(data.id);
  }
};
