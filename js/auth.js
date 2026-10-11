/* ============================================================
   ADONAI STORE — AUTH & POS SESSION LAYER
   Coordinated authentication for Cashier Terminal & Admin Console.
   Persists active staff session & JWT token across tabs via localStorage.
   ============================================================ */
(function (global) {
  "use strict";

  const LS_KEY = "adonai-session-v2";
  const SS_KEY = "adonai-session-v1";
  const TOKEN_KEY = "adonai-terminal-token";
  const SUITE_KEY = "adonai-suite-unlocked";
  const MODE_KEY = "adonai-terminal-access-mode";
  const BC_NAME = "adonai-auth-events";

  const storage = (typeof localStorage !== "undefined") ? localStorage : {
    _m: {},
    getItem(k) { return this._m[k] || null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; }
  };
  const sessionStore = (typeof sessionStorage !== "undefined") ? sessionStorage : storage;

  // The server, not a stale browser access_locked flag, owns the access mode.
  // Remember only the mode for offline navigation; never embed an admin key.
  let accessMode = "open";
  try { if (storage.getItem(MODE_KEY) === "credential") accessMode = "credential"; } catch (e) {}
  let readyPromise = null;

  let authBc = null;
  if (typeof BroadcastChannel !== "undefined") {
    try { authBc = new BroadcastChannel(BC_NAME); } catch (e) {}
  }

  function page() {
    try { return location.pathname.split("/").pop() || "index.html"; } catch (e) { return "index.html"; }
  }

  function requestedPage() {
    try {
      // Preserve both query routes and legacy fragments through authentication.
      // Without this, every admin destination returned to the default analytics
      // view after login, making all POS drawer links appear identical.
      return page() + (location.search || "") + (location.hash || "");
    } catch (e) {
      return page();
    }
  }

  const Auth = {
    /** Connect a PIN-free terminal without showing any credential prompt.
     * PIN-free backend requests do not depend on a JWT or this handshake.
     * Explicitly protected deployments keep the normal staff login instead.
     */
    ready() {
      if (readyPromise) return readyPromise;
      let connected = false;
      readyPromise = (async () => {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
        try {
          const endpoint = typeof DB !== "undefined" && DB.apiUrl
            ? DB.apiUrl("/api/auth/terminal-session") : "/api/auth/terminal-session";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            cache: "no-store",
            signal: controller ? controller.signal : undefined
          });
          const data = await response.json();
          if (!response.ok || !data || !data.ok) throw new Error("Terminal connection unavailable");
          if (data.requires_staff_auth === true) {
            accessMode = "credential";
            const current = Auth.me();
            if (current && (current.access_mode === "open" || current.id === "OPEN-TERMINAL")) {
              Auth.signOut();
            }
            // Old local unlock flags cannot override the server's protection.
            try { sessionStore.removeItem("adonai-master-2026"); } catch (e) {}
            try { sessionStore.removeItem(SUITE_KEY); } catch (e) {}
          } else if (data.access_mode === "open" && data.staff && data.staff.role === "admin") {
            accessMode = "open";
            Auth.signIn(Object.assign({}, data.staff, { token: data.token || "", access_mode: "open" }));
          } else {
            throw new Error("Unrecognized terminal access mode");
          }
          try { storage.setItem(MODE_KEY, accessMode); } catch (e) {}
          connected = true;
        } catch (e) {
          // A failed handshake must not prevent PIN-free saves. Protected
          // servers continue to enforce credentials on their own endpoints.
        } finally {
          if (timer) clearTimeout(timer);
        }
        return Auth.me();
      })().finally(() => { if (!connected) readyPromise = null; });
      return readyPromise;
    },

    openAccess() { return accessMode === "open"; },

    /** current signed-in staff member, or null */
    me() {
      try {
        const raw = storage.getItem(LS_KEY) || sessionStore.getItem(SS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.id || parsed.name)) return parsed;
        return null;
      } catch (e) {
        return null;
      }
    },

    /** active JWT token / terminal auth key */
    token() {
      const me = Auth.me();
      return (me && me.token) || storage.getItem(TOKEN_KEY) || sessionStore.getItem(TOKEN_KEY) || "";
    },

    /** authorization headers for POS API requests */
    authHeaders() {
      // Area passwords use independent, scoped database sessions. They work
      // without staff PINs, JWTs or environment-variable credentials.
      const areaHeaders = typeof PosAccess !== "undefined" && PosAccess.headers ? PosAccess.headers() : {};
      if (Auth.openAccess()) return areaHeaders;
      const tok = Auth.token();
      return Object.assign({}, areaHeaders, tok ? { "Authorization": "Bearer " + tok, "X-Terminal-Key": tok } : {});
    },

    signIn(staff) {
      if (!staff) return;
      const session = {
        id: staff.id || "STAFF-01",
        name: staff.name || "Staff Member",
        role: staff.role || "cashier",
        token: staff.token || staff.terminal_key || "",
        access_mode: staff.access_mode || "credential",
        since: new Date().toISOString()
      };
      try { storage.setItem(LS_KEY, JSON.stringify(session)); } catch (e) {}
      try { sessionStore.setItem(SS_KEY, JSON.stringify(session)); } catch (e) {}
      if (session.token) {
        try { storage.setItem(TOKEN_KEY, session.token); } catch (e) {}
        try { sessionStore.setItem(TOKEN_KEY, session.token); } catch (e) {}
      } else {
        try { storage.removeItem(TOKEN_KEY); } catch (e) {}
        try { sessionStore.removeItem(TOKEN_KEY); } catch (e) {}
      }
      if (authBc) {
        try { authBc.postMessage({ type: "SIGN_IN", staff: session }); } catch (e) {}
      }
    },

    signOut() {
      try { storage.removeItem(LS_KEY); } catch (e) {}
      try { sessionStore.removeItem(SS_KEY); } catch (e) {}
      try { storage.removeItem(TOKEN_KEY); } catch (e) {}
      try { sessionStore.removeItem(TOKEN_KEY); } catch (e) {}
      try { sessionStore.removeItem(SUITE_KEY); } catch (e) {}
      try { sessionStore.removeItem("adonai-master-2026"); } catch (e) {}
      if (authBc) {
        try { authBc.postMessage({ type: "SIGN_OUT" }); } catch (e) {}
      }
    },

    /** Only an explicit server-side opt-in can require a PIN/key. */
    locked() { return !Auth.openAccess(); },

    /* ----------------------------------------------------------------
       ADMIN SUITE — PIN-free by default.
       Every dashboard opens directly in open mode. On an explicitly
       protected deployment, an admin-grade staff session or the store
       passkey unlocks analytics, inventory, intake, ledgers, staff and
       settings together — no repeated per-task credential prompts.
       ---------------------------------------------------------------- */

    /** true while the Admin Suite is unlocked for this session/tab */
    suiteUnlocked() {
      if (Auth.openAccess()) return true;
      try { if (sessionStore.getItem(SUITE_KEY) === "1") return true; } catch (e) {}
      const me = Auth.me();
      return !!(me && String(me.role || "").toLowerCase() === "admin" && Auth.token());
    },

    /** Grant suite access: persists an admin-grade session + the suite flag */
    unlockSuite(credential, staff) {
      const sessionInfo = Object.assign(
        { id: "ADMIN-SUITE", name: "Administrator", role: "admin" },
        staff || {}
      );
      sessionInfo.role = "admin";
      if (!sessionInfo.token) sessionInfo.token = String(credential || "");
      Auth.signIn(sessionInfo);
      try { sessionStore.setItem(SUITE_KEY, "1"); } catch (e) {}
      if (authBc) {
        try { authBc.postMessage({ type: "SUITE_UNLOCK" }); } catch (e) {}
      }
    },

    /** End the suite session: clears the flag and the stored credential */
    lockSuite() {
      try { sessionStore.removeItem(SUITE_KEY); } catch (e) {}
      Auth.signOut();
      if (authBc) {
        try { authBc.postMessage({ type: "SUITE_LOCK" }); } catch (e) {}
      }
    },

    /**
     * Route guard. Call at the very top of protected pages.
     * opts.role: 'admin' | 'cashier' | null (any staff role accepted).
     * In open-access mode this lets visitors through if unlocked.
     * @returns the active staff session, or null (also when redirecting)
     */
    guard(opts) {
      opts = opts || {};
      const me = Auth.me();
      if (!Auth.locked()) {
        return me; // free access mode
      }
      if (!me) {
        location.replace("login.html?next=" + encodeURIComponent(requestedPage()));
        return null;
      }
      if (opts.role === "admin" && me.role !== "admin") {
        location.replace("pos.html"); // cashiers bounce to the POS terminal
        return null;
      }
      return me;
    }
  };

  // Cross-tab synchronization
  if (typeof window !== "undefined") {
    if (authBc) {
      authBc.onmessage = ev => {
        if (ev.data && ev.data.type === "SIGN_OUT") {
          if (Auth.locked() && (location.pathname.endsWith("pos.html") || location.pathname.endsWith("admin.html"))) {
            location.replace("login.html?next=" + encodeURIComponent(requestedPage()));
          }
        }
      };
    }
  }

  global.Auth = Auth;
})(typeof window !== "undefined" ? window : globalThis);
