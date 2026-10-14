/* Adonai Store — Operator notifications v2.0
 * Durable history is fetched immediately, every five seconds, and after local
 * store actions. Delivery never depends on SSE opening successfully or on one
 * particular server worker. Full notification text stays in memory only;
 * sessionStorage holds read IDs, not customer/financial data or credentials.
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
        // Simply viewing the inbox must not silently mark every new alert read;
        // each row has its own read state and the header retains a bulk action.
        this.recountUnread();
        this.renderDrawerList();
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
      this.recountUnread();
      this.renderDrawerList();
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
      if (!id || !this.visibleItems().some(n => n.id === id)) return;
      this.deletedIds.add(id);
      saveIdSet(DELETED_KEY, this.deletedIds, DELETED_MAX);
      this.readIds.delete(id);
      this.persistReadIds();
      this.closeActionMenus();
      this.recountUnread();
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
          '<div class="nd-list" id="notifDrawerList" aria-label="Recent notifications"></div>';
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
      if (open) this.syncHistory();
      else this.closeActionMenus();
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
        return '<div class="nd-row' + unread + ' nd-' + esc(typeClass) + '" data-notification-row="' + esc(n.id) + '">' +
          '<' + tag + openAttrs + ' data-notification-open data-notification-id="' + esc(n.id) + '" class="nd-item' + unread + '">' +
          '<span class="nd-ico" aria-hidden="true">' + meta.icon + '</span><span class="nd-body"><strong>' + esc(n.title) + '</strong>' +
          '<span class="nd-msg">' + esc(n.message) + '</span><span class="nd-time">' + esc(meta.label) + ' · ' + esc(when) + (n.protected ? ' · 🔒 Details protected' : '') + '</span></span>' +
          (href ? '<span class="nd-link" aria-hidden="true">›</span>' : '') + '</' + tag + '>' +
          '<div class="nd-more-wrap"><button type="button" class="nd-more" data-nd-menu-toggle aria-label="More actions for ' + esc(n.title) + '" aria-haspopup="menu" aria-controls="notifMenu-' + esc(n.id) + '" aria-expanded="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>' +
          '<div id="notifMenu-' + esc(n.id) + '" class="nd-menu" role="menu" data-placement="bottom" hidden><button type="button" role="menuitem" class="nd-menu-item" data-nd-menu-action="toggle-read" data-notification-id="' + esc(n.id) + '">' + readAction + '</button>' +
          '<button type="button" role="menuitem" class="nd-menu-item nd-menu-danger" data-nd-menu-action="delete" data-notification-id="' + esc(n.id) + '">Remove from this device</button></div></div></div>';
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
          } else if (action === "delete") {
            this.deleteNotification(id);
            (fallbackFocus || document.getElementById("notifBellBtn"))?.focus();
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
