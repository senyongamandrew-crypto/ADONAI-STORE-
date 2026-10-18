/* Adonai Store — Operator notifications v3.0
 * Durable history is fetched immediately, every five seconds, and after local
 * store actions. Delivery never depends on SSE opening successfully or on one
 * particular server worker. Full notification text stays in memory only;
 * sessionStorage holds read IDs, not customer/financial data or credentials.
 *
 * v3.0 adds:
 *  - System pop-ups: the Windows / macOS / Linux notification centre (Web
 *    Notifications + a cache-free service worker) and the Android notification
 *    shade inside the Adonai POS APK (native `Android.showStoreAlert` bridge).
 *    By default they appear when the POS is minimised or in another window,
 *    so nothing is missed while the cashier works elsewhere.
 *  - A simple notification sound (one short "ding" per batch of new
 *    activity) with on/off and volume on this device.
 *  - Inbox multi-select: press and hold (or right-click) a message to show
 *    selection boxes, then Select all / Mark read / Delete permanently. The
 *    boxes are hidden again as soon as the action is done or cancelled.
 */
(function () {
  "use strict";

  const READ_KEY = "adonai.notifications.read-ids.v2";
  // Deleted-on-this-device IDs only (no alert text), so they can't leak payloads.
  const DELETED_KEY = "adonai.notifications.deleted.v1";
  const HOLD_KEY = "adonai.notifications.hold.v1"; // retired: removed on load
  const DELETED_MAX = 300;
  const MAX_LOCAL = 100;
  const MAX_READ = 300;
  const POLL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 10000;
  const TOAST_LIFETIME_MS = 5000;
  // Device preferences only (booleans), never notification text.
  const PREFS_KEY = "adonai.notifications.prefs.v1";
  const PROMPTED_KEY = "adonai.notifications.popup-prompted.v1";
  const SW_URL = "notification-sw.js";
  const TICKER_URL = "js/notification-ticker.js";
  const LONG_PRESS_MS = 500;
  const MAX_SYSTEM_PER_SYNC = 3;
  // Orders and customer messages: the pop-up stays on screen until it is seen.
  const URGENT_TYPES = new Set(["NEW_ORDER", "NEW_MESSAGE", "ORDER_PAID"]);
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const BELL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const TYPE_META = {
    NEW_ORDER: { label: "Checkout / order", icon: "🛍️", view: "sales" },
    NEW_MESSAGE: { label: "Customer note", icon: "💬", view: "sales" },
    ORDER_UPDATED: { label: "Order update", icon: "📦", view: "dispatch" },
    DELIVERY_ASSIGNED: { label: "Delivery assigned", icon: "🚚", view: "dispatch" },
    DELIVERY_PROGRESS: { label: "Rider delivery update", icon: "📍", view: "dispatch" },
    RIDER_ADDED: { label: "Partner added", icon: "🛵", view: "dispatch" },
    RIDER_UPDATED: { label: "Partner profile", icon: "👤", view: "dispatch" },
    RIDER_STATUS_UPDATED: { label: "Partner availability", icon: "🟢", view: "dispatch" },
    RIDER_ARCHIVED: { label: "Partner archived", icon: "🗂️", view: "dispatch" },
    RIDER_PAIRING_CODE_ISSUED: { label: "Phone pairing code", icon: "🔑", view: "dispatch" },
    RIDER_PHONE_PAIRED: { label: "Partner phone paired", icon: "📱", view: "dispatch" },
    RIDER_PHONE_REVOKED: { label: "Partner phone access", icon: "🔒", view: "dispatch" },
    RIDER_DUTY_STARTED: { label: "Rider duty started", icon: "▶️", view: "dispatch" },
    RIDER_DUTY_STOPPED: { label: "Rider duty stopped", icon: "⏸️", view: "dispatch" },
    ORDER_PAID: { label: "Payment received", icon: "💳", view: "sales" },
    ORDER_EXPIRED: { label: "Payment expired", icon: "⌛", view: "sales" },
    LOW_STOCK: { label: "Stock warning", icon: "⚠️", view: "inventory" },
    STOCK_ADDED: { label: "Stock intake", icon: "👕", view: "inventory" },
    STOCK_UPDATED: { label: "Stock update", icon: "🏷️", view: "inventory" },
    STOCK_REMOVED: { label: "Stock removal", icon: "🗃️", view: "inventory" },
    NEW_EXPENSE: { label: "Expense", icon: "🧾", view: "payments" },
    EXPENSE_UPDATED: { label: "Expense update", icon: "🧾", view: "payments" },
    EXPENSE_VOIDED: { label: "Expense voided", icon: "↩️", view: "payments" },
    STOCK_LOT_RECEIVED: { label: "Stock lot", icon: "📦", view: "payments" },
    STOCK_MARKDOWN: { label: "Markdown", icon: "🏷️", view: "payments" },
    STOCK_WRITTEN_OFF: { label: "Write-off", icon: "🗃️", view: "payments" },
    SETTINGS_UPDATED: { label: "Store settings", icon: "⚙️", view: "settings" }
  };

  function loadIdSet(key, cap) {
    try {
      const ids = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string").slice(-cap) : []);
    } catch (e) { return new Set(); }
  }
  function saveIdSet(key, set, cap) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set).slice(-cap))); } catch (e) {}
  }

  class NotificationManager {
    constructor() {
      this.history = [];
      this.seenIds = new Set();
      this.readIds = this.restoreReadIds();
      this.deletedIds = loadIdSet(DELETED_KEY, DELETED_MAX);
      saveIdSet(DELETED_KEY, this.deletedIds, DELETED_MAX);
      try { localStorage.removeItem(HOLD_KEY); } catch (e) {}
      this.unreadCount = 0;
      this.prefs = this.loadPrefs();
      this.selecting = false;
      this.selected = new Set();
      this.lastSelectedId = null;
      this.confirmingDelete = false;
      this.deleting = false;
      this.hasSynced = false;
      this.failures = 0;
      this.accessEpoch = 0;
      this.status = "loading";
      this.inFlight = null;
      this.pendingRefresh = false;
      this.controller = null;
      this.stopped = false;
      // Old versions shared sensitive notification payloads across operators.
      try {
        localStorage.removeItem("adonai.notifications.log");
        localStorage.removeItem("adonai.notifications.readmark");
      } catch (e) {}
      this.injectUI();
      this.bindUIEvents();
      this.renderDrawerList();
      this.updateBadgeUI();
      this.renderAlertSettings();
      // Pop-ups already allowed earlier: get the click-to-open helper ready.
      if (this.systemSupport() === "web" && this.systemPermission() === "granted") this.serviceWorker();
      window.__adonaiStoreAlertPermission = () => this.renderAlertSettings();
      this.connectStream();
    }

    /* Reliable, short-lived authenticated requests, not worker-bound SSE. */
    connectStream() { return this.syncHistory(); }

    headers() {
      const auth = typeof Auth !== "undefined" && Auth.authHeaders ? Auth.authHeaders() : {};
      const areas = typeof PosAccess !== "undefined" && PosAccess.headers ? PosAccess.headers() : {};
      return Object.assign({}, auth, areas);
    }

    scheduleRefresh(delay = POLL_MS) {
      clearTimeout(this.pollTimer);
      this.clearTicker();
      if (this.stopped) return;
      // Minimised windows: a worker timer keeps the 5-15 s rhythm instead of
      // the browser's once-a-minute throttling, so pop-ups are not late.
      const ticker = document.hidden && delay > 0 ? this.ticker() : null;
      if (ticker) {
        this._tickId = (this._tickId || 0) + 1;
        ticker.postMessage({ cmd: "set", id: this._tickId, ms: delay });
      } else this.pollTimer = setTimeout(() => this.syncHistory(), delay);
    }
    ticker() {
      if (this._ticker === undefined) {
        this._ticker = null;
        try {
          if (typeof window.Worker === "function" && !this.nativeBridge()) {
            const worker = new window.Worker(TICKER_URL);
            worker.onmessage = event => { if (event.data && event.data.id === this._tickId) this.syncHistory(); };
            worker.onerror = () => { this._ticker = null; this.scheduleRefresh(POLL_MS); };
            this._ticker = worker;
          }
        } catch (e) { this._ticker = null; }
      }
      return this._ticker;
    }
    clearTicker() {
      if (this._ticker && this._tickId) this._ticker.postMessage({ cmd: "clear", id: this._tickId });
      this._tickId = (this._tickId || 0) + 1;
    }

    requestRefresh(delay = 150) {
      if (this.inFlight) { this.pendingRefresh = true; return; }
      this.scheduleRefresh(delay);
    }

    syncHistory() {
      clearTimeout(this.pollTimer);
      this.clearTicker();
      if (this.stopped) return Promise.resolve(false);
      if (this.inFlight) { this.pendingRefresh = true; return this.inFlight; }
      this.inFlight = this.fetchHistory().finally(() => {
        this.inFlight = null;
        this.controller = null;
        const pending = this.pendingRefresh;
        this.pendingRefresh = false;
        const interval = this.failures ? Math.min(30000, POLL_MS * Math.pow(2, this.failures - 1)) : (document.hidden ? 15000 : POLL_MS);
        this.scheduleRefresh(pending ? 0 : interval);
      });
      return this.inFlight;
    }

    async fetchHistory() {
      let timer;
      let epoch = this.accessEpoch;
      try {
        if (this.stopped) return false;
        epoch = this.accessEpoch;
        this.controller = typeof AbortController === "function" ? new AbortController() : null;
        const controller = this.controller;
        timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
        const path = "/api/notifications?limit=" + MAX_LOCAL;
        const endpoint = typeof DB !== "undefined" && DB.apiUrl ? DB.apiUrl(path) : path;
        const res = await fetch(endpoint, { headers: this.headers(), cache: "no-store", signal: controller ? controller.signal : undefined });
        if (!res.ok) {
          const error = new Error("Notification history " + res.status);
          error.status = res.status;
          throw error;
        }
        const data = await res.json();
        if (!data.ok || !Array.isArray(data.notifications)) throw new Error("Invalid notification history");
        if (epoch !== this.accessEpoch || this.stopped) return false;
        const byId = new Map();
        data.notifications.forEach(n => {
          if (n && typeof n.id === "string" && typeof n.type === "string") byId.set(n.id, n);
        });
        const list = Array.from(byId.values()).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, MAX_LOCAL);
        const fresh = list.filter(n => !this.seenIds.has(n.id));
        // Replace, don't append: every response is permission-filtered. A
        // revoked password must also remove text from an already-seen alert.
        this.history = list;
        const toasts = document.getElementById("toastContainer");
        if (toasts) Array.from(toasts.children).forEach(toast => {
          const current = byId.get(toast.dataset.notificationId);
          if (!current || current.protected) toast.remove();
        });
        list.forEach(n => this.seenIds.add(n.id));
        if (this.seenIds.size > 400) this.seenIds = new Set(Array.from(this.seenIds).slice(-400));
        if (this.hasSynced) {
          // A checkout must not lose its chime/toast behind several stock
          // warnings emitted by the same basket.
          const visibleFresh = fresh.filter(n => !this.deletedIds.has(n.id));
          const priority = visibleFresh.filter(n => n.type === "NEW_ORDER").concat(visibleFresh.filter(n => n.type !== "NEW_ORDER"));
          priority.slice(0, 3).reverse().forEach(n => this.announce(n, { quiet: true }));
          if (priority.length) this.ding();
          if (priority.length > MAX_SYSTEM_PER_SYNC) this.systemSummary(priority.length - MAX_SYSTEM_PER_SYNC);
        }
        if (!this.hasSynced) setTimeout(() => this.maybePromptForPopups(), 1500);
        this.hasSynced = true;
        this.failures = 0;
        if (!(this._flashUntil > Date.now())) this.setStatus("live", "Updates connected · refreshes every 5 seconds");
        // Simply viewing the inbox must not silently mark every new alert read;
        // each row has its own read state and the header retains a bulk action.
        this.recountUnread();
        if (this.selecting) this.renderSelection(); else this.renderDrawerList();
        return true;
      } catch (error) {
        if (epoch !== this.accessEpoch || this.stopped) return false;
        this.failures++;
        if (error.status === 401 || error.status === 403) {
          this.history = [];
          const toasts = document.getElementById("toastContainer");
          if (toasts) toasts.replaceChildren();
          this.recountUnread();
          this.setStatus("offline", "Sign in to receive notifications");
        } else this.setStatus("offline", "Updates disconnected · retrying automatically");
        this.renderDrawerList();
        return false;
      } finally { if (timer) clearTimeout(timer); }
    }

    accessChanged() {
      // Never let a slow, privileged response repopulate a relocked drawer.
      this.accessEpoch++;
      if (this.controller) this.controller.abort();
      this.history = [];
      this.hasSynced = false;
      const toasts = document.getElementById("toastContainer");
      if (toasts) toasts.replaceChildren();
      this.recountUnread();
      this.setStatus("loading", "Checking notification access…");
      this.renderDrawerList();
      this.requestRefresh(0);
    }

    handleNotification(notification) {
      if (!notification || !notification.id) return;
      const fresh = !this.seenIds.has(notification.id);
      this.seenIds.add(notification.id);
      this.saveLocal(notification);
      if (fresh) { this.announce(notification, { quiet: true }); this.ding(); }
      this.recountUnread();
      this.renderDrawerList();
    }

    announce(notification, options = {}) {
      const urgent = URGENT_TYPES.has(notification.type);
      if (!options.quiet) this.ding();
      this.vibrate(urgent ? 120 : 45);
      if (!this.drawerOpen()) this.renderToast(notification);
      this.showSystemAlert(notification);
    }

    /* ---------------- System pop-ups (desktop + Android) ---------------- */
    loadPrefs() {
      const defaults = { system: true, foreground: false, sound: true, volume: 0.7 };
      try {
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
        Object.keys(defaults).forEach(key => {
          if (typeof saved[key] === typeof defaults[key]) defaults[key] = saved[key];
        });
      } catch (e) {}
      defaults.volume = Math.max(0.05, Math.min(1, Number(defaults.volume) || 0.7));
      return defaults;
    }

    /* ---------------- Simple notification sound ---------------- */
    audioContext() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!this._audioCtx) this._audioCtx = new Ctx();
        if (this._audioCtx.state === "suspended") this._audioCtx.resume().catch(() => {});
        return this._audioCtx;
      } catch (e) { return null; }
    }
    soundUnlocked() {
      return !!(this._audioCtx && this._audioCtx.state === "running");
    }
    ding(force) {
      if (!force && !this.prefs.sound) return false;
      // Android app in the background: the system notification makes the sound.
      const bridge = this.nativeBridge();
      if (!force && bridge && typeof bridge.storeAppVisible === "function") {
        try { if (!bridge.storeAppVisible()) return false; } catch (e) {}
      }
      // Several alerts arriving together still make one sound.
      const now = Date.now();
      if (!force && this._lastDing && now - this._lastDing < 1500) return false;
      this._lastDing = now;
      return this.playChime(this.prefs.volume);
    }
    savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch (e) {}
      this.renderAlertSettings();
    }
    nativeBridge() {
      const bridge = window.Android;
      return bridge && typeof bridge.showStoreAlert === "function" ? bridge : null;
    }
    systemSupport() {
      if (this.nativeBridge()) return "native";
      if (typeof window.Notification === "function" && window.isSecureContext !== false) return "web";
      return "none";
    }
    systemPermission() {
      const kind = this.systemSupport();
      if (kind === "native") {
        try { return String(this.nativeBridge().storeAlertPermission() || "default"); } catch (e) { return "default"; }
      }
      if (kind === "web") return String(window.Notification.permission || "default");
      return "unsupported";
    }
    systemReady() {
      return this.prefs.system && this.systemPermission() === "granted";
    }
    inBackground() {
      if (document.hidden) return true;
      try { return typeof document.hasFocus === "function" && !document.hasFocus(); } catch (e) { return false; }
    }
    serviceWorker() {
      if (!("serviceWorker" in navigator) || this.systemSupport() !== "web") return Promise.resolve(null);
      if (!this._swPromise) {
        if (!this._swListening) {
          this._swListening = true;
          navigator.serviceWorker.addEventListener("message", event => {
            const data = event.data || {};
            if (data.type !== "adonai-open-notification" || typeof data.url !== "string") return;
            if (data.id) this.setReadState(data.id, true);
            try {
              const target = new URL(data.url, location.href);
              if (target.origin === location.origin && target.href !== location.href) location.href = target.href;
            } catch (e) {}
          });
        }
        const ready = navigator.serviceWorker.register(SW_URL).then(() => navigator.serviceWorker.ready);
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), 4000));
        this._swPromise = Promise.race([ready, timeout]).catch(() => null);
      }
      return this._swPromise;
    }
    absoluteHref(notification) {
      const href = this.href(notification) || (/admin\.html/.test(location.pathname) ? location.pathname + location.search : "admin.html");
      try { return new URL(href, location.href).href; } catch (e) { return ""; }
    }
    showSystemAlert(notification, options = {}) {
      if (!notification || (!options.force && !this.systemReady())) return false;
      const kind = this.systemSupport();
      const urgent = URGENT_TYPES.has(notification.type);
      const title = String(notification.title || "Adonai Store").slice(0, 120);
      const body = String(notification.message || "").slice(0, 400);
      if (kind === "native") {
        const meta = TYPE_META[notification.type] || {};
        try {
          return !!this.nativeBridge().showStoreAlert(JSON.stringify({
            id: String(notification.id || "alert").slice(0, 80), title, body, type: String(notification.type || ""),
            view: meta.view || "", urgent, foreground: !!(options.force || this.prefs.foreground)
          }));
        } catch (e) { return false; }
      }
      if (kind !== "web") return false;
      // Desktop: the in-app toast covers the window you are looking at; the
      // system pop-up covers every other moment (minimised, other app, other tab).
      if (!options.force && !this.prefs.foreground && !this.inBackground()) return false;
      const url = this.absoluteHref(notification);
      const payload = {
        body, tag: "adonai-" + String(notification.id || "alert"), renotify: false,
        icon: "assets/icon-192.png", badge: "assets/favicon-32x32.png", lang: "en",
        // The page plays its own ding when it can; otherwise let the computer's
        // normal notification sound play with the pop-up.
        requireInteraction: urgent, silent: !this.prefs.sound || this.soundUnlocked(),
        timestamp: notification.timestamp ? Number(notification.timestamp) * 1000 : Date.now(),
        data: { url, id: notification.id || "" }
      };
      const fallback = () => {
        try {
          const popup = new window.Notification(title, payload);
          popup.onclick = () => {
            try { window.focus(); } catch (e) {}
            if (notification.id) this.setReadState(notification.id, true);
            if (url && url !== location.href) location.href = url;
            popup.close();
          };
          return true;
        } catch (e) { return false; }
      };
      this.serviceWorker().then(reg => {
        if (reg && typeof reg.showNotification === "function") return reg.showNotification(title, payload).catch(fallback);
        return fallback();
      }).catch(fallback);
      return true;
    }
    systemSummary(extra) {
      if (!extra || !this.systemReady()) return;
      this.showSystemAlert({ id: "summary-" + Date.now(), type: "SUMMARY", title: "Adonai Store",
        message: extra + " more store update" + (extra === 1 ? "" : "s") + " · open the bell to review" });
    }
    async enableSystemAlerts() {
      this.prefs.system = true;
      this.savePrefs();
      const kind = this.systemSupport();
      if (kind === "native") {
        try { this.nativeBridge().requestStoreAlertPermission(); } catch (e) {}
        return this.renderAlertSettings();
      }
      if (kind !== "web") return this.renderAlertSettings();
      let result = window.Notification.permission;
      try {
        if (result === "default") {
          const asked = window.Notification.requestPermission();
          result = asked && typeof asked.then === "function" ? await asked : window.Notification.permission;
        }
      } catch (e) { result = window.Notification.permission; }
      this.renderAlertSettings();
      if (result === "granted") {
        await this.serviceWorker();
        this.sendTestAlert();
      }
    }
    sendTestAlert() {
      const shown = this.showSystemAlert({ id: "test-" + Date.now(), type: "NEW_ORDER", title: "Pop-ups are on ✓",
        message: "New orders, customer messages and store changes will appear here, even while the POS is minimised." }, { force: true });
      if (!shown) this.flashSettingsNote("This device did not show the pop-up. Check that notifications are allowed for this app.");
    }
    flashSettingsNote(text) {
      const note = document.getElementById("notifAlertNote");
      if (note) { note.textContent = text; note.hidden = false; }
    }
    alertState() {
      const kind = this.systemSupport();
      const permission = this.systemPermission();
      const where = kind === "native" ? "this phone" : "this computer";
      if (kind === "none") return { state: "unsupported", text: "This browser can't show system pop-ups. Alerts still appear inside the POS." };
      if (permission === "denied") return { state: "blocked", text: kind === "native"
        ? "Pop-ups are blocked for Adonai POS. Allow notifications in Android settings."
        : "Pop-ups are blocked for this site. Click the 🔒 icon beside the web address → Notifications → Allow." };
      if (permission !== "granted") return { state: "off", text: "Get a pop-up on " + where + " for every new order, customer message and store change — even while the POS is minimised." };
      if (!this.prefs.system) return { state: "paused", text: "Pop-ups are paused on " + where + "." };
      return { state: "on", text: "Pop-ups are on for " + where + "." };
    }
    renderAlertSettings() {
      const bar = document.getElementById("notifAlertBar");
      if (!bar) return;
      const info = this.alertState();
      const open = !!this.settingsOpen;
      bar.dataset.state = info.state;
      // Pop-ups already on: keep the drawer clean until the gear is opened.
      bar.hidden = info.state === "on" && !open;
      const text = document.getElementById("notifAlertText");
      if (text) text.textContent = info.text;
      const enable = document.getElementById("notifAlertEnable");
      if (enable) {
        enable.hidden = !(info.state === "off" || info.state === "paused" || (info.state === "blocked" && this.systemSupport() === "native"));
        enable.textContent = info.state === "blocked" ? "Open settings" : info.state === "paused" ? "Resume pop-ups" : "Turn on pop-ups";
      }
      const panel = document.getElementById("notifAlertPanel");
      if (panel) panel.hidden = !open;
      const gear = document.getElementById("notifSettingsToggle");
      if (gear) gear.setAttribute("aria-expanded", String(open));
      const opts = document.getElementById("notifAlertOptions");
      if (opts) opts.hidden = info.state !== "on" && info.state !== "paused";
      const test = document.getElementById("notifTestPopup");
      if (test) test.hidden = info.state !== "on";
      const set = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
      set("notifPrefSystem", this.prefs.system);
      set("notifPrefForeground", this.prefs.foreground);
      set("notifPrefSound", this.prefs.sound);
      const volume = document.getElementById("notifPrefVolume");
      if (volume) { volume.value = String(Math.round(this.prefs.volume * 100)); volume.disabled = !this.prefs.sound; }
      const soundNote = document.getElementById("notifSoundNote");
      if (soundNote) {
        const waiting = this.prefs.sound && this._audioCtx !== undefined && !this.soundUnlocked() && this.systemSupport() !== "native";
        soundNote.hidden = !(waiting || (this.prefs.sound && !this._audioCtx && this.systemSupport() === "web"));
        soundNote.textContent = "After opening or refreshing the POS, click anywhere on the page once — browsers only allow sound after that. Pop-ups still use the computer's own notification sound.";
      }
    }
    maybePromptForPopups() {
      // A single, dismissible in-app invitation per device; browsers only
      // allow the permission prompt after a click, so it cannot be automatic.
      if (this.systemSupport() === "none" || this.systemPermission() !== "default") return;
      try { if (localStorage.getItem(PROMPTED_KEY)) return; localStorage.setItem(PROMPTED_KEY, "1"); } catch (e) { return; }
      const container = document.getElementById("toastContainer");
      if (!container) return;
      const toast = document.createElement("div");
      toast.className = "toast-card toast-new_order toast-popup-invite";
      toast.innerHTML = '<div class="toast-content"><strong>Get pop-ups for new orders?</strong>' +
        '<p>See new website orders, customer messages and store changes on this ' + (this.systemSupport() === "native" ? "phone" : "computer") + ', even when the POS is minimised.</p>' +
        '<div class="toast-actions"><button type="button" class="toast-btn toast-view" data-popup-enable>Turn on pop-ups</button>' +
        '<button type="button" class="toast-btn toast-dismiss" data-dismiss>Not now</button></div></div>' +
        '<button type="button" class="toast-close" data-dismiss aria-label="Dismiss">&times;</button>';
      toast.addEventListener("click", e => {
        if (e.target.closest("[data-popup-enable]")) { toast.remove(); this.enableSystemAlerts(); }
        else if (e.target.closest("[data-dismiss]")) toast.remove();
      });
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 20000);
    }

    /* Payloads are memory-only. Server history provides reload persistence. */
    loadLocal() { return this.history; }
    saveLocal(notification) {
      if (!notification || !notification.id) return;
      this.history = [notification].concat(this.history.filter(n => n.id !== notification.id))
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, MAX_LOCAL);
    }
    restoreReadIds() {
      try {
        const ids = JSON.parse(sessionStorage.getItem(READ_KEY) || "[]");
        return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string").slice(-MAX_READ) : []);
      } catch (e) { return new Set(); }
    }
    // One list: everything the server returned, minus messages deleted on this device.
    visibleItems() {
      return this.history.filter(n => !this.deletedIds.has(n.id));
    }
    recountUnread() {
      this.unreadCount = this.visibleItems().filter(n => !this.readIds.has(n.id)).length;
      this.updateBadgeUI();
    }
    persistReadIds() {
      this.readIds = new Set(Array.from(this.readIds).slice(-MAX_READ));
      try { sessionStorage.setItem(READ_KEY, JSON.stringify(Array.from(this.readIds))); } catch (e) {}
    }
    setReadState(id, isRead) {
      if (!id) return;
      if (isRead) this.readIds.add(id); else this.readIds.delete(id);
      this.persistReadIds();
      this.recountUnread();

      // Update the row in place so opening its workspace link is never interrupted.
      const row = Array.from(document.querySelectorAll("#notifDrawerList [data-notification-row]"))
        .find(el => el.dataset.notificationRow === id);
      if (row) {
        row.classList.toggle("nd-unread", !isRead);
        const item = row.querySelector("[data-notification-open]");
        if (item) item.classList.toggle("nd-unread", !isRead);
        const readAction = row.querySelector("[data-nd-menu-action='toggle-read']");
        if (readAction) readAction.textContent = isRead ? "Mark as unread" : "Mark as read";
      }
    }
    toggleReadState(id) {
      this.setReadState(id, !this.readIds.has(id));
    }
    deleteNotification(id) {
      // Single message from its ⋯ menu: same permanent delete, with the same confirmation.
      if (!id || !this.visibleItems().some(n => n.id === id)) return;
      this.startSelection(id);
      this.askDelete();
    }
    hideLocally(ids) {
      ids.forEach(id => { this.deletedIds.add(id); this.readIds.delete(id); });
      saveIdSet(DELETED_KEY, this.deletedIds, DELETED_MAX);
      this.persistReadIds();
      this.history = this.history.filter(n => !ids.includes(n.id));
    }

    /* ---------------- Press-and-hold multi-select ---------------- */
    startSelection(id) {
      if (!this.selecting) { this.selecting = true; this.selected = new Set(); }
      this.closeActionMenus();
      if (id) { this.selected.add(id); this.lastSelectedId = id; }
      this.renderSelection();
    }
    endSelection() {
      this.selecting = false;
      this.selected = new Set();
      this.lastSelectedId = null;
      this.confirmingDelete = false;
      this.renderSelection();
    }
    toggleSelected(id, range) {
      const ids = this.visibleItems().map(n => n.id);
      if (range && this.lastSelectedId && ids.includes(this.lastSelectedId)) {
        const [a, b] = [ids.indexOf(this.lastSelectedId), ids.indexOf(id)].sort((x, y) => x - y);
        ids.slice(a, b + 1).forEach(value => this.selected.add(value));
      } else if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      // Shift-click ranges start from the last message that was ticked.
      if (this.selected.has(id)) this.lastSelectedId = id;
      else if (this.lastSelectedId === id) this.lastSelectedId = Array.from(this.selected).pop() || null;
      this.confirmingDelete = false;
      // Unticking the last box simply returns to the normal inbox.
      if (!this.selected.size) return this.endSelection();
      this.renderSelection();
    }
    selectAll() {
      const ids = this.visibleItems().map(n => n.id);
      const all = ids.length && ids.every(id => this.selected.has(id));
      this.selected = all ? new Set() : new Set(ids);
      this.confirmingDelete = false;
      if (!this.selected.size) return this.endSelection();
      this.renderSelection();
    }
    markSelectedRead() {
      const ids = Array.from(this.selected);
      const allRead = ids.every(id => this.readIds.has(id));
      ids.forEach(id => { if (allRead) this.readIds.delete(id); else this.readIds.add(id); });
      this.persistReadIds();
      this.recountUnread();
      this.endSelection();
    }
    askDelete() {
      if (!this.selected.size) return;
      this.confirmingDelete = true;
      this.renderSelection();
      const yes = document.getElementById("notifDeleteYes");
      if (yes) yes.focus();
    }
    async deleteSelected() {
      const ids = Array.from(this.selected);
      if (!ids.length || this.deleting) return;
      this.deleting = true;
      this.renderSelection();
      let message = "";
      try {
        const path = "/api/notifications/delete";
        const endpoint = typeof DB !== "undefined" && DB.apiUrl ? DB.apiUrl(path) : path;
        const res = await fetch(endpoint, {
          method: "POST", cache: "no-store",
          headers: Object.assign({ "Content-Type": "application/json" }, this.headers()),
          body: JSON.stringify({ ids })
        });
        if (res.ok) {
          this.hideLocally(ids);
          message = ids.length + " notification" + (ids.length === 1 ? "" : "s") + " deleted permanently";
        } else if (res.status === 401 || res.status === 403) {
          // Cashier keys may not erase the store's alert history; still clear this device.
          this.hideLocally(ids);
          message = "Removed from this device. Only a manager or admin can delete for everyone.";
        } else throw new Error("Delete failed " + res.status);
      } catch (e) {
        this.deleting = false;
        this.confirmingDelete = false;
        this.renderSelection();
        this.setStatus("offline", "Could not delete right now — check the connection and try again");
        return;
      }
      this.deleting = false;
      this.recountUnread();
      this.endSelection();
      this._flashUntil = Date.now() + 5000;
      this.setStatus("live", message);
      this.requestRefresh(0);
    }
    renderSelection() {
      const bar = document.getElementById("notifSelectBar");
      const feed = document.getElementById("notifFeedBar");
      const hint = document.getElementById("notifHint");
      const drawer = document.getElementById("notifDrawer");
      const visible = this.visibleItems().map(n => n.id);
      this.selected = new Set(Array.from(this.selected).filter(id => visible.includes(id)));
      if (this.selecting && !this.selected.size && !this.deleting) { this.selecting = false; this.confirmingDelete = false; }
      if (drawer) drawer.classList.toggle("nd-selecting", this.selecting);
      if (bar) bar.hidden = !this.selecting;
      if (feed) feed.hidden = this.selecting;
      if (hint) hint.hidden = this.selecting || visible.length < 2;
      if (this.selecting) {
        const n = this.selected.size;
        const all = visible.length > 0 && visible.every(id => this.selected.has(id));
        const count = document.getElementById("notifSelectCount");
        if (count) count.textContent = n + " selected";
        const selAll = document.getElementById("notifSelectAll");
        if (selAll) selAll.textContent = all ? "Clear all" : "Select all (" + visible.length + ")";
        const read = document.getElementById("notifSelectRead");
        if (read) read.textContent = Array.from(this.selected).every(id => this.readIds.has(id)) ? "Mark unread" : "Mark read";
        const confirm = document.getElementById("notifDeleteConfirm");
        if (confirm) confirm.hidden = !this.confirmingDelete;
        const text = document.getElementById("notifDeleteText");
        if (text) text.textContent = "Delete " + (all && n > 1 ? "all " : "") + n + " notification" + (n === 1 ? "" : "s") +
          " permanently? They disappear from every device. Orders, sales and stock are not affected.";
        const yes = document.getElementById("notifDeleteYes");
        if (yes) { yes.disabled = this.deleting; yes.textContent = this.deleting ? "Deleting…" : "Delete permanently"; }
        ["notifSelectAll", "notifSelectRead", "notifSelectDelete"].forEach(id => {
          const el = document.getElementById(id); if (el) el.disabled = this.deleting || this.confirmingDelete;
        });
      }
      this.renderDrawerList();
    }

    markAllRead() {
      this.history.forEach(n => this.readIds.add(n.id));
      this.persistReadIds();
      this.recountUnread();
      this.renderDrawerList();
    }

    updateBadgeUI() {
      const badge = document.getElementById("notifBadge");
      if (badge) {
        badge.textContent = this.unreadCount > 99 ? "99+" : String(this.unreadCount);
        badge.style.display = this.unreadCount > 0 ? "inline-flex" : "none";
      }
      const markAll = document.getElementById("notifMarkAllRead");
      if (markAll) markAll.disabled = this.unreadCount === 0;
      // "(3) Adonai POS" in the taskbar / tab, and the installed-app badge.
      try {
        const base = String(document.title || "").replace(/^\(\d+\+?\)\s+/, "");
        const title = this.unreadCount ? "(" + (this.unreadCount > 99 ? "99+" : this.unreadCount) + ") " + base : base;
        if (document.title !== title) document.title = title;
        if (navigator.setAppBadge) (this.unreadCount ? navigator.setAppBadge(this.unreadCount) : navigator.clearAppBadge()).catch(() => {});
      } catch (e) {}
      const bell = document.getElementById("notifBellBtn");
      if (bell) {
        bell.setAttribute("aria-label", this.unreadCount ? "Notifications, " + this.unreadCount + " unread" : "Notifications");
        bell.setAttribute("aria-expanded", String(this.drawerOpen()));
        bell.setAttribute("aria-controls", "notifDrawer");
      }
    }

    setStatus(state, message) {
      this.status = state;
      const el = document.getElementById("notifFeedStatus");
      if (el) { el.dataset.state = state; el.textContent = message; }
    }

    injectUI() {
      if (!document.getElementById("toastContainer")) {
        const c = document.createElement("div");
        c.id = "toastContainer";
        c.setAttribute("role", "status");
        c.setAttribute("aria-live", "polite");
        document.body.appendChild(c);
      }
      if (!document.getElementById("notifDrawer")) {
        const d = document.createElement("aside");
        d.id = "notifDrawer";
        d.className = "notif-drawer";
        d.setAttribute("aria-label", "Notifications");
        d.innerHTML = '<div class="nd-head"><span class="nd-title">' + BELL_SVG + ' Notifications</span>' +
          '<div class="nd-actions"><button type="button" class="nd-readall" id="notifMarkAllRead">Mark all as read</button>' +
          '<button type="button" class="nd-gear" id="notifSettingsToggle" aria-expanded="false" aria-controls="notifAlertBar" aria-label="Pop-up and sound settings" title="Pop-up and sound settings">' +
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>' +
          '<button type="button" class="nd-close" id="notifDrawerClose" aria-label="Close notifications">&times;</button></div></div>' +
          '<div class="nd-alertbar" id="notifAlertBar" data-state="off">' +
            '<div class="nd-alert-main"><span class="nd-alert-ico" aria-hidden="true">🔔</span><p class="nd-alert-text" id="notifAlertText"></p>' +
            '<button type="button" class="nd-alert-enable" id="notifAlertEnable">Turn on pop-ups</button></div>' +
            '<div class="nd-alert-panel" id="notifAlertPanel" hidden>' +
              '<div class="nd-alert-options" id="notifAlertOptions">' +
                '<label class="nd-switch"><input type="checkbox" id="notifPrefSystem" /> <span>Show pop-ups on this device</span></label>' +
                '<label class="nd-switch"><input type="checkbox" id="notifPrefForeground" /> <span>Also while I am using the POS window</span></label>' +
              '</div>' +
              '<label class="nd-switch"><input type="checkbox" id="notifPrefSound" /> <span>Notification sound</span></label>' +
              '<div class="nd-volume"><span aria-hidden="true">🔈</span><input type="range" id="notifPrefVolume" min="5" max="100" step="5" aria-label="Notification sound volume" /><span aria-hidden="true">🔊</span></div>' +
              '<div class="nd-alert-tests"><button type="button" class="nd-refresh" id="notifTestSound">▶ Test sound</button>' +
              '<button type="button" class="nd-refresh" id="notifTestPopup">Send test pop-up</button></div>' +
              '<p class="nd-alert-note" id="notifSoundNote" hidden></p>' +
              '<p class="nd-alert-note" id="notifAlertNote" hidden></p>' +
            '</div>' +
          '</div>' +
          '<div class="nd-feedbar" id="notifFeedBar"><span class="nd-feed-status" id="notifFeedStatus" data-state="loading" role="status">Connecting to updates…</span>' +
          '<button type="button" class="nd-refresh" id="notifRefresh" aria-label="Refresh notifications">Refresh</button></div>' +
          '<div class="nd-selectbar" id="notifSelectBar" role="toolbar" aria-label="Selected notifications" hidden>' +
            '<div class="nd-sel-row"><button type="button" class="nd-sel-cancel" id="notifSelectCancel" aria-label="Cancel selection">&times;</button>' +
            '<span class="nd-sel-count" id="notifSelectCount" role="status">1 selected</span>' +
            '<button type="button" class="nd-sel-btn" id="notifSelectAll">Select all</button>' +
            '<button type="button" class="nd-sel-btn" id="notifSelectRead">Mark read</button>' +
            '<button type="button" class="nd-sel-btn nd-sel-danger" id="notifSelectDelete">Delete</button></div>' +
            '<div class="nd-sel-confirm" id="notifDeleteConfirm" hidden><p id="notifDeleteText">Delete permanently?</p>' +
            '<div class="nd-sel-row"><button type="button" class="nd-sel-btn" id="notifDeleteNo">Keep</button>' +
            '<button type="button" class="nd-sel-btn nd-sel-danger-solid" id="notifDeleteYes">Delete permanently</button></div></div>' +
          '</div>' +
          '<div class="nd-list" id="notifDrawerList" aria-label="Recent notifications"></div>' +
          '<p class="nd-hint" id="notifHint">Tip: press and hold a message (or right-click it) to select several.</p>';
        document.body.appendChild(d);
        const scrim = document.createElement("div");
        scrim.id = "notifScrim";
        scrim.className = "notif-scrim";
        document.body.appendChild(scrim);
      }
    }

    drawerOpen() {
      const drawer = document.getElementById("notifDrawer");
      return !!(drawer && drawer.classList.contains("open"));
    }
    toggleDrawer(force) {
      const drawer = document.getElementById("notifDrawer");
      const scrim = document.getElementById("notifScrim");
      if (!drawer) return;
      const open = typeof force === "boolean" ? force : !this.drawerOpen();
      drawer.classList.toggle("open", open);
      if (scrim) scrim.classList.toggle("show", open);
      if (open) { this.syncHistory(); this.renderAlertSettings(); }
      else { this.closeActionMenus(); if (this.selecting) this.endSelection(); }
      this.updateBadgeUI();
    }
    href(notification) {
      const meta = TYPE_META[notification.type];
      return meta && meta.view ? (/admin\.html/.test(location.pathname) ? "" : "admin.html") + "?view=" + meta.view : "";
    }
    closeActionMenus() {
      document.querySelectorAll("#notifDrawerList [data-nd-menu-toggle]").forEach(button => {
        button.setAttribute("aria-expanded", "false");
        const menu = button.parentElement && button.parentElement.querySelector(".nd-menu");
        if (menu) menu.hidden = true;
      });
    }
    toggleActionMenu(button) {
      const menu = button.parentElement && button.parentElement.querySelector(".nd-menu");
      if (!menu) return;
      const shouldOpen = menu.hidden;
      this.closeActionMenus();
      if (!shouldOpen) return;
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      const rect = button.getBoundingClientRect();
      const menuHeight = menu.getBoundingClientRect().height || 96;
      menu.dataset.placement = window.innerHeight - rect.bottom < menuHeight + 12 ? "top" : "bottom";
      const firstAction = menu.querySelector("button");
      if (firstAction) firstAction.focus();
    }
    renderDrawerList() {
      const box = document.getElementById("notifDrawerList");
      if (!box) return;
      const items = this.visibleItems();
      const hint = document.getElementById("notifHint");
      if (hint) hint.hidden = this.selecting || items.length < 2;
      let html;
      if (!items.length) {
        html = !this.history.length
          ? (this.status === "offline"
            ? '<p class="nd-empty">Notifications could not be loaded.<br/>Tap Refresh to retry. Updates will also reconnect automatically.</p>'
            : this.status === "loading"
              ? '<p class="nd-empty">Checking for store activity…</p>'
              : '<p class="nd-empty">No notifications yet.<br/>Completed checkouts, new orders, stock changes and other store activity will appear here.</p>')
          : '<p class="nd-empty">All notifications on this device are deleted.<br/>New activity will appear here.</p>';
      } else html = items.map(n => {
        const meta = TYPE_META[n.type] || { label: "Alert", icon: "🔔" };
        const when = n.timestamp ? new Date(n.timestamp * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        const isRead = this.readIds.has(n.id);
        const unread = isRead ? "" : " nd-unread";
        const href = this.href(n);
        const tag = href ? "a" : "button";
        const openAttrs = href ? ' href="' + esc(href) + '"' : ' type="button"';
        const typeClass = String(n.type || "alert").toLowerCase().replace(/[^a-z0-9_]/g, "");
        const readAction = isRead ? "Mark as unread" : "Mark as read";
        if (this.selecting) {
          const on = this.selected.has(n.id);
          return '<div class="nd-row nd-row-select' + unread + (on ? ' nd-selected' : '') + ' nd-' + esc(typeClass) + '" data-notification-row="' + esc(n.id) + '">' +
            '<button type="button" class="nd-item nd-select-item' + unread + '" role="checkbox" aria-checked="' + on + '" data-nd-select="' + esc(n.id) + '">' +
            '<span class="nd-check" aria-hidden="true"></span>' +
            '<span class="nd-ico" aria-hidden="true">' + meta.icon + '</span><span class="nd-body"><strong>' + esc(n.title) + '</strong>' +
            '<span class="nd-msg">' + esc(n.message) + '</span><span class="nd-time">' + esc(meta.label) + ' · ' + esc(when) + (n.protected ? ' · 🔒 Details protected' : '') + '</span></span></button></div>';
        }
        return '<div class="nd-row' + unread + ' nd-' + esc(typeClass) + '" data-notification-row="' + esc(n.id) + '">' +
          '<' + tag + openAttrs + ' data-notification-open data-notification-id="' + esc(n.id) + '" class="nd-item' + unread + '">' +
          '<span class="nd-ico" aria-hidden="true">' + meta.icon + '</span><span class="nd-body"><strong>' + esc(n.title) + '</strong>' +
          '<span class="nd-msg">' + esc(n.message) + '</span><span class="nd-time">' + esc(meta.label) + ' · ' + esc(when) + (n.protected ? ' · 🔒 Details protected' : '') + '</span></span>' +
          (href ? '<span class="nd-link" aria-hidden="true">›</span>' : '') + '</' + tag + '>' +
          '<div class="nd-more-wrap"><button type="button" class="nd-more" data-nd-menu-toggle aria-label="More actions for ' + esc(n.title) + '" aria-haspopup="menu" aria-controls="notifMenu-' + esc(n.id) + '" aria-expanded="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>' +
          '<div id="notifMenu-' + esc(n.id) + '" class="nd-menu" role="menu" data-placement="bottom" hidden><button type="button" role="menuitem" class="nd-menu-item" data-nd-menu-action="toggle-read" data-notification-id="' + esc(n.id) + '">' + readAction + '</button>' +
          '<button type="button" role="menuitem" class="nd-menu-item" data-nd-menu-action="select" data-notification-id="' + esc(n.id) + '">Select…</button>' +
          '<button type="button" role="menuitem" class="nd-menu-item nd-menu-danger" data-nd-menu-action="delete" data-notification-id="' + esc(n.id) + '">Delete permanently</button></div></div></div>';
      }).join("");
      if (box.innerHTML !== html) box.innerHTML = html;
    }

    renderToast(notification) {
      const container = document.getElementById("toastContainer");
      if (!container) return;
      const toast = document.createElement("div");
      toast.dataset.notificationId = notification.id;
      toast.className = "toast-card toast-" + String(notification.type || "alert").toLowerCase().replace(/[^a-z0-9_]/g, "");
      const href = this.href(notification);
      const actions = href ? '<div class="toast-actions"><a class="toast-btn toast-view" href="' + esc(href) + '">' + (notification.protected ? 'Open protected area' : 'View details') + '</a></div>' : "";
      toast.innerHTML = '<div class="toast-content"><strong>' + esc(notification.title) + '</strong><p>' + esc(notification.message) + '</p>' + actions + '</div>' +
        '<button type="button" class="toast-close" data-dismiss aria-label="Dismiss">&times;</button>';
      toast.addEventListener("click", e => { if (e.target.closest("[data-dismiss]")) toast.remove(); });
      container.appendChild(toast);
      while (container.children.length > 3) container.firstElementChild.remove();
      let hovered = false;
      toast.addEventListener("mouseenter", () => { hovered = true; });
      toast.addEventListener("mouseleave", () => { hovered = false; setTimeout(() => { if (!hovered) toast.remove(); }, 1200); });
      setTimeout(() => { if (!hovered) toast.remove(); }, TOAST_LIFETIME_MS);
    }

    playChime(volume = 0.7) {
      // A short, soft two-note "ding" like a phone message tone (~0.6 s).
      try {
        const ctx = this.audioContext();
        if (!ctx) return false;
        const now = ctx.currentTime + 0.01;
        const peak = 0.04 + 0.26 * Math.max(0, Math.min(1, volume));
        [[880, 0, 0.32], [1318.5, 0.13, 0.5]].forEach(([freq, delay, dur]) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + delay);
          gain.gain.exponentialRampToValueAtTime(peak, now + delay + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + delay);
          osc.stop(now + delay + dur + 0.05);
        });
        return ctx.state === "running";
      } catch (e) { return false; }
    }
    vibrate(ms) {
      try {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
          window.Capacitor.Plugins.Haptics.vibrate({ duration: ms });
        } else if (navigator.vibrate) navigator.vibrate(ms);
      } catch (e) {}
    }

    bindUIEvents() {
      this.bindPressAndHold();
      document.addEventListener("change", e => {
        const id = e.target && e.target.id;
        if (id === "notifPrefSystem") { this.prefs.system = e.target.checked; this.savePrefs(); }
        else if (id === "notifPrefForeground") { this.prefs.foreground = e.target.checked; this.savePrefs(); }
        else if (id === "notifPrefSound") { this.prefs.sound = e.target.checked; this.savePrefs(); if (this.prefs.sound) this.ding(true); }
        else if (id === "notifPrefVolume") { this.ding(true); }
      });
      document.addEventListener("input", e => {
        if (e.target && e.target.id === "notifPrefVolume") {
          this.prefs.volume = Math.max(0.05, Math.min(1, Number(e.target.value) / 100 || 0.7));
          try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch (err) {}
        }
      });
      document.addEventListener("click", e => {
        // A press-and-hold already selected the row; swallow the click that follows it.
        if (this._suppressClick && e.target.closest("#notifDrawerList")) {
          this._suppressClick = false;
          e.preventDefault();
          return;
        }
        this._suppressClick = false;
        const selectRow = e.target.closest("[data-nd-select]");
        if (selectRow) { e.preventDefault(); this.toggleSelected(selectRow.dataset.ndSelect, e.shiftKey); return; }
        const control = e.target.closest("#notifSelectCancel, #notifSelectAll, #notifSelectRead, #notifSelectDelete, #notifDeleteNo, #notifDeleteYes, #notifSettingsToggle, #notifAlertEnable, #notifTestSound, #notifTestPopup");
        if (control) {
          e.preventDefault();
          switch (control.id) {
            case "notifSelectCancel": this.endSelection(); break;
            case "notifSelectAll": this.selectAll(); break;
            case "notifSelectRead": this.markSelectedRead(); break;
            case "notifSelectDelete": this.askDelete(); break;
            case "notifDeleteNo": this.confirmingDelete = false; this.renderSelection(); break;
            case "notifDeleteYes": this.deleteSelected(); break;
            case "notifSettingsToggle": this.settingsOpen = !this.settingsOpen; this.renderAlertSettings(); break;
            case "notifAlertEnable":
              if (this.alertState().state === "blocked" && this.nativeBridge()) {
                try { this.nativeBridge().openStoreAlertSettings(); } catch (err) {}
              } else this.enableSystemAlerts();
              break;
            case "notifTestSound": {
              const played = this.ding(true);
              this.renderAlertSettings();
              if (!played) setTimeout(() => { if (!this.soundUnlocked()) this.renderAlertSettings(); }, 120);
              break;
            }
            case "notifTestPopup": this.sendTestAlert(); break;
          }
          return;
        }
        // Mouse users: Ctrl/Cmd/Shift-click a message to start selecting.
        const opener = e.target.closest("#notifDrawerList [data-notification-open]");
        if (opener && (e.ctrlKey || e.metaKey || e.shiftKey)) {
          e.preventDefault();
          this.startSelection(opener.dataset.notificationId);
          return;
        }
        const menuToggle = e.target.closest("[data-nd-menu-toggle]");
        if (menuToggle) { e.preventDefault(); this.toggleActionMenu(menuToggle); return; }

        const menuAction = e.target.closest("[data-nd-menu-action]");
        if (menuAction) {
          e.preventDefault();
          const id = menuAction.dataset.notificationId;
          const action = menuAction.dataset.ndMenuAction;
          const row = menuAction.closest(".nd-row");
          const toggle = row && row.querySelector("[data-nd-menu-toggle]");
          const fallbackFocus = row && (row.nextElementSibling && row.nextElementSibling.querySelector("[data-nd-menu-toggle]") ||
            row.previousElementSibling && row.previousElementSibling.querySelector("[data-nd-menu-toggle]"));
          this.closeActionMenus();
          if (action === "toggle-read") {
            this.toggleReadState(id);
            if (toggle) toggle.focus();
          } else if (action === "select") {
            this.startSelection(id);
            const first = document.querySelector("#notifDrawerList [data-nd-select]");
            (Array.from(document.querySelectorAll("#notifDrawerList [data-nd-select]")).find(el => el.dataset.ndSelect === id) || first)?.focus();
          } else if (action === "delete") {
            this.deleteNotification(id);
            if (!document.getElementById("notifDeleteYes")) (fallbackFocus || document.getElementById("notifBellBtn"))?.focus();
          }
          return;
        }

        const notification = e.target.closest("[data-notification-open]");
        if (notification) this.setReadState(notification.dataset.notificationId, true);
        else if (!e.target.closest(".nd-more-wrap")) this.closeActionMenus();

        if (e.target.closest("#notifBellBtn")) { e.preventDefault(); this.toggleDrawer(); return; }
        if (e.target.closest("#notifDrawerClose") || e.target.id === "notifScrim") { this.toggleDrawer(false); return; }
        if (e.target.closest("#notifMarkAllRead")) this.markAllRead();
        if (e.target.closest("#notifRefresh")) this.syncHistory();
      });
      document.addEventListener("keydown", e => {
        const menu = e.target.closest && e.target.closest(".nd-menu:not([hidden])");
        if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End")) {
          const actions = Array.from(menu.querySelectorAll("button[role='menuitem']"));
          const current = actions.indexOf(document.activeElement);
          const index = e.key === "Home" ? 0 : e.key === "End" ? actions.length - 1 :
            (current + (e.key === "ArrowDown" ? 1 : actions.length - 1)) % actions.length;
          if (actions[index]) actions[index].focus();
          e.preventDefault();
          return;
        }
        if (this.selecting && this.drawerOpen()) {
          if (e.key === "Escape") { e.preventDefault(); if (this.confirmingDelete) { this.confirmingDelete = false; this.renderSelection(); } else this.endSelection(); return; }
          if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "a") { e.preventDefault(); this.selectAll(); return; }
          if ((e.key === "Delete" || e.key === "Backspace") && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName || "")) { e.preventDefault(); this.askDelete(); return; }
        }
        if (e.key === "Escape") {
          const openButton = document.querySelector("#notifDrawerList [data-nd-menu-toggle][aria-expanded='true']");
          if (openButton) { this.closeActionMenus(); openButton.focus(); }
          else this.toggleDrawer(false);
        }
      });
      document.addEventListener("visibilitychange", () => { if (!document.hidden) this.requestRefresh(0); });
      window.addEventListener("online", () => this.requestRefresh(0));
      window.addEventListener("focus", () => this.requestRefresh(0));
      window.addEventListener("adonai-store-activity", () => this.requestRefresh());
      window.addEventListener("pos-access-change", () => this.accessChanged());
      window.addEventListener("pagehide", () => this.stop());
      window.addEventListener("pageshow", event => { if (event.persisted) { this.stopped = false; this.accessChanged(); } });
      // Browsers only allow page sound after one click/tap/key on the page.
      const unlock = () => {
        const ctx = this.audioContext();
        if (ctx && ctx.state === "running") {
          document.removeEventListener("pointerdown", unlock, true);
          document.removeEventListener("keydown", unlock, true);
        }
        setTimeout(() => this.renderAlertSettings(), 50);
      };
      document.addEventListener("pointerdown", unlock, true);
      document.addEventListener("keydown", unlock, true);
    }
    bindPressAndHold() {
      let press = null;
      const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
      document.addEventListener("pointerdown", e => {
        if (e.button > 0) return;
        const row = e.target.closest && e.target.closest("#notifDrawerList [data-notification-row]");
        if (!row || e.target.closest(".nd-more-wrap")) return;
        cancel();
        const id = row.dataset.notificationRow;
        press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
          press = null;
          this._pressAt = Date.now();
          this._suppressClick = true;
          this.vibrate(30);
          if (!this.selecting) this.startSelection(id);
          else if (!this.selected.has(id)) this.toggleSelected(id, false);
        }, LONG_PRESS_MS) };
      }, true);
      document.addEventListener("pointermove", e => {
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel();
      }, true);
      ["pointercancel", "scroll"].forEach(type => document.addEventListener(type, cancel, true));
      document.addEventListener("pointerup", () => {
        cancel();
        // Touch screens may not send a click after a hold; never swallow a later tap.
        if (this._suppressClick) setTimeout(() => { this._suppressClick = false; }, 450);
      }, true);
      // Right-click on desktop, long-press menu on phones.
      document.addEventListener("contextmenu", e => {
        const row = e.target.closest && e.target.closest("#notifDrawerList [data-notification-row]");
        if (!row || e.target.closest(".nd-more-wrap")) return;
        e.preventDefault();
        cancel();
        if (this._pressAt && Date.now() - this._pressAt < 900) return; // the hold already selected it
        const id = row.dataset.notificationRow;
        if (!this.selecting) this.startSelection(id);
        else this.toggleSelected(id, false);
      });
    }
    stop() {
      this.stopped = true;
      clearTimeout(this.pollTimer);
      this.clearTicker();
      if (this.controller) this.controller.abort();
    }
  }

  // Compatibility with modules that post an already-formed notification.
  window.posLocalDB = window.posLocalDB || {};
  window.posLocalDB.saveNotification = n => {
    if (window.notificationEngine) window.notificationEngine.handleNotification(n);
  };
  function boot() { if (!window.notificationEngine) window.notificationEngine = new NotificationManager(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
