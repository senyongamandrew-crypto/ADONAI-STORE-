/* ============================================================
   ADONAI THRIFT STORE — AUTH / SESSION LAYER
   Open-access by design: while settings.access_locked = false
   every interface (POS + admin) is freely reachable.
   The admin creates staff accounts + PINs later and flips the
   lock on — guards then enforce PIN sessions (role-based).
   ============================================================ */
(function (global) {
  "use strict";

  const SS_KEY = "adonai-session-v1";
  const ss = (typeof sessionStorage !== "undefined") ? sessionStorage : {
    _m: {},
    getItem(k) { return this._m[k] || null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; }
  };

  function page() {
    try { return location.pathname.split("/").pop() || "index.html"; } catch (e) { return "index.html"; }
  }

  const Auth = {
    /** current signed-in staff member, or null */
    me() {
      try { return JSON.parse(ss.getItem(SS_KEY)); } catch (e) { return null; }
    },
    signIn(staff) {
      ss.setItem(SS_KEY, JSON.stringify({ id: staff.id, name: staff.name, role: staff.role, since: new Date().toISOString() }));
    },
    signOut() { ss.removeItem(SS_KEY); },

    /** true once the admin has enabled the staff PIN lock */
    locked() {
      try { return !!DB.getSettings().access_locked; } catch (e) { return false; }
    },

    /**
     * Route guard. Call at the very top of protected pages.
     * opts.role: 'admin' | 'cashier' | null (any staff role accepted).
     * In open-access mode this always lets visitors through (returns session or null).
     * @returns the active staff session, or null (also when redirecting)
     */
    guard(opts) {
      opts = opts || {};
      if (!Auth.locked()) return Auth.me();           // free access mode
      const me = Auth.me();
      if (!me) {
        location.replace("login.html?next=" + encodeURIComponent(page() + location.search));
        return null;
      }
      if (opts.role === "admin" && me.role !== "admin") {
        location.replace("pos.html");                  // cashiers bounce to the terminal
        return null;
      }
      return me;
    }
  };

  global.Auth = Auth;
})(typeof window !== "undefined" ? window : globalThis);
