/* Adonai Store — Operator notifications v2.0
 * Durable history is fetched immediately, every five seconds, and after local
 * store actions. Delivery never depends on SSE opening successfully or on one
 * particular server worker. Full notification text stays in memory only;
 * sessionStorage holds read IDs, not customer/financial data or credentials.
 */
(function () {
  "use strict";

  const READ_KEY = "adonai.notifications.read-ids.v2";
  // Collections are per browser and hold IDs only (no alert text), so they can't leak payloads.
  const HOLD_KEY = "adonai.notifications.hold.v1";
  const DELETED_KEY = "adonai.notifications.deleted.v1";
  const HOLD_MAX = 200;
  const DELETED_MAX = 300;
  const MAX_LOCAL = 100;
  const MAX_READ = 300;
  const POLL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 10000;
  const TOAST_LIFETIME_MS = 5000;
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const BELL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const TYPE_META = {
    NEW_ORDER: { label: "Checkout / order", icon: "🛍️", view: "sales" },
    NEW_MESSAGE: { label: "Customer note", icon: "💬", view: "sales" },
    ORDER_UPDATED: { label: "Order update", icon: "📦", view: "dispatch" },
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
      this.holdIds = loadIdSet(HOLD_KEY, HOLD_MAX);
      this.deletedIds = loadIdSet(DELETED_KEY, DELETED_MAX);
      // Trim stored collections on load so local storage stays bounded even after old versions.
      saveIdSet(HOLD_KEY, this.holdIds, HOLD_MAX);
      saveIdSet(DELETED_KEY, this.deletedIds, DELETED_MAX);
      this.tab = "received";
      this.selected = new Set();
      this.unreadCount = 0;
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
      if (!this.stopped) this.pollTimer = setTimeout(() => this.syncHistory(), delay);
    }

    requestRefresh(delay = 150) {
      if (this.inFlight) { this.pendingRefresh = true; return; }
      this.scheduleRefresh(delay);
    }

    syncHistory() {
      clearTimeout(this.pollTimer);
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
          const priority = fresh.filter(n => n.type === "NEW_ORDER").concat(fresh.filter(n => n.type !== "NEW_ORDER"));
          priority.slice(0, 3).reverse().forEach(n => this.announce(n));
        }
        this.hasSynced = true;
        this.failures = 0;
        this.setStatus("live", "Updates connected · refreshes every 5 seconds");
        if (this.drawerOpen()) this.markAllRead();
        else { this.recountUnread(); this.renderDrawerList(); }
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
      if (fresh) this.announce(notification);
      if (this.drawerOpen()) this.markAllRead();
      else { this.recountUnread(); this.renderDrawerList(); }
    }

    announce(notification) {
      if (notification.type === "NEW_ORDER") this.playChime();
      this.vibrate(notification.type === "NEW_ORDER" ? 120 : 45);
      if (!this.drawerOpen()) this.renderToast(notification);
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
    // Items in a collection, newest first. "received" excludes held and deleted items.
    visibleItems(tab) {
      return this.history.filter(n => !this.deletedIds.has(n.id) &&
        (tab === "hold" ? this.holdIds.has(n.id) : !this.holdIds.has(n.id)));
    }
    recountUnread() {
      this.unreadCount = this.visibleItems("received").filter(n => !this.readIds.has(n.id)).length;
      this.updateBadgeUI();
    }
    setTab(tab) {
      this.tab = tab === "hold" ? "hold" : "received";
      this.selected.clear();
      this.renderDrawerList();
    }
    toggleSelected(id, on) {
      if (on) this.selected.add(id); else this.selected.delete(id);
      this.renderDrawerList();
    }
    selectAllVisible() {
      const items = this.visibleItems(this.tab);
      const allSelected = items.length > 0 && items.every(n => this.selected.has(n.id));
      this.selected = allSelected ? new Set() : new Set(items.map(n => n.id));
      this.renderDrawerList();
    }
    holdSelected() {
      this.selected.forEach(id => { if (!this.deletedIds.has(id)) this.holdIds.add(id); });
      this.selected.clear();
      saveIdSet(HOLD_KEY, this.holdIds, HOLD_MAX);
      this.recountUnread(); this.renderDrawerList();
    }
    restoreSelected() {
      this.selected.forEach(id => this.holdIds.delete(id));
      this.selected.clear();
      saveIdSet(HOLD_KEY, this.holdIds, HOLD_MAX);
      this.recountUnread(); this.renderDrawerList();
    }
    deleteIds(ids, message) {
      if (!ids.length) return;
      if (typeof window.confirm === "function" && !window.confirm(message)) return;
      ids.forEach(id => { this.deletedIds.add(id); this.holdIds.delete(id); this.selected.delete(id); });
      saveIdSet(DELETED_KEY, this.deletedIds, DELETED_MAX);
      saveIdSet(HOLD_KEY, this.holdIds, HOLD_MAX);
      this.recountUnread(); this.renderDrawerList();
    }
    deleteSelected() {
      const ids = Array.from(this.selected);
      this.deleteIds(ids, `Delete ${ids.length} selected notification${ids.length === 1 ? "" : "s"} from this device? The store keeps its own records.`);
    }
    deleteReadReceived() {
      const ids = this.visibleItems("received").filter(n => this.readIds.has(n.id)).map(n => n.id);
      this.deleteIds(ids, `Delete ${ids.length} read notification${ids.length === 1 ? "" : "s"} from this device?`);
    }
    markAllRead() {
      this.history.forEach(n => this.readIds.add(n.id));
      this.readIds = new Set(Array.from(this.readIds).slice(-MAX_READ));
      try { sessionStorage.setItem(READ_KEY, JSON.stringify(Array.from(this.readIds))); } catch (e) {}
      this.recountUnread();
      this.renderDrawerList();
    }

    updateBadgeUI() {
      const badge = document.getElementById("notifBadge");
      if (badge) {
        badge.textContent = this.unreadCount > 99 ? "99+" : String(this.unreadCount);
        badge.style.display = this.unreadCount > 0 ? "inline-flex" : "none";
      }
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
          '<button type="button" class="nd-close" id="notifDrawerClose" aria-label="Close notifications">&times;</button></div></div>' +
          '<div class="nd-feedbar"><span class="nd-feed-status" id="notifFeedStatus" data-state="loading" role="status">Connecting to updates…</span>' +
          '<button type="button" class="nd-refresh" id="notifRefresh" aria-label="Refresh notifications">Refresh</button></div>' +
          '<div class="nd-tabs" id="notifTabs" role="tablist"></div><div class="nd-toolbar" id="notifToolbar"></div>' +
          '<div class="nd-list" id="notifDrawerList"></div>';
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
      if (open) { this.markAllRead(); this.syncHistory(); }
      this.updateBadgeUI();
    }
    href(notification) {
      const meta = TYPE_META[notification.type];
      return meta && meta.view ? (/admin\.html/.test(location.pathname) ? "" : "admin.html") + "?view=" + meta.view : "";
    }
    renderDrawerList() {
      const box = document.getElementById("notifDrawerList");
      const tabsEl = document.getElementById("notifTabs");
      const toolbar = document.getElementById("notifToolbar");
      if (!box) return;
      const received = this.visibleItems("received"), held = this.visibleItems("hold");
      const items = this.tab === "hold" ? held : received;
      const unreadReceived = received.filter(n => !this.readIds.has(n.id)).length;
      // Selection only ever refers to rows currently on screen.
      this.selected = new Set(Array.from(this.selected).filter(id => items.some(n => n.id === id)));
      const selectedCount = this.selected.size;
      const allSelected = items.length > 0 && selectedCount === items.length;
      if (tabsEl) {
        tabsEl.innerHTML = '<button type="button" role="tab" class="nd-tab' + (this.tab === "received" ? " active" : "") + '" data-nd-tab="received" aria-selected="' + (this.tab === "received") + '">Received (' + received.length + (unreadReceived ? ', ' + unreadReceived + ' new' : '') + ')</button>' +
          '<button type="button" role="tab" class="nd-tab' + (this.tab === "hold" ? " active" : "") + '" data-nd-tab="hold" aria-selected="' + (this.tab === "hold") + '">On hold (' + held.length + ')</button>';
      }
      if (toolbar) {
        const hasItems = items.length > 0;
        const readCount = this.tab === "received" ? received.filter(n => this.readIds.has(n.id)).length : 0;
        toolbar.innerHTML = hasItems ? '<label class="nd-selall"><input type="checkbox" data-nd-action="select-all"' + (allSelected ? " checked" : "") + '> All</label>' +
          (this.tab === "received" ? '<button type="button" class="nd-tool" data-nd-action="hold" ' + (selectedCount ? "" : "disabled") + '>Put on hold' + (selectedCount ? ' (' + selectedCount + ')' : '') + '</button>'
            : '<button type="button" class="nd-tool" data-nd-action="restore" ' + (selectedCount ? "" : "disabled") + '>Move to received' + (selectedCount ? ' (' + selectedCount + ')' : '') + '</button>') +
          '<button type="button" class="nd-tool nd-danger" data-nd-action="delete" ' + (selectedCount ? "" : "disabled") + '>Delete' + (selectedCount ? ' (' + selectedCount + ')' : '') + '</button>' +
          (readCount ? '<button type="button" class="nd-tool nd-danger" data-nd-action="clear-read">Delete read (' + readCount + ')</button>' : "") : "";
      }
      let html;
      const orphanHeld = Array.from(this.holdIds).filter(id => !this.deletedIds.has(id) && !this.history.some(n => n.id === id)).length;
      const note = this.tab === "hold" && orphanHeld ? '<p class="nd-note">' + orphanHeld + ' held message' + (orphanHeld === 1 ? " is" : "s are") + ' older than the latest ' + MAX_LOCAL + ' alerts and can no longer be shown.</p>' : "";
      if (!items.length) {
        html = this.tab === "hold"
          ? '<p class="nd-empty">Nothing on hold.<br/>Select messages in Received and tap "Put on hold" to keep them here.</p>' + note
          : !this.history.length
            ? (this.status === "offline"
              ? '<p class="nd-empty">Notifications could not be loaded.<br/>Tap Refresh to retry. Updates will also reconnect automatically.</p>'
              : this.status === "loading"
                ? '<p class="nd-empty">Checking for store activity…</p>'
                : '<p class="nd-empty">No notifications yet.<br/>Completed checkouts, new orders, stock changes and other store activity will appear here.</p>')
            : '<p class="nd-empty">Everything here is on hold or deleted.</p>';
      } else html = items.map(n => {
        const meta = TYPE_META[n.type] || { label: "Alert", icon: "🔔" };
        const when = n.timestamp ? new Date(n.timestamp * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        const unread = !this.readIds.has(n.id) ? " nd-unread" : "";
        const href = this.href(n);
        const tag = href ? "a" : "div";
        const checked = this.selected.has(n.id) ? " checked" : "";
        return '<div class="nd-row"><label class="nd-check"><input type="checkbox" data-nd-check="' + esc(n.id) + '"' + checked + ' aria-label="Select: ' + esc(n.title) + '"></label>' +
          '<' + tag + (href ? ' href="' + esc(href) + '"' : '') + ' data-notification-id="' + esc(n.id) + '" class="nd-item' + unread + ' nd-' + esc(String(n.type || "alert").toLowerCase().replace(/[^a-z0-9_]/g, "")) + '">' +
          '<span class="nd-ico" aria-hidden="true">' + meta.icon + '</span><span class="nd-body"><strong>' + esc(n.title) + '</strong>' +
          '<span class="nd-msg">' + esc(n.message) + '</span><span class="nd-time">' + esc(meta.label) + ' · ' + esc(when) + (n.protected ? ' · 🔒 Details protected' : '') + '</span></span>' +
          (href ? '<span class="nd-link" aria-hidden="true">›</span>' : '') + '</' + tag + '></div>';
      }).join("") + note;
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

    playChime() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this._audioCtx) this._audioCtx = new Ctx();
        const ctx = this._audioCtx;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        [[1318.5, 0, 0.18], [1760, 0.12, 0.26]].forEach(([freq, delay, dur]) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + delay);
          gain.gain.exponentialRampToValueAtTime(0.09, now + delay + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + delay);
          osc.stop(now + delay + dur + 0.05);
        });
      } catch (e) {}
    }
    vibrate(ms) {
      try {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
          window.Capacitor.Plugins.Haptics.vibrate({ duration: ms });
        } else if (navigator.vibrate) navigator.vibrate(ms);
      } catch (e) {}
    }

    bindUIEvents() {
      document.addEventListener("click", e => {
        if (e.target.closest("#notifBellBtn")) { e.preventDefault(); this.toggleDrawer(); return; }
        if (e.target.closest("#notifDrawerClose") || e.target.id === "notifScrim") { this.toggleDrawer(false); return; }
        if (e.target.closest("#notifMarkAllRead")) this.markAllRead();
        if (e.target.closest("#notifRefresh")) this.syncHistory();
        const tab = e.target.closest("[data-nd-tab]");
        if (tab) { this.setTab(tab.dataset.ndTab); return; }
        const action = e.target.closest("[data-nd-action]");
        if (action && action.tagName === "BUTTON") {
          const name = action.dataset.ndAction;
          if (name === "hold") this.holdSelected();
          else if (name === "restore") this.restoreSelected();
          else if (name === "delete") this.deleteSelected();
          else if (name === "clear-read") this.deleteReadReceived();
          return;
        }
        if (e.target.matches && e.target.matches("[data-nd-action='select-all']")) this.selectAllVisible();
      });
      document.addEventListener("change", e => {
        const check = e.target.closest && e.target.closest("[data-nd-check]");
        if (check) this.toggleSelected(check.dataset.ndCheck, check.checked);
      });
      document.addEventListener("keydown", e => { if (e.key === "Escape") this.toggleDrawer(false); });
      document.addEventListener("visibilitychange", () => { if (!document.hidden) this.requestRefresh(0); });
      window.addEventListener("online", () => this.requestRefresh(0));
      window.addEventListener("focus", () => this.requestRefresh(0));
      window.addEventListener("adonai-store-activity", () => this.requestRefresh());
      window.addEventListener("pos-access-change", () => this.accessChanged());
      window.addEventListener("pagehide", () => this.stop());
      window.addEventListener("pageshow", event => { if (event.persisted) { this.stopped = false; this.accessChanged(); } });
      document.addEventListener("pointerdown", () => {
        if (this._audioCtx && this._audioCtx.state === "suspended") this._audioCtx.resume().catch(() => {});
      }, { once: true });
    }
    stop() {
      this.stopped = true;
      clearTimeout(this.pollTimer);
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
