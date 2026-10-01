/* ============================================================
   ADONAI THRIFT STORE — AUTH & POS SESSION LAYER
   Coordinated authentication for Cashier Terminal & Admin Console.
   Persists active staff session & JWT token across tabs via localStorage.
   ============================================================ */
(function (global) {
  "use strict";

  const LS_KEY = "adonai-session-v2";
  const SS_KEY = "adonai-session-v1";
  const TOKEN_KEY = "adonai-terminal-token";
  const BC_NAME = "adonai-auth-events";

  const storage = (typeof localStorage !== "undefined") ? localStorage : {
    _m: {},
    getItem(k) { return this._m[k] || null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; }
  };
  const sessionStore = (typeof sessionStorage !== "undefined") ? sessionStorage : storage;

  let authBc = null;
  if (typeof BroadcastChannel !== "undefined") {
    try { authBc = new BroadcastChannel(BC_NAME); } catch (e) {}
  }

  function page() {
    try { return location.pathname.split("/").pop() || "index.html"; } catch (e) { return "index.html"; }
  }

  const Auth = {
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
      const tok = Auth.token();
      return tok ? { "Authorization": "Bearer " + tok, "X-Terminal-Key": tok } : {};
    },

    signIn(staff) {
      if (!staff) return;
      const session = {
        id: staff.id || "STAFF-01",
        name: staff.name || "Staff Member",
        role: staff.role || "cashier",
        token: staff.token || staff.terminal_key || "",
        since: new Date().toISOString()
      };
      try { storage.setItem(LS_KEY, JSON.stringify(session)); } catch (e) {}
      try { sessionStore.setItem(SS_KEY, JSON.stringify(session)); } catch (e) {}
      if (session.token) {
        try { storage.setItem(TOKEN_KEY, session.token); } catch (e) {}
        try { sessionStore.setItem(TOKEN_KEY, session.token); } catch (e) {}
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
      if (authBc) {
        try { authBc.postMessage({ type: "SIGN_OUT" }); } catch (e) {}
      }
    },

    /** true once the admin has enabled the staff PIN lock */
    locked() {
      try {
        if (typeof DB !== "undefined" && DB.getSettings) {
          return !!DB.getSettings().access_locked;
        }
        return false;
      } catch (e) {
        return false;
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
        location.replace("login.html?next=" + encodeURIComponent(page() + location.search));
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
            location.replace("login.html?next=" + encodeURIComponent(page() + location.search));
          }
        }
      };
    }
  }

  global.Auth = Auth;
})(typeof window !== "undefined" ? window : globalThis);
