/* ============================================================
   Adonai Store — Real-Time Notification Engine (client)
   NotificationManager: SSE stream listener, header bell badge,
   slide-over drawer, floating toast alerts, audio chime,
   Capacitor haptics, and offline localStorage history cache.

   Backend contract:
     POST /api/notifications/ticket   (Bearer JWT -> one-shot ticket)
     GET  /api/notifications/stream?ticket=...   (SSE)
     GET  /api/notifications          (drawer history, Bearer JWT)
   ============================================================ */
(function () {
  "use strict";

  const STORE_KEY = "adonai.notifications.log";
  const READ_KEY = "adonai.notifications.readmark";
  const MAX_LOCAL = 100;
  const TOAST_LIFETIME_MS = 5000;
  const RECONNECT_DELAY_MS = 5000;
  const TOKEN_POLL_MS = 15000;

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const BELL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

  const TYPE_META = {
    NEW_ORDER:   { label: "Order",   icon: "🛍️" },
    NEW_MESSAGE: { label: "Message", icon: "💬" },
    LOW_STOCK:   { label: "Stock",   icon: "⚠️" },
    NEW_EXPENSE: { label: "Expense", icon: "🧾" }
  };

  class NotificationManager {
    constructor() {
      this.unreadCount = 0;
      this.eventSource = null;
      this.seenIds = new Set();
      this.reconnectTimer = null;
      this.init();
    }

    /* ---------------- lifecycle ---------------- */
    init() {
      this.injectUI();
      this.bindUIEvents();
      this.restoreLocalHistory();
      this.connectStream();
    }

    token() {
      try {
        return (typeof Auth !== "undefined" && typeof Auth.token === "function" && Auth.token()) || "";
      } catch (e) { return ""; }
    }

    /* ---------------- real-time stream ---------------- */
    async connectStream() {
      clearTimeout(this.reconnectTimer);
      const tok = this.token();
      if (!tok) {
        // Open-access terminal: live alerts attach once a cashier signs in.
        this.reconnectTimer = setTimeout(() => this.connectStream(), TOKEN_POLL_MS);
        return;
      }
      try {
        const res = await fetch("/api/notifications/ticket", {
          method: "POST",
          headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
          body: "{}"
        });
        if (!res.ok) throw new Error("ticket " + res.status);
        const data = await res.json();

        if (this.eventSource) { try { this.eventSource.close(); } catch (e) {} }
        this.eventSource = new EventSource("/api/notifications/stream?ticket=" + encodeURIComponent(data.ticket));

        this.eventSource.onopen = () => this.syncHistory();
        this.eventSource.onmessage = event => {
          try { this.handleNotification(JSON.parse(event.data)); } catch (e) {}
        };
        this.eventSource.onerror = () => {
          console.warn("Notification connection lost. Reconnecting in 5s...");
          try { this.eventSource.close(); } catch (e) {}
          this.eventSource = null;
          this.reconnectTimer = setTimeout(() => this.connectStream(), RECONNECT_DELAY_MS);
        };
      } catch (e) {
        this.reconnectTimer = setTimeout(() => this.connectStream(), RECONNECT_DELAY_MS);
      }
    }

    async syncHistory() {
      const tok = this.token();
      if (!tok) return;
      try {
        const res = await fetch("/api/notifications?limit=100", {
          headers: { "Authorization": "Bearer " + tok }
        });
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data.notifications) ? data.notifications : [];
        // Merge newest-first server history into the local cache.
        for (let i = list.length - 1; i >= 0; i--) this.saveLocal(list[i]);
        this.renderDrawerList();
        this.recountUnread();
      } catch (e) { /* offline — the local cache already feeds the drawer */ }
    }

    /* ---------------- event handling ---------------- */
    handleNotification(notification) {
      if (!notification || !notification.id || this.seenIds.has(notification.id)) return;
      this.seenIds.add(notification.id);

      // 1. Unread badge counter
      this.unreadCount++;
      this.updateBadgeUI();

      // 2. Audio chime (high-priority) & mobile haptics
      if (notification.type === "NEW_ORDER") this.playChime();
      this.vibrate(notification.type === "NEW_ORDER" ? 120 : 45);

      // 3. Floating toast popup
      this.renderToast(notification);

      // 4. Offline local cache + drawer
      this.saveLocal(notification);
      this.renderDrawerList();
    }

    /* ---------------- offline storage ---------------- */
    loadLocal() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
      catch (e) { return []; }
    }

    saveLocal(notification) {
      if (!notification || !notification.id) return;
      try {
        const list = this.loadLocal();
        if (!list.some(n => n.id === notification.id)) {
          list.unshift(notification);
          localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_LOCAL)));
        }
      } catch (e) { /* storage full/unavailable — stream still works */ }
    }

    readMark() {
      try { return Number(localStorage.getItem(READ_KEY) || 0); }
      catch (e) { return 0; }
    }

    restoreLocalHistory() {
      const list = this.loadLocal();
      list.forEach(n => this.seenIds.add(n.id));
      this.renderDrawerList();
      this.recountUnread();
    }

    recountUnread() {
      const mark = this.readMark();
      this.unreadCount = this.loadLocal().filter(n => (n.timestamp || 0) > mark).length;
      this.updateBadgeUI();
    }

    markAllRead() {
      try { localStorage.setItem(READ_KEY, String(Math.floor(Date.now() / 1000))); } catch (e) {}
      this.unreadCount = 0;
      this.updateBadgeUI();
      this.renderDrawerList();
    }

    /* ---------------- UI: badge ---------------- */
    updateBadgeUI() {
      const badge = document.getElementById("notifBadge");
      if (!badge) return;
      badge.textContent = this.unreadCount > 99 ? "99+" : String(this.unreadCount);
      badge.style.display = this.unreadCount > 0 ? "inline-flex" : "none";
    }

    /* ---------------- UI: injected containers ---------------- */
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
        d.innerHTML =
          '<div class="nd-head">' +
            '<span class="nd-title">' + BELL_SVG + ' Notifications</span>' +
            '<div class="nd-actions">' +
              '<button type="button" class="nd-readall" id="notifMarkAllRead">Mark all as read</button>' +
              '<button type="button" class="nd-close" id="notifDrawerClose" aria-label="Close notifications">&times;</button>' +
            '</div>' +
          '</div>' +
          '<div class="nd-list" id="notifDrawerList"></div>';
        document.body.appendChild(d);
        const scrim = document.createElement("div");
        scrim.id = "notifScrim";
        scrim.className = "notif-scrim";
        document.body.appendChild(scrim);
      }
    }

    toggleDrawer(force) {
      const drawer = document.getElementById("notifDrawer");
      const scrim = document.getElementById("notifScrim");
      if (!drawer) return;
      const open = typeof force === "boolean" ? force : !drawer.classList.contains("open");
      drawer.classList.toggle("open", open);
      if (scrim) scrim.classList.toggle("show", open);
      if (open) {
        this.renderDrawerList();
        this.markAllRead();
      }
    }

    renderDrawerList() {
      const box = document.getElementById("notifDrawerList");
      if (!box) return;
      const list = this.loadLocal();
      if (!list.length) {
        box.innerHTML = '<p class="nd-empty">No notifications yet.<br/>New orders, stock warnings and expense logs will appear here in real time.</p>';
        return;
      }
      const mark = this.readMark();
      box.innerHTML = list.map(n => {
        const meta = TYPE_META[n.type] || { label: "Alert", icon: "🔔" };
        const when = n.timestamp ? new Date(n.timestamp * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        const unread = (n.timestamp || 0) > mark ? " nd-unread" : "";
        return '<div class="nd-item' + unread + ' nd-' + esc((n.type || "").toLowerCase()) + '">' +
          '<span class="nd-ico">' + meta.icon + '</span>' +
          '<span class="nd-body"><strong>' + esc(n.title) + '</strong>' +
          '<span class="nd-msg">' + esc(n.message) + '</span>' +
          '<span class="nd-time">' + esc(meta.label) + ' · ' + esc(when) + '</span></span>' +
          '</div>';
      }).join("");
    }

    /* ---------------- UI: floating toasts ---------------- */
    renderToast(notification) {
      const container = document.getElementById("toastContainer");
      if (!container) return;

      const type = (notification.type || "").toLowerCase();
      const toast = document.createElement("div");
      toast.className = "toast-card toast-" + type;

      let actions = "";
      if (notification.type === "NEW_ORDER" && notification.payload && notification.payload.order_id) {
        const isConsole = /admin\.html/.test(location.pathname);
        const href = (isConsole ? "" : "admin.html") + "?view=sales";
        actions = '<div class="toast-actions">' +
          '<a class="toast-btn toast-view" href="' + esc(href) + '">View Order</a>' +
          '<button type="button" class="toast-btn toast-dismiss" data-dismiss>Dismiss</button>' +
          '</div>';
      }

      toast.innerHTML =
        '<div class="toast-content">' +
          '<strong>' + esc(notification.title) + '</strong>' +
          '<p>' + esc(notification.message) + '</p>' + actions +
        '</div>' +
        '<button type="button" class="toast-close" data-dismiss aria-label="Dismiss">&times;</button>';

      toast.addEventListener("click", e => {
        if (e.target.closest("[data-dismiss]")) toast.remove();
      });
      container.appendChild(toast);

      // Auto-dismiss after 5s; a hovering operator keeps it on screen.
      let hovered = false;
      toast.addEventListener("mouseenter", () => { hovered = true; });
      toast.addEventListener("mouseleave", () => {
        hovered = false;
        setTimeout(() => { if (!hovered && toast.parentElement) toast.remove(); }, 1200);
      });
      setTimeout(() => {
        if (!hovered && toast.parentElement) toast.remove();
      }, TOAST_LIFETIME_MS);
    }

    /* ---------------- audio & haptics ---------------- */
    playChime() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this._audioCtx) this._audioCtx = new Ctx();
        const ctx = this._audioCtx;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        // Two-note professional register chime: E6 -> A6, soft envelope.
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
      } catch (e) { /* audio autoplay policy — chime resumes after first tap */ }
    }

    vibrate(ms) {
      try {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
          window.Capacitor.Plugins.Haptics.vibrate({ duration: ms });
          return;
        }
        if (navigator.vibrate) navigator.vibrate(ms);
      } catch (e) {}
    }

    /* ---------------- events ---------------- */
    bindUIEvents() {
      document.addEventListener("click", e => {
        const bell = e.target.closest("#notifBellBtn");
        if (bell) { e.preventDefault(); this.toggleDrawer(); return; }
        if (e.target.closest("#notifDrawerClose") || e.target.id === "notifScrim") {
          this.toggleDrawer(false); return;
        }
        if (e.target.closest("#notifMarkAllRead")) this.markAllRead();
      });
      document.addEventListener("keydown", e => {
        if (e.key === "Escape") this.toggleDrawer(false);
      });
      // First user gesture unlocks the audio context (autoplay policy).
      document.addEventListener("pointerdown", () => {
        if (this._audioCtx && this._audioCtx.state === "suspended") this._audioCtx.resume().catch(() => {});
      }, { once: true });
    }
  }

  // Offline storage contract used by other modules.
  window.posLocalDB = window.posLocalDB || {};
  window.posLocalDB.saveNotification = n => {
    if (window.notificationEngine) window.notificationEngine.saveLocal(n);
  };

  function boot() { window.notificationEngine = new NotificationManager(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
