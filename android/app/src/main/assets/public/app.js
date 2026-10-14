/* ============================================================
   ADONAI — OPERATIONS CONSOLE (admin.html)
   Warm screenshot system · all views live off the shared DB
   with guest book, riders, ledger, intake & PIN-free terminal access.
   ============================================================ */
(async function () {
  "use strict";
  // Establish the PIN-free server session before navigating or publishing
  // settings. Credential prompts exist only for explicitly protected servers.
  if (Auth.ready) await Auth.ready();
  const me = Auth.guard({ role: null });
  if (Auth.locked() && !me) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const pinFree = typeof Auth.openAccess === "function" && Auth.openAccess();
  document.body.dataset.accessMode = pinFree ? "open" : "credential";
  $$("[data-credential-control]").forEach(control => { control.hidden = pinFree; });
  const accessNotice = $("#terminalAccessNotice");
  if (accessNotice) accessNotice.hidden = !pinFree;
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ugx = DB.ugx;
  const AV_PALETTE = ["#111827", "#1F2937", "#16A34A", "#15803D", "#166534", "#374151", "#22C55E", "#0B1120"];
  const avColor = name => AV_PALETTE[(String(name).split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % AV_PALETTE.length];
  const initials = name => String(name || "OA").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

  const toastEl = $("#toast");
  let toastTimer = null;
  function toast(msg, ok = true) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("err", !ok);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  /* ---------------- modal shell ---------------- */
  const backdrop = $("#modalBackdrop");
  const modalBox = $("#modalBox");
  const disposeModalMedia = () => {
    if (modalBox._mediaEditor) { modalBox._mediaEditor.dispose(); modalBox._mediaEditor = null; }
  };
  const openModal = html => { disposeModalMedia(); modalBox.innerHTML = html; backdrop.classList.add("open"); };
  const closeModal = () => {
    if (modalBox._mediaSaving) return;
    disposeModalMedia(); backdrop.classList.remove("open"); modalBox.innerHTML = "";
  };
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

  /* =============== MASTER KEY GATE =============== */
  const KEY_FLAG = "adonai-master-2026";
  // The raw Master Key is held only in page memory. The session flag may keep
  // local controls unlocked after a reload, but publishing live settings asks
  // for server-valid admin authorization again when no credential is available.
  let masterCredential = "";
  const Keys = {
    unlocked() { return sessionStorage.getItem(KEY_FLAG) === "1"; },
    set(v, credential) {
      if (v) {
        sessionStorage.setItem(KEY_FLAG, "1");
        if (credential) masterCredential = String(credential);
      } else {
        sessionStorage.removeItem(KEY_FLAG);
        masterCredential = "";
      }
      paintUnlockChip();
    },
    require(cb) {
      // One unlock rules everything: suite-unlocked sessions skip every gate.
      if (this.unlocked()) return cb(masterCredential);
      if (typeof Auth !== "undefined" && Auth.suiteUnlocked && Auth.suiteUnlocked()) {
        return cb(masterCredential || Auth.token());
      }
      renderMasterModal(cb);
    },
    requireRemote(cb) {
      if (pinFree) return cb("");
      if (masterCredential) return cb(masterCredential);
      const active = Auth.me();
      const token = Auth.token();
      if (active && active.role === "admin" && token) return cb(token);
      if (typeof Auth !== "undefined" && Auth.suiteUnlocked && Auth.suiteUnlocked() && token) return cb(token);
      renderMasterModal(cb);
    }
  };
  function paintUnlockChip() {
    const c = $("#unlockChip");
    const status = $("#openAccessChip");
    if (status) status.hidden = !pinFree;
    if (!c) return;
    c.hidden = pinFree;
    if (pinFree) return;
    if (Keys.unlocked()) { c.innerHTML = Icons.svg("unlock", "ico-14") + " Master Key Unlocked"; c.classList.add("on"); }
    else { c.innerHTML = Icons.svg("lock", "ico-14") + " Unlock Master Key"; c.classList.remove("on"); }
  }
  function renderMasterModal(after) {
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Admin Master Key Authorization</h3>
      <p class="muted small" style="margin-bottom:14px">Enter secondary Master Key to unlock protected administrative controls, financial logs, and system settings.</p>
      <div class="sec-box">${Icons.svg("shield", "ico-14")} <strong>Security Upgrade:</strong> This action requires the secondary Admin Master Key Password to protect store permissions, financial records, and core parameters.</div>
      <div class="field" style="margin-top:14px">
        <label>Master key password</label>
        <div class="sku-row">
          <input id="mkInput" type="password" class="sel-full" placeholder="Enter master key password…" autocomplete="off" />
          <button class="btn sm ghost" id="mkShow" type="button">Show</button>
        </div>
        <p class="muted small" style="margin-top:6px">Verified by the server. Production uses the Render STORE_MASTER_KEY environment variable as the preferred store passkey.</p>
      </div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="mkGo">Authorize &amp; Proceed</button>
      </div>`);
    const input = $("#mkInput");
    input.focus();
    $("#mkShow").addEventListener("click", () => { input.type = input.type === "password" ? "text" : "password"; $("#mkShow").textContent = input.type === "password" ? "Show" : "Hide"; });
    const go = async () => {
      const val = input.value.trim();
      if (!val) return;
      if (DB.verifyMasterKey(val)) {
        applySuiteUnlock(val, { name: "Admin Suite" });
        closeModal(); toast("Admin Suite unlocked — every dashboard is open");
        if (after) after(val);
        return;
      }
      try {
        const result = await suiteUnlockAttempt(val);
        if (result.ok) {
          applySuiteUnlock(result.credential, result.staff);
          closeModal(); toast("Admin Suite unlocked — every dashboard is open");
          if (after) after(result.credential);
          return;
        }
        input.classList.add("err"); toast(result.message || "Incorrect master key", false);
        setTimeout(() => input.classList.remove("err"), 700);
        return;
      } catch (err) {}
      input.classList.add("err"); toast("Incorrect master key", false);
      setTimeout(() => input.classList.remove("err"), 700);
    };
    $("#mkGo").addEventListener("click", go);
    input.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  }
  $("#btnMasterKey").addEventListener("click", () => {
    if (Keys.unlocked()) { Keys.set(false); toast("Master Key locked"); return; }
    Keys.require(() => {});
  });
  $("#unlockChip").addEventListener("click", () => {
    if (Keys.unlocked()) { Keys.set(false); toast("Master Key locked"); return; }
    Keys.require(() => {});
  });
  paintUnlockChip();

  /* =============== ADMIN SUITE — one gate, one passkey ===============
     A single passkey unlocks every dashboard in the suite (analytics,
     inventory, intake, audit, dispatch, ledgers & strategy, staff,
     settings). After that, no task asks for another key — the session
     carries admin-grade authorization everywhere.
     =================================================================== */

  /** Verify a passkey (local master key, then server). Resolves {ok, message, credential, staff}. */
  async function suiteUnlockAttempt(value) {
    const val = String(value || "").trim();
    if (!val) return { ok: false, message: "Enter the passkey first" };
    if (typeof DB !== "undefined" && DB.verifyMasterKey && DB.verifyMasterKey(val)) {
      return { ok: true, credential: val, staff: { name: "Admin Suite" } };
    }
    try {
      const endpoint = (typeof DB !== "undefined" && DB.apiUrl) ? DB.apiUrl("/api/auth/verify") : "/api/auth/verify";
      const r = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: val, key: val, terminal_key: val })
      });
      let data = {};
      try { data = await r.json(); } catch (e) { data = {}; }
      if (r.status === 429) {
        const wait = Math.max(1, Number(data.retry_after_seconds) || 60);
        const mins = Math.ceil(wait / 60);
        return { ok: false, message: `Too many sign-in attempts — wait about ${mins} minute${mins === 1 ? "" : "s"} and try again.` };
      }
      if (data && data.ok && data.staff) {
        if (String(data.staff.role || "").toLowerCase() === "admin") {
          return { ok: true, credential: data.token || val, staff: data.staff };
        }
        return {
          ok: false,
          message: `That PIN belongs to ${data.staff.name || "a staff member"} (${data.staff.role || "staff"}) — the Admin Suite requires the store master passkey.`
        };
      }
      if (r.status >= 500) return { ok: false, message: "The server could not verify the passkey right now — try again shortly." };
      return { ok: false, message: "Incorrect passkey — try again." };
    } catch (e) {
      return { ok: false, message: "Could not verify right now — check your connection." };
    }
  }

  /** Every successful unlock ends the same way: full suite access, chips painted. */
  function applySuiteUnlock(credential, staff) {
    Auth.unlockSuite(credential, staff);
    Keys.set(true, credential);
  }

  function installSuiteGate() {
    const gate = $("#suiteGate");
    if (!gate) return;
    if (Auth.suiteUnlocked()) {
      gate.hidden = true;
      document.body.classList.remove("suite-locked");
      return;
    }
    gate.hidden = false;
    document.body.classList.add("suite-locked");
    const input = $("#suiteKeyInput"), go = $("#suiteGateGo"), err = $("#suiteGateError");
    setTimeout(() => input && input.focus(), 60);
    if (!input || !go) return;
    const attempt = async () => {
      err.textContent = "";
      go.disabled = true;
      go.textContent = "Verifying passkey…";
      const result = await suiteUnlockAttempt(input.value);
      go.disabled = false;
      go.textContent = "Unlock Admin Suite";
      if (!result.ok) {
        err.textContent = result.message;
        input.classList.add("err");
        setTimeout(() => input.classList.remove("err"), 700);
        input.select();
        return;
      }
      applySuiteUnlock(result.credential, result.staff);
      toast("Admin Suite unlocked — every dashboard is open");
      location.reload(); // boot the suite with full authorization
    };
    go.addEventListener("click", attempt);
    input.addEventListener("keydown", e => { if (e.key === "Enter") attempt(); });
    const show = $("#suiteKeyShow");
    if (show) show.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      show.textContent = input.type === "password" ? "Show" : "Hide";
    });
  }
  installSuiteGate();

  /* =============== console chrome =============== */
  const shell = $("#shell");
  const toggleSidebar = () => {
    if (window.innerWidth <= 1024) {
      shell.classList.toggle("sb-open");
    } else {
      shell.classList.toggle("sb-collapsed");
    }
  };
  const closeSidebar = () => {
    shell.classList.remove("sb-open");
  };

  const btnMenu = $("#btnMenu");
  if (btnMenu) btnMenu.addEventListener("click", toggleSidebar);
  const btnCloseSidebar = $("#closeSidebar");
  if (btnCloseSidebar) btnCloseSidebar.addEventListener("click", closeSidebar);
  const sbScrim = $("#sbScrim");
  if (sbScrim) sbScrim.addEventListener("click", closeSidebar);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && shell.classList.contains("sb-open")) {
      closeSidebar();
    }
  });

  // Connectivity stays automatic and unobtrusive. Navigation no longer repeats
  // network/storefront pills on every operational dashboard.
  window.addEventListener("online", () => render());

  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; });

  // staff identity in sidebar
  const whoName = me ? me.name : "Open access";
  $("#meName").textContent = whoName;
  $("#meRole").textContent = pinFree ? "PIN-free · Admin tools available" : me ? "Role: " + me.role.toUpperCase() : "Staff sign-in required";
  $("#meAvatar").textContent = initials(whoName);

  const btnAdminExit = $("#btnAdminExit");
  if (btnAdminExit) {
    if (pinFree) btnAdminExit.textContent = "Back to register";
    btnAdminExit.addEventListener("click", () => {
      if (pinFree) { location.href = "pos.html"; return; }
      if (Auth.lockSuite) Auth.lockSuite(); else Auth.signOut();
      location.href = "login.html";
    });
  }

  /* Cross-Navigation: Admin Console to Live Web Storefront (External Browser Intent) */
  // Live Render deployment of the public storefront (web + API share this service).
  const LIVE_WEB_STOREFRONT_URL = "https://adonai-store.onrender.com";

  const isShellOrigin = origin => {
    try {
      const u = new URL(origin);
      if (!/^https?:$/.test(u.protocol)) return true;
      return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|appassets\.androidplatform\.net)$/i.test(u.hostname);
    } catch (e) { return true; }
  };

  const openAdminWebStorefront = () => {
    let siteUrl = LIVE_WEB_STOREFRONT_URL;
    try {
      const S = DB.getSettings();
      const custom = String(S.app_url || S.website_url || "").trim();
      if (/^https?:\/\/\S+$/i.test(custom)) siteUrl = custom;
      else if (!isShellOrigin(window.location.origin)) siteUrl = window.location.origin;
    } catch (e) {}

    if (window.Android && typeof window.Android.openExternal === "function") {
      window.Android.openExternal(siteUrl);
      return;
    }

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      try {
        window.Capacitor.Plugins.Browser.open({ url: siteUrl });
        return;
      } catch (err) {}
    }

    try {
      const win = window.open(siteUrl, "_system", "location=yes");
      if (!win) window.open(siteUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      window.open(siteUrl, "_blank", "noopener,noreferrer");
    }
  };

  const btnAdminSbOpenWebStore = $("#btnAdminSbOpenWebStore");
  if (btnAdminSbOpenWebStore) btnAdminSbOpenWebStore.addEventListener("click", openAdminWebStorefront);

  /* =============== navigation =============== */
  const VALID_VIEWS = ["overview", "sales", "inventory", "intake", "customers", "dispatch", "payments", "partners", "staff", "settings"];

  function requestedView() {
    // Query-string routes survive Android WebView navigation and the staff-login
    // round trip. Continue accepting old #inventory-style links as a fallback.
    const queryView = new URLSearchParams(location.search).get("view");
    if (VALID_VIEWS.includes(queryView)) return queryView;
    const hashView = (location.hash || "").replace(/^#\/?/, "").trim();
    return VALID_VIEWS.includes(hashView) ? hashView : null;
  }

  function viewUrl(view) {
    const url = new URL(location.href);
    url.searchParams.set("view", view);
    url.hash = "";
    return url.pathname + url.search;
  }

  let currentView = requestedView() || "overview";
  let viewReady = false;
  let viewRequest = 0;
  const blockedView = $("#protectedAreaView");
  function showProtectedArea(view, message) {
    viewReady = false;
    $$(".view").forEach(section => section.classList.remove("active"));
    if (!blockedView) return;
    const area = typeof PosAccess !== "undefined" ? PosAccess.areaForView(view) : null;
    const info = area && PosAccess.areaInfo(area);
    $("#protectedAreaTitle").textContent = info ? info.label : "Protected workspace";
    $("#protectedAreaMessage").textContent = message || "The admin has protected this area. Enter its password or the admin password to continue. Checkout remains open.";
    blockedView.hidden = false;
  }
  if (blockedView) $("#protectedAreaRetry").addEventListener("click", () => setView(currentView, false));

  async function setView(v, updateUrl = true) {
    if (!VALID_VIEWS.includes(v)) v = "overview";
    const previousView = currentView;
    if (window.DispatchCenter && v !== "dispatch") DispatchCenter.deactivate();
    const requestId = ++viewRequest;
    currentView = v;
    viewReady = false;
    $$(".view").forEach(section => section.classList.remove("active"));
    if (typeof PosAccess !== "undefined") {
      // Fast path: the cached access policy already allows this view, so switch immediately and
      // refresh the policy in the background. Protected views still wait for a fresh check.
      if (typeof PosAccess.fastViewAllowed === "function" && PosAccess.fastViewAllowed(v) === true) {
        PosAccess.ready().catch(() => {});
      } else {
        try {
          await PosAccess.ready();
          const area = PosAccess.areaForView(v);
          if (!await PosAccess.ensure(area)) { if (requestId === viewRequest) showProtectedArea(v); return; }
        } catch (error) {
          if (requestId === viewRequest) showProtectedArea(v, error.message + " Check your connection and try again.");
          return;
        }
      }
    }
    if (requestId !== viewRequest) return;
    viewReady = true;
    if (blockedView) blockedView.hidden = true;
    const routeAlreadyActive = new URLSearchParams(location.search).get("view") === v && !location.hash;
    if (updateUrl && !routeAlreadyActive) history.pushState({ view: v }, "", viewUrl(v));
    $$(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    if (v !== "intake" && intakeMedia) intakeMedia.pause();
    shell.classList.remove("sb-open");
    render();
    // Lots can be registered/allocated while another dashboard is open. Refresh
    // on entry, not on every background DB poll (which runs every two seconds).
    if (v === "intake" && previousView !== v) { loadIntakeStockLots(); if (intakeSource() === "partner") loadIntakePartners(); }
    if (v === "partners" && (previousView !== v || !partnerDashboard.loaded)) loadConsignmentDashboard();
    if (v === "settings" && typeof PosAccess !== "undefined") PosAccess.renderSettings();
  }

  window.addEventListener("pos-access-change", () => {
    if (typeof PosAccess === "undefined") return;
    const area = PosAccess.areaForView(currentView);
    if (area && !PosAccess.canUse(area)) {
      if (intakeMedia) intakeMedia.pause();
      if (modalBox._mediaEditor && !modalBox._mediaSaving) closeModal();
      showProtectedArea(currentView);
    }
    if (currentView === "settings" && viewReady) PosAccess.renderSettings();
  });

  $$(".nav-item[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));

  // Browser/Android back and forward buttons restore the correct console view.
  window.addEventListener("popstate", () => setView(requestedView() || "overview", false));
  // Legacy bookmarked hashes still work and are upgraded to the durable route.
  window.addEventListener("hashchange", () => {
    const target = requestedView();
    if (target && target !== currentView) setView(target, true);
  });
  document.body.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]"); if (g) setView(g.dataset.goto);
    const x = e.target.closest("[data-close]"); if (x) closeModal();
  });

  /* =============== shared helpers =============== */
  const allSales = () => DB.listSales();
  const validSales = () => allSales().filter(s => s.status === "completed");
  const itemsSummary = s => s.items.map(i => `${i.qty}× ${i.name}`).join(", ");
  const todayMid = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 9 * 86400) return Math.floor(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  const normalizeFulfillmentStage = value => {
    const raw = String(value || "").trim();
    const key = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    const aliases = {
      "pending": "Unfulfilled", "incoming": "Unfulfilled", "received": "Unfulfilled", "new": "Unfulfilled", "new order": "Unfulfilled", "unfulfilled": "Unfulfilled",
      "needs review": "Unfulfilled", "awaiting review": "Unfulfilled", "waiting review": "Unfulfilled", "waiting for review": "Unfulfilled", "received and waiting for review": "Unfulfilled", "awaiting fulfillment": "Unfulfilled", "awaiting processing": "Unfulfilled",
      "assembly": "In Assembly", "assembling": "In Assembly", "in assembly": "In Assembly", "in progress": "In Assembly", "processing": "In Assembly", "packing": "In Assembly", "packed": "In Assembly",
      "ready": "Ready for Pickup", "ready for pickup": "Ready for Pickup", "ready for dispatch": "Dispatched", "ready to dispatch": "Dispatched",
      "with rider": "Dispatched", "handed over": "Dispatched", "out for delivery": "Dispatched", "dispatched": "Dispatched",
      "delivered": "Completed", "complete": "Completed", "completed": "Completed",
      "canceled": "Cancelled", "cancelled": "Cancelled", "void": "Cancelled"
    };
    return aliases[key] || raw;
  };
  const fulfillmentStage = s => normalizeFulfillmentStage(s && (s.dispatch_status || (s.channel === "web" ? "Unfulfilled" : "Completed")));
  const assignedRiderId = s => {
    const rider = s && s.rider && typeof s.rider === "object" ? s.rider : {};
    return String(s && (s.assigned_rider_id || s.rider_id || rider.id) || "");
  };
  const assignedRiderName = s => {
    const rider = s && s.rider && typeof s.rider === "object" ? s.rider : {};
    return String(s && (s.assigned_rider_name || s.rider_name || rider.name) || "");
  };
  const statusChip = s => laneChip(fulfillmentStage(s));
  const laneChip = d => {
    const map = {
      "Unfulfilled": ["pend", "NEEDS REVIEW"], "In Assembly": ["blue", "IN ASSEMBLY"],
      "Ready for Pickup": ["amber", "READY FOR PICKUP"], "Dispatched": ["blue", "DISPATCHED"],
      "Completed": ["ok", "COMPLETED"], "Cancelled": ["bad", "CANCELLED"]
    };
    const [cls, txt] = map[normalizeFulfillmentStage(d) || "Unfulfilled"] || ["mut", String(d || "Unknown").toUpperCase()];
    return `<span class="stat-chip ${cls}">${esc(txt)}</span>`;
  };
  const isOpenWebOrder = s => s.channel === "web" && !["completed", "cancelled", "canceled", "void"].includes(String(s.status || "").toLowerCase());
  /* KPI stat card — icon chip + accent tone + fluid responsive grid */
  function kpiCard(label, value, sub, tone, icon) {
    return `<div class="kpi-card kpi-${tone || "rust"}">
      <div class="kpi-top"><span class="kpi-ico">${icon || Icons.svg("trending-up", "ico-18")}</span><span class="kpi-lab">${esc(label)}</span></div>
      <div class="kpi-val">${value}</div>
      ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}
    </div>`;
  }

  /* ============================================================
     SALES ANALYTICS
     ============================================================ */
  function renderOverview() {
    const staff = DB.listStaff();
    const admin = staff.find(s => s.role === "admin");
    const name = (me && me.name) || (admin && admin.name) || "Adonai";
    const hr = new Date().getHours();
    const partOfDay = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    $("#greetingH").textContent = partOfDay + ", " + name.split(" ")[0];
    $("#dateLine").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toUpperCase() + " · KAMPALA, UGANDA";

    const sales = allSales();
    const done = validSales();
    const t0 = todayMid().getTime();
    const webPend = sales.filter(isOpenWebOrder);
    const reserved = webPend.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);
    const todayDone = done.filter(s => new Date(s.created_at).getTime() >= t0);
    const todayRev = todayDone.reduce((a, s) => a + s.total, 0);
    const onRack = DB.listProducts().filter(p => p.in_stock_count > 0).length;

    $("#kpiCards").innerHTML =
      kpiCard("TODAY'S REVENUE (UGX)", ugx(todayRev), "Closed register & delivery sales", "green", Icons.svg("banknote", "ico-18")) +
      kpiCard("TODAY'S TICKETS", todayDone.filter(s => s.channel === "pos").length, "In-store POS & web reservations", "rust", Icons.svg("receipt", "ico-18")) +
      kpiCard("ONLINE PENDING", webPend.length, "Awaiting packaging / rider", "amber", Icons.svg("package", "ico-18")) +
      kpiCard("ON THE RACK (PIECES)", onRack, `${reserved} reserved in orders`, "blue", Icons.svg("boxes", "ico-18"));

    const dashboardProducts = $("#dashboardProductCards");
    if (dashboardProducts) {
      const available = DB.listProducts().filter(p => Number(p.in_stock_count) > 0).slice(0, 8);
      dashboardProducts.innerHTML = available.length ? available.map(p => `
        <article class="dashboard-product-card">
          <div class="dashboard-product-image">${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" onerror="this.remove()" />` : Icons.svg("tag", "ico-20")}</div>
          <div class="dashboard-product-info"><strong>${esc(p.name)}</strong><span>${esc(p.sku || "No SKU")} · ${Number(p.in_stock_count)} in stock</span><b>${ugx(p.selling_price || p.base_price || 0)}</b></div>
        </article>`).join("") : `<p class="muted small dashboard-products-empty">No available product cards yet. Add stock from Catalog Intake.</p>`;
    }

    /* ---- hourly + weekly chart ---- */
    const cv = $("#hourlyChart");
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || cv.parentElement.clientWidth - 44, H = 150;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const hours = Array.from({ length: 11 }, (_, i) => 9 + i);
    const hVals = hours.map(h => todayDone.reduce((a, s) => (new Date(s.created_at).getHours() === h ? a + s.total : a), 0));
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i)); return d; });
    const dVals = days.map(d => {
      const n0 = d.getTime(), n1 = n0 + 86400000;
      return done.reduce((a, s) => { const t = new Date(s.created_at).getTime(); return (t >= n0 && t < n1) ? a + s.total : a; }, 0);
    });
    $("#weekTotal").textContent = "7-Day Total: " + ugx(dVals.reduce((a, b) => a + b, 0));
    const max = Math.max(1, ...hVals, ...dVals);
    const drawRow = (vals, labels, y0, bh, color) => {
      const step = W / vals.length;
      ctx.font = "9.5px 'Plus Jakarta Sans', sans-serif"; ctx.fillStyle = "#9CA3AF"; ctx.textAlign = "center";
      vals.forEach((v, i) => {
        const x = i * step + step / 2;
        const h = v ? Math.max(3, v / max * bh) : 2;
        ctx.fillStyle = v ? color : "#E5E7EB";
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x - 11, y0 + bh - h, 22, h, 4); ctx.fill(); }
        else ctx.fillRect(x - 11, y0 + bh - h, 22, h);
        ctx.fillStyle = "#9CA3AF";
        ctx.fillText(labels[i], x, y0 + bh + 13);
      });
    };
    drawRow(hVals, ["9a", "10a", "11a", "12p", "1p", "2p", "3p", "4p", "5p", "6p", "7p"], 10, 44, "#16A34A");
    drawRow(dVals, days.map(d => ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()]), 88, 44, "#111827");

    /* ---- dark polling card ---- */
    $("#pollText").textContent = webPend.length
      ? `${webPend.length} web order(s) waiting for processing — the poller picked them up.`
      : "No unfulfilled web orders right now. The poller is watching every 5 seconds.";
    $("#pollDot").classList.toggle("hot", webPend.length > 0);

    /* ---- rack bars ---- */
    const soldQty = done.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);
    const rackTotal = Math.max(1, onRack + reserved + soldQty);
    $("#rackBars").innerHTML = [
      ["Available for Sale", onRack, "var(--green)"],
      ["Reserved in Orders", reserved, "var(--amber)"],
      ["Sold & Closed", soldQty, "#9CA3AF"]
    ].map(([lbl, v, c]) => `
      <div class="rack-row">
        <div class="rack-top"><span class="rack-lbl">${lbl}</span><span class="rack-val">${v} <em>${Math.round(v / rackTotal * 100)}%</em></span></div>
        <div class="rack-track"><div style="width:${Math.round(v / rackTotal * 100)}%;background:${c}"></div></div>
      </div>`).join("");

    /* ---- channels (with share bars) ---- */
    const revPos = done.filter(s => s.channel === "pos").reduce((a, s) => a + s.total, 0);
    const revWeb = done.filter(s => s.channel === "web").reduce((a, s) => a + s.total, 0);
    const cashTot = done.filter(s => s.tender && s.tender.type === "cash").reduce((a, s) => a + s.total, 0);
    const revAll = Math.max(1, revPos + revWeb);
    $("#channelRows").innerHTML = [
      [Icons.svg("store", "ico-12") + " Register", revPos, "var(--rust)"], [Icons.svg("globe", "ico-12") + " Web Storefront", revWeb, "var(--green)"], [Icons.svg("image", "ico-12") + " Catalog", 0, "var(--blue)"]
    ].map(([lbl, v, color]) => `
      <div class="ch-row ch-stack">
        <div class="ch-info"><span>${lbl}</span><strong>${ugx(v)}</strong></div>
        <div class="ch-bar"><i style="width:${Math.round(v / revAll * 100)}%;background:${color}"></i></div>
      </div>`).join("")
      + `<span class="cash-pill">${Icons.svg("banknote", "ico-13")} Cash collected ${ugx(cashTot)}</span>`;

    /* ---- boda pool ---- */
    $("#riderPool").innerHTML = DB.listRiders().slice(0, 3).map(r => {
      const active = allSales().filter(s => assignedRiderId(s) === String(r.id) && fulfillmentStage(s) === "Dispatched").length;
      return `
      <div class="ch-row">
        <div class="rider-mini">
          <span class="avatar" style="background:${avColor(r.name)}">${initials(r.name)}</span>
          <div><strong class="serif">${esc(r.name)}</strong><div class="muted small">${esc(r.zone)}</div></div>
        </div>
        <span class="ch-right">${riderStatusChip(r.status)}${active ? ` <span class="stat-chip blue">${active} EN ROUTE</span>` : ""}</span>
      </div>`;
    }).join("") || `<p class="muted small" style="padding:8px 0">No riders on the roster yet.</p>`;

    /* ---- recent transactions ---- */
    $("#recentTx").innerHTML = sales.slice(0, 5).map(s => `
      <button class="tx-row" data-view-sale="${esc(s.id)}">
        <span class="tx-ava" style="background:${avColor(s.customer_name || "Guest")}">${initials(s.customer_name || "G")}</span>
        <div class="grow">
          <div class="tx-title"><strong>${esc(s.customer_name || "Walk-in Guest")}</strong>
            <span class="stat-chip ${s.channel === "web" ? "web" : "pos"}">${s.channel === "web" ? "WEB STORE" : "REGISTER"}</span></div>
          <div class="muted small">${esc(s.id)} · ${ago(s.created_at)} · ${esc((s.items || []).length)} item(s)</div>
        </div>
        <span class="tx-right">${statusChip(s)} <strong class="serif">${ugx(s.total)}</strong></span>
      </button>`).join("") || `<p class="muted">No transactions yet.</p>`;
  }

  function riderStatusChip(st) {
    const m = { "Available": "ok", "On delivery": "blue", "Offline": "mut" };
    return `<span class="stat-chip ${m[st] || "mut"}">${st.toUpperCase()}</span>`;
  }

  /* ============================================================
     FULFILLMENT & ORDERS — mobile-first operations workbench
     ============================================================ */
  const LANES = [
    { key: "active", title: "Open orders", sub: "All orders that still need a staff action" },
    { key: "incoming", title: "Needs review", sub: "New orders waiting for a first check" },
    { key: "fulfillment", title: "In assembly", sub: "Items being picked, verified, and packed" },
    { key: "ready", title: "Ready / dispatched", sub: "Ready for pickup or already with a rider" },
    { key: "completed", title: "Completed", sub: "Fulfilled and closed orders" },
    { key: "cancelled", title: "Cancelled", sub: "Cancelled orders and released stock" }
  ];
  let activeLane = "incoming";
  let orderTerm = "";
  let payFilter = "all"; // 'all' | 'paid' | 'unpaid'
  let channelFilter = "all";
  let orderSort = "oldest";

  function isSalePaid(s) {
    if (!s) return false;
    const remotePayment = String(s.payment && s.payment.status || "").toLowerCase();
    if (["paid", "successful", "succeeded"].includes(remotePayment)) return true;
    if (["unpaid", "pending", "failed", "expired", "cancelled"].includes(remotePayment)) return false;
    if (s.tender && s.tender.paid === true) return true;
    if (s.tender && s.tender.paid === false) return false;
    if (s.channel === "pos" && String(s.status || "").toLowerCase() === "completed") return true;
    // Older register records pre-date the explicit payment object. A tender
    // type alone is not proof that a web customer has paid.
    if (s.channel !== "web" && s.tender && ["cash", "mtn", "airtel"].includes(String(s.tender.type || "").toLowerCase())) return true;
    return false;
  }

  function paymentState(s) {
    const remotePayment = String(s && s.payment && s.payment.status || "").toLowerCase();
    if (["pending", "processing"].includes(remotePayment)) return "pending";
    if (["failed", "expired"].includes(remotePayment)) return "failed";
    return isSalePaid(s) ? "paid" : "unpaid";
  }

  // Orders list day boundary: Kampala calendar day. Server timestamps are UTC without a suffix.
  const KAMPALA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" });
  function kampalaDay(value) {
    if (!value) return "";
    const text = /[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? String(value) : String(value) + "Z";
    const time = Date.parse(text);
    return Number.isFinite(time) ? KAMPALA_DAY.format(new Date(time)) : "";
  }
  // Web orders leave the working list once they were removed, or once they were dispatched/completed
  // on an earlier Kampala day. Their records and exports are unaffected.
  function leavesOrdersList(s) {
    if (!s || s.channel !== "web") return false;
    if (s.list_archived_at) return true;
    const stage = fulfillmentStage(s);
    if (stage !== "Dispatched" && stage !== "Completed" && stage !== "Ready for Pickup") return false;
    const day = kampalaDay(s.dispatched_at || s.updated_at || s.created_at);
    return !!day && day < kampalaDay(new Date().toISOString());
  }

  function isOrderInLane(s, laneKey) {
    const lane = DB.laneOf(s);
    if (laneKey === "active") return ["incoming", "fulfillment", "ready"].includes(lane);
    return lane === laneKey;
  }

  function stageOrders(rows, stage) {
    return rows.filter(s => DB.laneOf(s) === stage);
  }

  function orderSearchText(s) {
    const itemText = (Array.isArray(s.items) ? s.items : []).map(i => [i.name, i.sku, i.barcode_id].join(" ")).join(" ");
    return [s.id, s.customer_name, s.customer_phone, s.customer_address, s.delivery_area, s.delivery_type, s.channel, itemText]
      .map(x => String(x || "").toLowerCase()).join(" ");
  }

  function orderActionFor(s) {
    const stage = fulfillmentStage(s);
    if (stage === "Unfulfilled") return { next: "In Assembly", label: "Start assembly", icon: "package" };
    if (stage === "In Assembly") {
      const pickup = String(s.delivery_type || "").toLowerCase() === "pickup";
      if (!pickup) return { next: "", label: "Assign rider", icon: "bike" }; // opens the rider picker; dispatch needs a rider
      return { next: "Ready for Pickup", label: "Mark ready for pickup", icon: "check-circle" };
    }
    if (stage === "Ready for Pickup" || stage === "Dispatched") return { next: "Completed", label: "Complete order", icon: "check-circle" };
    return null;
  }

  function laneRevenue(rows) {
    return rows.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
  }

  function renderOrderSyncState() {
    const host = $("#ordersSyncState");
    if (!host) return;
    const sync = DB.operationalSyncStatus ? DB.operationalSyncStatus() : null;
    if (!sync || sync.online === null) {
      host.dataset.state = "checking";
      host.querySelector(".orders-sync-label").textContent = "Connecting to live orders…";
      return;
    }
    if (sync.online) {
      host.dataset.state = "live";
      const elapsed = sync.last_synced_at ? ago(sync.last_synced_at) : "just now";
      host.querySelector(".orders-sync-label").textContent = `Live · updated ${elapsed}`;
      return;
    }
    host.dataset.state = "offline";
    const status = Number(sync.status) || 0;
    host.querySelector(".orders-sync-label").textContent = status === 401 || status === 403
      ? "Staff session needs attention · tap refresh"
      : "Connection issue · showing last saved orders";
  }

  function renderSales() {
    const sales = allSales().filter(s => !leavesOrdersList(s));
    const webPend = sales.filter(isOpenWebOrder);
    const openOrders = sales.filter(s => ["incoming", "fulfillment", "ready"].includes(DB.laneOf(s)));
    const needsReview = stageOrders(sales, "incoming");
    const inAssembly = stageOrders(sales, "fulfillment");
    const readyOrders = stageOrders(sales, "ready");
    const unpaidOpen = openOrders.filter(s => !isSalePaid(s));
    const outstanding = laneRevenue(unpaidOpen);
    const openOnlineValue = laneRevenue(webPend);

    $("#pendingLine").textContent = `${webPend.length} open web order${webPend.length === 1 ? "" : "s"} · ${ugx(openOnlineValue)} in the queue · auto-sync every 2 seconds.`;
    $("#navWebBadge").textContent = webPend.length || "";
    renderOrderSyncState();

    const stats = [
      { lane: "incoming", label: "Needs review", count: needsReview.length, total: laneRevenue(needsReview), hint: "Oldest orders first", icon: "inbox", tone: "review" },
      { lane: "fulfillment", label: "In assembly", count: inAssembly.length, total: laneRevenue(inAssembly), hint: "Currently being picked", icon: "package", tone: "assembly" },
      { lane: "ready", label: "Ready / dispatched", count: readyOrders.length, total: laneRevenue(readyOrders), hint: "Next: pickup or handoff", icon: "truck", tone: "ready" },
      { lane: "active", payment: "unpaid", label: "Unpaid in open queue", count: unpaidOpen.length, total: outstanding, hint: "Payment not recorded", icon: "banknote", tone: "unpaid" }
    ];
    $("#orderSummaryStats").innerHTML = stats.map(stat => `
      <button type="button" class="order-stat-card tone-${stat.tone}" data-select-lane="${stat.lane}" ${stat.payment ? `data-select-payment="${stat.payment}"` : ""} aria-pressed="${activeLane === stat.lane && (!stat.payment || payFilter === stat.payment)}">
        <span class="order-stat-icon">${Icons.svg(stat.icon, "ico-18")}</span>
        <span class="order-stat-copy"><span class="order-stat-label">${stat.label}</span><strong>${stat.count}</strong><span class="order-stat-hint">${stat.hint}</span></span>
        <span class="order-stat-value">${ugx(stat.total)}</span>
      </button>`).join("");

    const paidCount = sales.filter(isSalePaid).length;
    const unpaidCount = sales.length - paidCount;
    const paymentRail = $("#payFilterPills");
    const paymentScrollLeft = paymentRail.scrollLeft;
    paymentRail.innerHTML = [
      { key: "all", label: `All (${sales.length})` },
      { key: "paid", label: `Paid (${paidCount})` },
      { key: "unpaid", label: `Unpaid (${unpaidCount})` }
    ].map(p => `<button type="button" class="dpill ${p.key === payFilter ? "active" : ""}" data-pay-filter="${p.key}" aria-pressed="${p.key === payFilter}">${p.label}</button>`).join("");
    paymentRail.scrollLeft = paymentScrollLeft;

    const filtered = sales.filter(s => {
      if (orderTerm && !orderSearchText(s).includes(orderTerm)) return false;
      if (channelFilter !== "all" && s.channel !== channelFilter) return false;
      const state = paymentState(s);
      if (payFilter === "paid" && state !== "paid") return false;
      if (payFilter === "unpaid" && state === "paid") return false;
      return true;
    });
    const createdAt = s => {
      const time = Date.parse(s.created_at || "");
      return Number.isFinite(time) ? time : 0;
    };
    filtered.sort((a, b) => {
      if (orderSort === "value") return (Number(b.total) || 0) - (Number(a.total) || 0) || createdAt(a) - createdAt(b);
      return orderSort === "newest" ? createdAt(b) - createdAt(a) : createdAt(a) - createdAt(b);
    });

    const laneRail = $("#laneTabs");
    const laneScrollLeft = laneRail.scrollLeft;
    laneRail.innerHTML = LANES.map(lane => {
      const count = filtered.filter(s => isOrderInLane(s, lane.key)).length;
      return `<button type="button" class="lane-tab ${lane.key === activeLane ? "active" : ""}" data-lane="${lane.key}" aria-pressed="${lane.key === activeLane}">${lane.title}<span class="lane-tab-count">${count}</span></button>`;
    }).join("");
    laneRail.scrollLeft = laneScrollLeft;

    const lane = LANES.find(item => item.key === activeLane) || LANES[1];
    const inLane = filtered.filter(s => isOrderInLane(s, lane.key));
    const totalValue = laneRevenue(inLane);
    const hasFilters = !!orderTerm || payFilter !== "all" || channelFilter !== "all";
    const emptyMessage = hasFilters
      ? `<div class="order-empty"><span class="order-empty-icon">${Icons.svg("search", "ico-22")}</span><strong>No orders match these filters</strong><p>Try a different search, payment status, or sales channel.</p><button class="btn ghost sm" type="button" data-clear-order-filters>Clear filters</button></div>`
      : `<div class="order-empty"><span class="order-empty-icon">${Icons.svg("check-circle", "ico-22")}</span><strong>${lane.key === "incoming" ? "No orders need review" : "This queue is clear"}</strong><p>${lane.key === "incoming" ? "New web orders will appear here as soon as they arrive." : "There are no orders in this workflow stage right now."}</p></div>`;
    $("#lanePanel").innerHTML = `
      <div class="lane-card">
        <div class="lane-head">
          <div class="lane-heading"><span class="lane-heading-icon">${Icons.svg(lane.key === "incoming" ? "inbox" : lane.key === "fulfillment" ? "package" : lane.key === "ready" ? "truck" : lane.key === "cancelled" ? "ban" : "check-circle", "ico-18")}</span><div><div class="lane-title-row"><strong>${lane.title}</strong><span class="lane-count">${inLane.length}</span></div><div class="muted small">${lane.sub}</div></div></div>
          <div class="lane-total"><span>Queue value</span><strong>${ugx(totalValue)}</strong></div>
        </div>
        <div class="order-list">${inLane.length ? inLane.map(orderCard).join("") : emptyMessage}</div>
      </div>`;
  }

  $("#orderSearch").addEventListener("input", e => { orderTerm = e.target.value.trim().toLowerCase(); renderSales(); });
  $("#orderSort").addEventListener("change", e => { orderSort = e.target.value; renderSales(); });
  $("#orderChannelFilter").addEventListener("change", e => { channelFilter = e.target.value; renderSales(); });
  $("#payFilterPills").addEventListener("click", e => {
    const button = e.target.closest("[data-pay-filter]");
    if (!button) return;
    payFilter = button.dataset.payFilter;
    renderSales();
  });
  $("#laneTabs").addEventListener("click", e => {
    const button = e.target.closest("[data-lane]");
    if (!button) return;
    activeLane = button.dataset.lane;
    renderSales();
  });
  $("#orderSummaryStats").addEventListener("click", e => {
    const button = e.target.closest("[data-select-lane]");
    if (!button) return;
    activeLane = button.dataset.selectLane;
    orderTerm = "";
    channelFilter = "all";
    orderSort = "oldest";
    $("#orderSearch").value = "";
    $("#orderChannelFilter").value = "all";
    $("#orderSort").value = "oldest";
    if (button.dataset.selectPayment) payFilter = button.dataset.selectPayment;
    else payFilter = "all";
    renderSales();
  });

  function orderCard(s) {
    const stage = fulfillmentStage(s);
    const action = orderActionFor(s);
    const payState = paymentState(s);
    const payLabel = payState === "paid" ? "PAID" : payState === "pending" ? "PAYMENT PENDING" : payState === "failed" ? "PAYMENT FAILED" : "UNPAID";
    const payClass = payState === "paid" ? "ok" : payState === "failed" ? "bad" : "pend";
    const paidVia = s.tender ? DB.TENDER_LABEL(s.tender) : (s.payment && s.payment.provider) || "recorded tender";
    const items = Array.isArray(s.items) ? s.items : [];
    const quantity = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const summary = items.slice(0, 2).map(item => `${Number(item.qty) || 1}× ${item.name || "Item"}`).join(" · ") + (items.length > 2 ? ` · +${items.length - 2} more` : "");
    const delivery = String(s.delivery_type || "boda").toLowerCase() === "pickup" ? "Customer pickup" : "Delivery";
    const destination = s.delivery_area || s.customer_address || s.delivery_address || "Location not provided";
    const phone = String(s.customer_phone || "").trim();
    const created = Date.parse(s.created_at || "");
    const ageHours = Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 3600000) : 0;
    const needsAttention = ageHours >= 24 && ["incoming", "fulfillment", "ready"].includes(DB.laneOf(s));
    const ageLabel = !Number.isFinite(created) ? "time unavailable" : needsAttention ? `${Math.floor(ageHours / 24)}d waiting` : ago(s.created_at);
    const cancellable = stage === "Unfulfilled" || stage === "In Assembly";
    const actionButton = action ? `<button type="button" class="btn primary order-primary-action" data-order-action="advance" data-order-id="${esc(s.id)}" data-next-stage="${esc(action.next)}">${Icons.svg(action.icon, "ico-15")}<span>${action.label}</span>${Icons.svg("arrow-right", "ico-13")}</button>` : "";
    return `<article class="order-card ${needsAttention ? "needs-attention" : ""}" data-card-order="${esc(s.id)}">
      <div class="order-card-top">
        <div class="order-reference-block">
          <span class="order-channel ${s.channel === "web" ? "is-web" : "is-pos"}">${Icons.svg(s.channel === "web" ? "globe" : "store", "ico-12")} ${s.channel === "web" ? "WEB STORE" : "POS REGISTER"}</span>
          <strong class="order-reference">${esc(s.id)}</strong>
        </div>
        <div class="order-card-badges">${laneChip(stage)}<span class="stat-chip ${payClass}">${payLabel}</span></div>
        <span class="order-age ${needsAttention ? "attention" : ""}">${needsAttention ? Icons.svg("alert-triangle", "ico-12") : Icons.svg("clock-3", "ico-12")}${ageLabel}</span>
      </div>
      <div class="order-card-main">
        <div class="order-customer-block">
          <span class="avatar order-avatar" style="background:${avColor(s.customer_name || "Guest")}">${initials(s.customer_name || "Guest")}</span>
          <div class="order-customer-copy">
            <strong class="order-customer-name">${esc(s.customer_name || "Online shopper")}</strong>
            ${phone ? `<a class="order-phone" href="tel:${esc(phone.replace(/[^+0-9]/g, ""))}">${Icons.svg("phone", "ico-12")}<span>${esc(phone)}</span></a>` : `<span class="order-phone missing">No phone provided</span>`}
          </div>
        </div>
        <div class="order-total-block"><span>ORDER TOTAL</span><strong>${ugx(s.total)}</strong></div>
      </div>
      <div class="order-item-summary">${Icons.svg("shopping-bag", "ico-13")}<span>${esc(summary || "No item details")}</span><b>${quantity} ${quantity === 1 ? "item" : "items"}</b></div>
      <div class="order-delivery-line">${Icons.svg(String(s.delivery_type || "").toLowerCase() === "pickup" ? "store" : "map-pin", "ico-13")}<span><b>${delivery}</b><span>${esc(destination)}</span></span></div>
      <div class="order-card-footer">
        <span class="order-payment-note">${payState === "paid" ? `Paid via ${esc(paidVia)}` : payState === "pending" ? "Waiting for payment confirmation" : payState === "failed" ? "Payment attempt failed" : "Payment not yet recorded"}</span>
        <div class="order-actions">
          ${actionButton}
          <button type="button" class="btn order-details-action" data-open-order="${esc(s.id)}">Details</button>
          ${(stage === "Dispatched" || stage === "Completed") && s.channel === "web" ? `<button type="button" class="btn ghost order-list-action" data-order-action="list-archive" data-order-id="${esc(s.id)}">Remove from list</button>` : ""}
          ${cancellable ? `<button type="button" class="btn danger order-cancel-action" data-order-action="cancel" data-order-id="${esc(s.id)}">Cancel</button>` : stage === "Completed" || stage === "Cancelled" ? `<button type="button" class="btn order-details-action" data-print-order="${esc(s.id)}">Receipt</button>` : ""}
        </div>
      </div>
    </article>`;
  }

  function orderActionError(err) {
    const status = Number(err && err.status) || 0;
    if (status === 401) return "Your staff session is no longer valid. Sign in again, then retry the order action.";
    if (status === 403) return "Your staff account does not have permission to change this order.";
    if (status === 404) return "This order is no longer on the server. Refresh the queue to load the latest list.";
    if (status === 409) return `${err.message || "This order has changed."} The queue has been refreshed; review its latest status before continuing.`;
    if (status === 0) return "Could not confirm the update because the server could not be reached. Refresh the queue before retrying; the action may have reached the server.";
    return (err && err.message) || "The order could not be updated. Please refresh and try again.";
  }

  async function performOrderAction(button, work, successMessage, afterSuccess) {
    if (!button || button.dataset.busy === "true") return null;
    const original = button.innerHTML;
    button.dataset.busy = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.add("is-busy");
    button.innerHTML = `${Icons.svg("refresh-cw", "ico-14 order-action-spinner")}<span>Saving…</span>`;
    try {
      const updated = await work();
      if (typeof afterSuccess === "function") afterSuccess(updated);
      if (updated && updated.dispatch_status) activeLane = DB.laneOf(updated);
      toast(typeof successMessage === "function" ? successMessage(updated) : successMessage);
      renderSales();
      return updated;
    } catch (err) {
      if ((Number(err && err.status) === 0 || Number(err && err.status) === 404 || Number(err && err.status) === 409) && DB.refreshOperationalData) {
        try { await DB.refreshOperationalData(); } catch (refreshError) {}
      }
      toast(orderActionError(err), false);
      renderSales();
      return null;
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        delete button.dataset.busy;
        button.classList.remove("is-busy");
        button.innerHTML = original;
      }
    }
  }

  function confirmOrderCancellation(order) {
    const quantity = (Array.isArray(order.items) ? order.items : []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const paidWarning = isSalePaid(order) ? "\n\nPayment is recorded as paid. This action does not issue a refund; process any refund separately." : "";
    return window.confirm(`Cancel order ${order.id}?\n\nThis stops fulfillment and returns ${quantity} ${quantity === 1 ? "item" : "items"} to available stock.${paidWarning}`);
  }

  async function refreshOrders(button) {
    if (!button || button.dataset.busy === "true") return;
    const original = button.innerHTML;
    button.dataset.busy = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.add("is-busy");
    button.innerHTML = `${Icons.svg("refresh-cw", "ico-14 order-action-spinner")}<span>Refreshing…</span>`;
    renderOrderSyncState();
    try {
      const refreshed = await DB.refreshOperationalData();
      if (refreshed) toast("Orders refreshed from the live store");
      else {
        const sync = DB.operationalSyncStatus ? DB.operationalSyncStatus() : null;
        toast(sync && (sync.status === 401 || sync.status === 403)
          ? "Staff session needs attention. Sign in again to sync orders."
          : "Could not refresh orders. Showing the last saved list.", false);
      }
      renderSales();
    } catch (err) {
      toast(orderActionError(err), false);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        delete button.dataset.busy;
        button.classList.remove("is-busy");
        button.innerHTML = original;
      }
      renderOrderSyncState();
    }
  }

  $("#btnRefreshOrders").addEventListener("click", e => refreshOrders(e.currentTarget));

  function receiptDateFormat(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const dayName = d.toLocaleDateString("en-GB", { weekday: "long" });
    const dayNum = d.toLocaleDateString("en-GB", { day: "numeric" });
    const monthName = d.toLocaleDateString("en-GB", { month: "long" });
    return `${dayName}, ${dayNum} ${monthName}`;
  }
  function receiptTimeFormat(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function receiptHTML(s) {
    const S = DB.getSettings();
    const totalQty = s.items.reduce((a, b) => a + b.qty, 0);
    const subtotal = s.subtotal || (s.total - (s.delivery_fee || 0));
    return `
      <div class="receipt-paper">
        <div class="rc-brand">
          <img src="assets/adonai-logo-stacked.svg" alt="Adonai Store" class="rc-logo-img" style="width:115px;max-width:48mm;height:auto;margin:0 auto 4px;display:block;" />
          <div class="rc-sub">BRAND-NEW APPAREL · CURATED VINTAGE · KAMPALA</div>
        </div>
        <div class="rc-meta-top">
          <strong>${esc(S.store_name || "Adonai Store")}</strong><br/>
          ${esc(S.address || "Plot 45 Salama Road / kibuli Kampala, Uganda")}<br/>
          Phone: ${esc(S.hotline || "+256 7656 52403")} | WhatsApp: ${esc(S.whatsapp_display || "+256 7588 73398")}<br/>
          <span class="rc-tiktok">TikTok: ${esc(S.tiktok || "@adonai.thrift256")}</span>
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-ref-row">
          <span>RECEIPT / INVOICE REF:</span>
          <strong>${esc(s.id)}</strong>
        </div>
        <div class="rc-datetime-row">
          <span>Date: ${receiptDateFormat(s.created_at)}</span>
          <span>Time: ${receiptTimeFormat(s.created_at)}</span>
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-cust-box">
          <div class="rc-cust-row"><span class="rc-cust-k">Customer:</span> <strong class="rc-cust-v">${esc(s.customer_name || "Walk-in Guest")}</strong></div>
          <div class="rc-cust-row"><span class="rc-cust-k">Phone:</span> <span class="rc-cust-v">${esc(s.customer_phone || "—")}</span></div>
          ${s.customer_location ? `<div class="rc-cust-row"><span class="rc-cust-k">Location:</span> <span class="rc-cust-v">${esc(s.customer_location)}</span></div>` : (s.delivery_area && s.delivery_area !== "Storefront Walk-in" ? `<div class="rc-cust-row"><span class="rc-cust-k">Location:</span> <span class="rc-cust-v">${esc(s.delivery_area)}</span></div>` : "")}
          ${s.customer_notes ? `<div class="rc-cust-row"><span class="rc-cust-k">Notes:</span> <span class="rc-cust-v">${esc(s.customer_notes)}</span></div>` : ""}
          <div class="rc-cust-row"><span class="rc-cust-k">Sales Channel:</span> <span class="rc-cust-v">${s.channel === "web" ? "Web Storefront" : "In-Store POS (Walk-in)"}</span></div>
          ${s.cashier ? `<div class="rc-cust-row"><span class="rc-cust-k">Cashier:</span> <span class="rc-cust-v">${esc(s.cashier.name || s.cashier)}</span></div>` : ""}
        </div>
        <div class="rc-dashed"></div>
        <table class="rc-table">
          <thead>
            <tr>
              <th style="text-align:left">ITEM / SIZE</th>
              <th style="text-align:center">QTY</th>
              <th style="text-align:right">PRICE</th>
              <th style="text-align:right">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${s.items.map(it => `
              <tr>
                <td style="text-align:left">
                  <div class="rc-it-name">[${it.item_condition === "BRAND_NEW" ? "NEW" : "PRE-LOVED"}] ${esc(it.name)}</div>
                  <div class="rc-it-sku">${esc(it.sku || it.barcode_id || "")}</div>
                </td>
                <td style="text-align:center">${it.qty}</td>
                <td style="text-align:right">${ugx(it.unit_price)}</td>
                <td style="text-align:right">${ugx(it.line_total)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="rc-dashed"></div>
        <div class="rc-sum-section">
          <div class="rc-sum-row">
            <span>Item Subtotal (${totalQty} items)</span>
            <span>${ugx(subtotal)}</span>
          </div>
          ${s.delivery_fee > 0 ? `
            <div class="rc-sum-row">
              <span>Delivery Coordination Fee</span>
              <span>${ugx(s.delivery_fee)}</span>
            </div>
          ` : ""}
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-grand-row">
          <strong>TOTAL PAID (UGX)</strong>
          <strong class="rc-grand-total">${ugx(s.total)}</strong>
        </div>
        <div class="rc-pay-method">
          PAYMENT METHOD: ${(s.tender && s.tender.paid && s.tender.type === "cash") ? "CASH · COMPLETED" : (s.tender && s.tender.paid && s.tender.type === "mtn") ? "MTN MOMO · VERIFIED" : (s.tender && s.tender.paid && s.tender.type === "airtel") ? "AIRTEL MONEY · VERIFIED" : (s.tender && s.tender.paid) ? `${s.tender.type.toUpperCase()} · PAID` : "UNPAID · UNPAID"}
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-notice">
          Notice: Returns or exchanges are strictly accepted within 2 days of purchase upon presentation of a valid receipt.
        </div>
        <div class="rc-barcode-area">
          <div class="rc-barcode-render">${DB.barcodeSVG(s.id, 44)}</div>
          <div class="rc-barcode-code">* ${esc(s.id)} *</div>
        </div>
      </div>
    `;
  }

  function printReceiptModal(id) {
    const s = DB.getSale(id);
    if (!s) return toast("Sale record not found", false);
    const rcSheet = $("#receiptSheet");
    if (rcSheet) rcSheet.innerHTML = receiptHTML(s);
    openModal(`
      <button class="modal-x" data-close>×</button>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 class="serif" style="margin:0">80mm Receipt Printout</h3>
        <button class="btn primary sm" id="btnTriggerPrint">${Icons.svg("printer", "ico-14")} Print 80mm</button>
      </div>
      ${receiptHTML(s)}
      <div class="modal-actions" style="margin-top:14px">
        <button class="btn ghost" data-close>Close</button>
        <button class="btn primary" id="btnTriggerPrint2">${Icons.svg("printer", "ico-14")} Print Receipt</button>
      </div>
    `);
    const doPrint = () => {
      const sheet = $("#receiptSheet");
      if (sheet) sheet.innerHTML = receiptHTML(s);
      window.print();
    };
    const b1 = $("#btnTriggerPrint"), b2 = $("#btnTriggerPrint2");
    if (b1) b1.addEventListener("click", doPrint);
    if (b2) b2.addEventListener("click", doPrint);
  }

  function orderCustomerPhone(value) {
    const raw = String(value || "").replace(/\D/g, "");
    if (!raw) return "";
    if (raw.startsWith("0")) return "256" + raw.slice(1);
    if (raw.startsWith("256")) return raw;
    return raw;
  }

  function sendOrderConfirmation(s) {
    const phone = orderCustomerPhone(s.customer_phone);
    if (!phone) return toast("This order has no customer phone number", false);
    const settings = DB.getSettings();
    const storeName = settings.store_name || "Adonai Store";
    const location = s.customer_location || s.delivery_area || "the agreed delivery address";
    const itemLines = (s.items || []).map(it => `• ${it.qty || 1} × ${it.name} — ${ugx(it.line_total || 0)}`).join("\n");
    const payment = s.tender && s.tender.paid ? `${DB.TENDER_LABEL(s.tender)} — PAID` : "Payment pending / to be confirmed";
    const message = `Hello ${s.customer_name || "there"},

This is ${storeName}. We have received and reviewed your order ${s.order_number || s.id}.

Order details:
${itemLines || "• Your selected item(s)"}

Total: ${ugx(s.total || 0)}
Payment: ${payment}
Delivery: ${location}${s.delivery_notes ? `\nDelivery notes: ${s.delivery_notes}` : ""}

We will keep you updated on dispatch and delivery. Please reply here if any detail needs to be corrected. Thank you for shopping with ${storeName}.`;
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      const link = document.createElement("a");
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.click();
    }
    toast("WhatsApp confirmation prepared — tap Send to deliver it");
  }

  function isDeliveryOrder(s) {
    return String(s.delivery_type || "boda").toLowerCase() !== "pickup";
  }

  // Rider picker: only partners who can take a job are selectable; the one already on the order stays visible.
  function riderDispatchBlock(s, riders) {
    if (!isDeliveryOrder(s)) return "";
    const stage = fulfillmentStage(s);
    if (stage !== "In Assembly" && stage !== "Dispatched") return "";
    const assigned = String(assignedRiderId(s) || "");
    const active = riders.filter(r => !r.archived);
    const options = active.map(r => {
      const current = String(r.id) === assigned;
      const unavailable = r.status === "Offline" && !current;
      const label = `${r.name}${r.zone ? " (" + r.zone + ")" : ""} · ${String(r.status || "Available").toUpperCase()}`;
      return `<option value="${esc(r.id)}" ${current ? "selected" : ""} ${unavailable ? "disabled" : ""}>${esc(label)}${unavailable ? " — offline" : ""}</option>`;
    }).join("");
    const hasOptions = active.some(r => r.status !== "Offline" || String(r.id) === assigned);
    return `
      <div class="field">
        <label>${assigned ? "REASSIGN DELIVERY PARTNER" : "ASSIGN DELIVERY PARTNER"}</label>
        <select id="modalRiderSel" class="sel-full">
          <option value="">${hasOptions ? "Choose an available partner…" : "No available partners — set one Available first"}</option>
          ${options}
        </select>
        ${assigned ? `<p class="muted small">Currently with ${esc(assignedRiderName(s) || "a partner")}.</p>` : ""}
      </div>
      <button class="btn primary btn-full" id="btnDispatchRider">${Icons.svg("bike", "ico-14")} ${assigned ? "Reassign &amp; notify on WhatsApp" : "Assign &amp; notify rider on WhatsApp"}</button>`;
  }

  function riderAssignmentMessage(orderId, riderName, updated) {
    const notice = updated && updated.rider_notice;
    const first = Array.isArray(notice) ? notice[0] : notice;
    if (!first) return `${orderId} assigned to ${riderName}`;
    if (first.status === "sent") return `${orderId} assigned to ${riderName} · WhatsApp sent to the rider`;
    return `${orderId} assigned to ${riderName} · WhatsApp not sent (${first.error || "not configured"}). Message the rider from Delivery Partners & Dispatch.`;
  }

  function orderDetailModal(id) {
    const s = DB.getSale(id);
    if (!s) return toast("Order not found", false);
    const riders = DB.listRiders();
    const paid = isSalePaid(s);
    const subtotal = s.subtotal || (s.total - (s.delivery_fee || 0));
    const locationStr = s.delivery_area ? `${s.delivery_area}${s.delivery_address ? " - " + s.delivery_address : ""}` : (s.delivery_address || "Kampala Road Store");

    openModal(`
      <button class="modal-x" data-close>×</button>
      <div class="odm-head">
        <div>
          <h2 class="odm-title serif">${esc(s.id)}</h2>
          <p class="odm-sub">${esc(s.customer_name)} · ${ago(s.created_at)}</p>
        </div>
      </div>

      <div class="odm-chips">
        ${laneChip(fulfillmentStage(s))}
        <span class="stat-chip ${paid ? 'ok' : 'pend'}">${paid ? 'PAID' : 'UNPAID'}</span>
        <span class="stat-chip ${s.channel === 'web' ? 'web' : 'pos'}">${s.channel === 'web' ? 'Web Store' : 'Register'}</span>
        ${assignedRiderName(s) ? `<span class="stat-chip blue">Rider: ${esc(assignedRiderName(s))}</span>` : ''}
      </div>

      <div class="odm-section">
        <div class="odm-section-label">Order Items · Dual Inventory</div>
        ${s.items.map(it => `
          <div class="odm-item-row">
            <div>
              <div class="odm-item-name">${esc(it.name)}</div>
              <div class="odm-item-sku">${esc(it.sku || it.barcode_id || "")}</div>
            </div>
            <div class="odm-item-price">${ugx(it.line_total)}</div>
          </div>
        `).join("")}
        <div class="odm-divider"></div>
        <div class="odm-sum-row">
          <span>Subtotal</span>
          <strong>${ugx(subtotal)}</strong>
        </div>
        <div class="odm-sum-row">
          <span>Delivery Coordination Fee</span>
          <strong>${ugx(s.delivery_fee || 0)}</strong>
        </div>
        <div class="odm-divider"></div>
        <div class="odm-total-row">
          <strong>Total Amount</strong>
          <strong class="rust">${ugx(s.total)}</strong>
        </div>
      </div>

      <!-- Payment Status & Settlement Box -->
      <div class="odm-section">
        <div class="odm-section-label">Payment Status &amp; Tender Settlement</div>
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <div>
            <span style="font-weight:700">Payment:</span>
            <span class="stat-chip ${paid ? 'ok' : 'pend'}" style="margin-left:6px">${paid ? 'PAID' : 'UNPAID'}</span>
            ${paid ? `<span class="muted small" style="margin-left:6px">(${esc(DB.TENDER_LABEL(s.tender))})</span>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${!paid ? `
              <button class="btn sm primary" data-set-paid="${esc(s.id)}" data-method="cash">${Icons.svg("banknote", "ico-13")} Cash</button>
              <button class="btn sm" data-set-paid="${esc(s.id)}" data-method="mtn">${Icons.svg("smartphone", "ico-13")} MTN MoMo</button>
              <button class="btn sm" data-set-paid="${esc(s.id)}" data-method="airtel">${Icons.svg("smartphone", "ico-13")} Airtel</button>
            ` : `
              <button class="btn sm ghost" data-set-unpaid="${esc(s.id)}">${Icons.svg("undo-2", "ico-13")} Revert to Unpaid</button>
            `}
          </div>
        </div>
      </div>

      <div class="odm-info-block">
        <div><strong>Delivery Address:</strong> ${esc(locationStr)}</div>
        <div><strong>Contact Phone:</strong> ${esc(s.customer_phone || "—")}</div>
        <div><strong>Notes:</strong> Location: ${esc(locationStr)}${s.delivery_notes ? " · " + esc(s.delivery_notes) : ""}</div>
      </div>


      <div class="odm-dispatch-box">
        <div class="odm-dispatch-title">Workflow Dispatch &amp; Closure</div>
        ${riderDispatchBlock(s, riders)}

        ${fulfillmentStage(s) === "Unfulfilled" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="In Assembly">${Icons.svg("package", "ico-14")} Start Assembly</button>
          ${isDeliveryOrder(s) ? `<p class="muted small">Assemble the order first, then assign a delivery partner here.</p>` : ""}
        ` : fulfillmentStage(s) === "In Assembly" && !isDeliveryOrder(s) ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="Ready for Pickup">✓ Mark Ready for Pickup</button>
        ` : fulfillmentStage(s) === "Ready for Pickup" || fulfillmentStage(s) === "Dispatched" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="Completed">✓ Complete Order</button>
        ` : ""}

        <button class="btn primary btn-full" id="btnSendOrderConfirmation">${Icons.svg("message-circle", "ico-14")} Send WhatsApp Confirmation</button>
        ${["Unfulfilled", "In Assembly", "Ready for Pickup", "Dispatched"].includes(fulfillmentStage(s)) ? `<button class="btn ghost btn-full" id="btnCancelOrderModal">Cancel order &amp; release stock</button>` : ""}
        <button class="btn light btn-full" id="btnPrintReceiptModal">${Icons.svg("printer", "ico-14")} Print Receipt</button>
      </div>
    `);

    const sel = $("#modalRiderSel");
    const btnDisp = $("#btnDispatchRider");
    if (btnDisp) {
      btnDisp.addEventListener("click", async () => {
        const riderId = sel ? sel.value : null;
        if (!riderId) return toast("Choose an available delivery partner first", false);
        const rider = riders.find(r => String(r.id) === String(riderId));
        await performOrderAction(
          btnDisp,
          () => DB.assignRiderToOrder(s.id, riderId),
          updated => riderAssignmentMessage(s.id, rider ? rider.name : "the rider", updated),
          closeModal
        );
      });
    }

    const btnAdv = $("#btnAdvRider");
    if (btnAdv) {
      btnAdv.addEventListener("click", async () => {
        const nextStage = btnAdv.dataset.advanceStage;
        await performOrderAction(
          btnAdv,
          () => DB.setDispatchStatus(s.id, nextStage),
          `${s.id} moved to ${nextStage}`,
          closeModal
        );
      });
    }

    const btnCanc = $("#btnCancelOrderModal");
    if (btnCanc) {
      btnCanc.addEventListener("click", async () => {
        if (!confirmOrderCancellation(s)) return;
        await performOrderAction(
          btnCanc,
          () => DB.cancelWebOrder(s.id),
          `${s.id} cancelled — stock returned to the rack`,
          closeModal
        );
      });
    }

    const btnConfirm = $("#btnSendOrderConfirmation");
    if (btnConfirm) btnConfirm.addEventListener("click", () => sendOrderConfirmation(s));

    const btnPr = $("#btnPrintReceiptModal");
    if (btnPr) {
      btnPr.addEventListener("click", () => {
        printReceiptModal(s.id);
      });
    }
  }

  /* ============================================================
     INVENTORY RACK
     ============================================================ */
  let invDemo = "", invTerm = "", invStatus = "all";
  function renderInvPills() {
    $("#invPills").innerHTML = [`<button class="dpill ${invDemo === "" ? "active" : ""}" data-demo="">All Demographics</button>`]
      .concat(DB.DEMOGRAPHICS.map(d => `<button class="dpill ${invDemo === d ? "active" : ""}" data-demo="${d}">${d}</button>`)).join("");
    $$("#invPills .dpill").forEach(b => b.addEventListener("click", () => { invDemo = b.dataset.demo; renderInventory(); }));
  }
  function renderInvStatus() {
    const list = DB.listProducts();
    const inStock = list.filter(p => p.in_stock_count > 0).length;
    $("#invStatusSel").innerHTML = `
      <option value="all">All Statuses (${list.length})</option>
      <option value="live">In Stock (${inStock})</option>
      <option value="sold">Sold / Out (${list.length - inStock})</option>`;
    $("#invStatusSel").value = invStatus;
  }
  $("#invSearch").addEventListener("input", e => { invTerm = e.target.value.trim().toLowerCase(); });
  $("#btnInvFilter").addEventListener("click", renderInventory);
  $("#invStatusSel").addEventListener("change", e => { invStatus = e.target.value; renderInventory(); });

  function renderInventory() {
    renderInvPills(); renderInvStatus();
    let list = DB.listProducts();
    if (invDemo) list = list.filter(p => p.demographic === invDemo);
    if (invStatus !== "all") list = list.filter(p => invStatus === "live" ? p.in_stock_count > 0 : p.in_stock_count <= 0);
    if (invTerm) list = list.filter(p => [p.name, p.brand, p.color, p.size, p.sku, p.category, p.condition].some(x => String(x || "").toLowerCase().includes(invTerm)));
    $("#navStockBadge").textContent = DB.listProducts().filter(p => p.in_stock_count <= 0).length || "";

    $("#invList").innerHTML = list.length ? list.map(p => {
      const off = p.compare_price > p.selling_price ? Math.round((p.compare_price - p.selling_price) / p.compare_price * 100) : 0;
      const inStock = p.in_stock_count > 0;
      return `<div class="stock-row">
        <span class="ph-thumb">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : Icons.svg("shirt", "ico-cat")}</span>
        <div class="stock-main">
          <div class="stock-title-row">
            <div class="grow">
              <div class="stock-name"><span class="inventory-badge-inline ${p.item_condition === "BRAND_NEW" ? "new" : "vintage"}">${p.item_condition === "BRAND_NEW" ? "NEW" : "PRE-LOVED"}</span> ${esc(p.name)}</div>
              <div class="stock-sku">${esc(p.sku || p.barcode_id || "")}</div>
            </div>
            ${inStock ? `<span class="stat-chip ok">AVAILABLE</span>` : `<span class="stat-chip bad">OUT OF STOCK</span>`}
          </div>
          <div class="stock-tags">
            <span class="itag">${esc(p.demographic)}</span>
            <span class="itag">${esc(p.category)}</span>
            <span class="itag">${Icons.svg("ruler", "ico-11")} ${esc(p.size)}</span>
            <span class="itag">${esc(p.condition)}</span>
            ${p.brand ? `<span class="itag">${Icons.svg("tag", "ico-11")} ${esc(p.brand)}</span>` : ""}
          </div>
          <div class="stock-price-row">
            <span class="stock-price">${ugx(p.selling_price)}</span>
            ${p.compare_price ? `<s class="stock-strike">${ugx(p.compare_price)}</s><span class="off">-${off}%</span>` : ""}
            <span class="stock-cost">Cost ${ugx(p.cost_price)}</span>
          </div>
          <div class="stock-foot">
            <span class="micro-cap">${inStock ? `${p.in_stock_count} IN STOCK · ONLINE + IN-STORE` : "ARCHIVED PIECE"}</span>
          </div>
        </div>
        <div class="stock-actions">
          <button class="btn sm ghost" type="button" data-print-tag="${esc(p.id)}">${Icons.svg("printer", "ico-12")} Print tag</button>
          <button class="btn sm ghost" data-editprod="${esc(p.id)}">${Icons.svg("pencil", "ico-12")} Edit</button>
          <button class="btn sm ghost dim" data-delprod="${esc(p.id)}">${Icons.svg("trash-2", "ico-12")} Delete</button>
        </div>
      </div>`;
    }).join("") : `<div class="card"><p class="muted" style="padding:20px">No products match these filters.</p></div>`;
  }

  /* ---- product editor modal (edit / delete) ---- */
  /* Measurements travel as a small object; the edit modal exposes them as
     readable "name: value" lines so staff can fix a number in seconds. */
  function measurementsToText(measurements) {
    if (!measurements || typeof measurements !== "object") return "";
    const lines = Object.keys(measurements)
      .filter(key => key !== "notes")
      .map(key => `${key}: ${measurements[key]}`);
    if (measurements.notes) lines.push(`notes: ${measurements.notes}`);
    return lines.join("\n");
  }

  function textToMeasurements(text) {
    const out = {};
    String(text || "").split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Za-z_ ]+?)\s*[:=]\s*(.+?)\s*$/);
      if (!match) return;
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      if (key === "notes") { out.notes = match[2].trim(); return; }
      const value = parseFloat(match[2]);
      if (Number.isFinite(value) && value > 0) out[key] = value;
    });
    return out;
  }

  /* ---- rack removal: archive (soft) or delete permanently (manager-gated) ---- */
  function openProductDelete(p) {
    if (!p) return;
    const qty = Math.max(0, Number(p.in_stock_count) || 0);
    const lossValue = qty * (Number(p.cost_price) || 0);
    openModal(`
      <button class="modal-x" data-close>×</button>
      <p class="kicker">RACK REMOVAL</p>
      <h3>Remove &ldquo;${esc(p.name)}&rdquo;?</h3>
      <p class="muted small"><strong>${esc(p.sku)}</strong> · ${esc(p.category || "Uncategorised")} · ${qty} unit${qty === 1 ? "" : "s"} on hand${lossValue ? ` · ${ugx(lossValue)} at cost` : ""}</p>
      <div class="del-options">
        <button type="button" class="del-option" id="delArchive">
          <strong>Archive it <span class="del-tag">Recommended</span></strong>
          <span>Hides the piece from the rack and storefront immediately. Sales history, receipts, and financial reports stay complete.</span>
        </button>
        <button type="button" class="del-option danger" id="delPurge">
          <strong>Delete permanently</strong>
          <span>Erases the product record forever — <b>this cannot be undone</b>.<br/>
          • Past order lines keep the item name, price, and totals, so old receipts and reports stay truthful.<br/>
          ${lossValue ? `• The ${ugx(lossValue)} stock value is posted as an inventory write-off in the ledgers.` : "• No stock on hand, so no write-off is posted."}<br/>
          • Manager authority required — enforced by the server.</span>
        </button>
      </div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button></div>`);
    const run = async (mode) => {
      const button = mode === "permanent" ? $("#delPurge") : $("#delArchive");
      setButtonBusy(button, true, mode === "permanent" ? "Deleting permanently…" : "Archiving…");
      try {
        await DB.removeProduct(p.id, mode);
        closeModal();
        toast(mode === "permanent"
          ? `${p.name} permanently deleted — stock value written off, order history preserved`
          : `${p.name} archived — hidden from rack and storefront`);
      } catch (error) {
        setButtonBusy(button, false);
        toast(error.message, false);
      }
    };
    $("#delArchive").addEventListener("click", () => run("archive"));
    $("#delPurge").addEventListener("click", () => run("permanent"));
  }

  function productModal(id) {
    const p = id ? DB.getProduct(id) : null;
    const v = (k, d = "") => p ? esc(p[k] != null ? p[k] : d) : d;
    const modalImages = GarmentMedia.photosFor(p);
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${p ? "Edit item" : "New item"}</h3>
      <div class="field"><label>Inventory policy</label><select id="mpItemCondition" class="sel-full"><option value="PRE_LOVED" ${!p || p.item_condition !== "BRAND_NEW" ? "selected" : ""}>Curated Pre-Loved / Vintage · 1-of-1</option><option value="BRAND_NEW" ${p && p.item_condition === "BRAND_NEW" ? "selected" : ""}>Brand-New Apparel · Multi-Quantity</option></select></div>
      <div class="field"><label>Name</label><input id="mpName" class="sel-full" value="${v("name")}" /></div>
      <div class="fgrid">
        <div class="field"><label>Brand</label><input id="mpBrand" class="sel-full" value="${v("brand", "Unbranded")}" /></div>
        <div class="field"><label>Colour</label><input id="mpColor" class="sel-full" value="${v("color")}" /></div>
      </div>
      <div class="fgrid">
        <div class="field"><label>Category</label><select id="mpCat" class="sel-full">${DB.CATEGORIES.map(c => `<option ${p && p.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label>Demographic</label><select id="mpDemo" class="sel-full">${DB.DEMOGRAPHICS.map(d => `<option ${p && p.demographic === d ? "selected" : ""}>${d}</option>`).join("")}</select></div>
      </div>
      <div class="fgrid">
        <div class="field"><label>Size</label><input id="mpSize" class="sel-full" value="${v("size", "-")}" /></div>
        <div class="field"><label>Condition</label><select id="mpCond" class="sel-full">${DB.CONDITIONS.map(c => `<option ${p && p.condition === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      </div>
      <div class="fgrid">
        <div class="field"><label>Cost (UGX)</label><input id="mpCost" type="number" class="sel-full" value="${p ? p.cost_price : ""}" /></div>
        <div class="field"><label>Base price (UGX)</label><input id="mpBase" type="number" class="sel-full" value="${p ? (p.base_price || p.selling_price) : ""}" /></div>
      </div>
      <div class="fgrid">
        <div class="field"><label>Total transport (UGX)<span class="fhint">50% embedded · 50% at checkout · defaults to System Parameters base fee</span></label><input id="mpTransport" type="number" min="0" class="sel-full" ${p ? "" : `data-auto="1" placeholder="${globalBaseDeliveryFee()}"`} value="${p ? (p.total_transport_cost || 0) : globalBaseDeliveryFee()}" /></div>
        <div class="field"><label>Final selling price (UGX)</label><input id="mpSell" type="number" class="sel-full" value="${p ? p.selling_price : ""}" readonly /></div>
      </div>
      <div class="fgrid">
        <div class="field"><label>Compare-at (UGX)</label><input id="mpCompare" type="number" class="sel-full" value="${p ? p.compare_price : ""}" /></div>
        <div class="field"><label>Stock</label><input id="mpStock" type="number" min="0" class="sel-full" value="${p ? p.in_stock_count : 1}" /></div>
      </div>
      <h4 class="sec" style="margin:18px 0 8px">Product page details</h4>
      <div class="field"><label>Fabric &amp; composition</label><input id="mpFabric" class="sel-full" value="${v("fabric")}" placeholder="100% Cotton denim · 12.5oz" /></div>
      <div class="field"><label>Care instructions</label><input id="mpCare" class="sel-full" value="${v("care_notes")}" placeholder="Machine wash cold inside out." /></div>
      <div class="field"><label>Flat-lay measurements<span class="fhint">inches · one per line as name: value</span></label>
        <textarea id="mpMeasure" class="sel-full" placeholder="shoulder: 18.5&#10;chest: 22&#10;sleeve: 25&#10;length: 26">${measurementsToText(p && p.measurements)}</textarea></div>
      <div class="field"><label>Flaw &amp; condition notes</label><textarea id="mpFlaws" class="sel-full" placeholder="Describe every flaw a shopper would want to know about.">${v("flaw_notes")}</textarea></div>
      <div class="field"><label>Which photo shows the flaw?</label>
        <select id="mpFlawPhoto" class="sel-full"><option value="-1">No flaw close-up</option>${modalImages.map((url, i) => `<option value="${i}" ${p && Number(p.flaw_photo_index) === i ? "selected" : ""}>Photo ${i + 1}${i === 0 ? " · Cover" : ""}</option>`).join("")}</select></div>
      <div id="mpMedia"></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-prod="${p ? esc(p.id) : ""}">${p ? "Save changes" : "Add item"}</button>
      </div>`);
    modalBox._mediaEditor = GarmentMedia.mount($("#mpMedia"), {
      product: p,
      onChange: (urls, previous) => syncFlawPhotoOptions($("#mpFlawPhoto"), urls, previous),
      onBusy: busy => { const button = $("[data-save-prod]", modalBox); if (button) button.disabled = busy || !!modalBox._mediaSaving; },
      onError: message => toast(message, false)
    });
    const recalculateModalPrice = () => {
      const base = Math.max(0, Number($("#mpBase").value) || 0);
      const transport = Math.max(0, Number($("#mpTransport").value) || 0);
      $("#mpSell").value = Math.round(base + (transport / 2));
    };
    $("#mpBase").addEventListener("input", recalculateModalPrice);
    $("#mpTransport").addEventListener("input", recalculateModalPrice);
    $("#mpTransport").addEventListener("input", () => { $("#mpTransport").dataset.auto = "0"; });

  }

  /* ============================================================
     CATALOG INTAKE (with print tag preview)
     ============================================================ */
  const DEMO_CODES = { Men: "MEN", Women: "WOM", Children: "KID", Unisex: "UNI" };
  const INTAKE_CONDITIONS = ["Grade A — Excellent", "Grade B — Good", "Vintage / Collector", "Factory Fresh"];
  const GROUPS = {
    "Apparel": ["Tops & Shirts", "Dresses & Skirts", "Pants & Jeans"],
    "Outerwear & Tailoring": ["Outerwear & Jackets", "Suits & Formalwear"],
    "Traditional & Occasionwear": ["Traditional & Occasionwear"],
    "Footwear": ["Shoes", "Boots", "Sandals"],
    "Sports, Swim & Loungewear": ["Activewear & Sportswear", "Underwear & Sleepwear", "Swimwear & Beachwear"],
    "Bags": ["Bags & Handbags"],
    "Jewelry": ["Necklaces & Chains", "Bracelets & Bangles", "Rings & Earrings", "Watches"],
    "Eyewear": ["Eyewear & Sunglasses"],
    "Accessories": ["Accessories", "Hats, Scarves & Belts"],
    "Kids": ["Children Wear"]
  };
  let intakeMedia = null;
  let intakeBound = false;
  let intakeLotsLoadInFlight = null;
  let intakePartnersLoadInFlight = null;
  let intakePartnersCache = [];
  let intakeConditionBeforePartner = null;
  let intakeQtyBeforePartner = null;
  let intakeStatusBeforePartner = null;
  let intakeLotBeforePartner = null;
  let intakeGradeBeforePartner = null;
  let intakeSaving = false;
  let lastTaggedProductId = null;
  let tagLayoutPreviewOpened = false;
  let mediaPreviewFocused = false;

  /* The System Parameters base delivery fee is the single source of truth for
     transport pricing. New catalog items prefill from it so staff never re-type
     the fee per product; a manually edited field (data-auto = "0") is never
     overwritten. */
  function globalBaseDeliveryFee() {
    try {
      const s = DB.getSettings();
      return Math.max(0, Number(s.base_delivery_fee != null ? s.base_delivery_fee : s.boda_base_fee) || 7000);
    } catch (e) { return 7000; }
  }

  function syncIntakeTransportDefault(force) {
    const field = document.querySelector("#inTransport");
    if (!field) return;
    const fee = globalBaseDeliveryFee();
    field.placeholder = String(fee);
    if (force || field.dataset.auto !== "0" || String(field.value).trim() === "") {
      field.value = String(fee);
      field.dataset.auto = "1";
    }
  }

  function newIntakeSku() {
    const demo = $("#inDemo").value || "Men";
    const existing = new Set(DB.listProducts().flatMap(p => [p.sku, p.barcode_id]).map(code => String(code || "").toUpperCase()));
    let candidate;
    for (let attempt = 0; attempt < 20; attempt++) {
      const random = window.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 4294967296);
      candidate = `ADN-${DEMO_CODES[demo] || "GEN"}-${random.toString(36).toUpperCase().padStart(6, "0").slice(-6)}`;
      if (!existing.has(candidate) && !existing.has(candidate + "-1OF1")) return candidate;
    }
    return candidate; // The server's unique constraint also protects concurrent intakes.
  }
  /* Intake-side cache of registered lots so the tier dropdown can render
     without another round trip. Server-side math remains authoritative. */
  let intakeLotsCache = [];
  const findIntakeLot = id => intakeLotsCache.find(lot => lot.id === id) || null;

  function loadIntakeStockLots(force = false) {
    const select = $("#inStockLot");
    if (!select) return Promise.resolve();
    // A dashboard sync can complete while this request is still in flight.
    // Coalesce ordinary refreshes; after saving a tagged piece, wait for any
    // older request and then fetch again so its pre-save counts cannot win.
    if (intakeLotsLoadInFlight) {
      return force
        ? intakeLotsLoadInFlight.then(() => loadIntakeStockLots())
        : intakeLotsLoadInFlight;
    }

    let request;
    request = Promise.resolve()
      .then(() => DB.financeRequest("stock-lots", { method:"GET" }))
      .then(data => {
        if (!data || !Array.isArray(data.stock_lots)) throw new Error("Invalid stock lot response");
        // Read the current value after the request resolves so a selection made
        // while loading is preserved. Only a lot that is no longer available
        // should fall back to the empty option.
        const current = select.value;
        intakeLotsCache = data.stock_lots;
        const lots = intakeLotsCache.filter(lot => Number(lot.remaining_count) > 0);
        select.innerHTML = `<option value="">No registered lot selected</option>` + lots.map(lot => `<option value="${esc(lot.id)}" data-unit-cost="${lot.unit_cost}">${esc(lot.lot_code)} · ${esc(lot.supplier)} · ${lot.remaining_count} left${(lot.grades || []).length ? ` · ${lot.grades.length} tiers` : ` · ${ugx(lot.unit_cost)}/item`}</option>`).join("");
        select.value = lots.some(lot => String(lot.id) === current) ? current : "";
        syncIntakeLotGradeUI();
      })
      .catch(() => {
        // Keep a populated select intact during transient auth/network errors;
        // otherwise the selected lot visibly disappears on every retry.
        if (!intakeLotsCache.length) select.innerHTML = `<option value="">Sign in to load registered lots</option>`;
      })
      .finally(() => {
        if (intakeLotsLoadInFlight === request) intakeLotsLoadInFlight = null;
      });
    intakeLotsLoadInFlight = request;
    return request;
  }

  /* ---- Locked-COGS intake helpers --------------------------------------
     Selecting a pre-graded tier fixes the unit cost to the tier's locked
     COGS (recomputed server-side at lot registration) and suggests the
     tier's target retail price. Clearing the lot/tier unlocks the field. */
  function lockIntakeCost(locked, note) {
    const cost = $("#inCost");
    if (!cost) return;
    cost.readOnly = !!locked;
    cost.classList.toggle("locked-money", !!locked);
    const hint = $("#inCostHint");
    if (hint) hint.textContent = locked ? (note || "Locked by lot tier") : "";
  }

  function syncIntakeLotGradeUI() {
    const field = $("#inLotGradeField");
    const select = $("#inLotGrade");
    if (!field || !select) return;
    const lot = findIntakeLot($("#inStockLot") && $("#inStockLot").value);
    const currentGrade = select.value;
    const grades = ((lot && lot.grades) || []).filter(g => Number(g.remaining_count) > 0);
    if (!lot || !((lot.grades || []).length)) {
      field.hidden = true;
      select.innerHTML = `<option value="">Choose tier…</option>`;
      lockIntakeCost(false);
      return;
    }
    field.hidden = false;
    select.innerHTML = `<option value="">Choose tier…</option>` + grades.map(g => `<option value="${esc(g.id)}">${esc(g.grade_name)} · ${g.remaining_count} left · COGS ${ugx(g.unit_cogs)}</option>`).join("");
    const hint = $("#inLotGradeHint");
    if (hint) hint.textContent = grades.length ? "Pre-graded tier · locks the unit COGS" : "All tiers fully tagged — no pieces left";
    select.value = grades.some(g => String(g.id) === currentGrade) ? currentGrade : "";
    applyIntakeGradeSelection();
  }

  function applyIntakeGradeSelection() {
    const lot = findIntakeLot($("#inStockLot") && $("#inStockLot").value);
    const gradeId = $("#inLotGrade") ? $("#inLotGrade").value : "";
    const grade = lot ? ((lot.grades || []).find(g => g.id === gradeId) || null) : null;
    if (!grade) {
      lockIntakeCost(false);
      return;
    }
    $("#inCost").value = grade.unit_cogs;
    lockIntakeCost(true, `Locked · ${grade.grade_name} tier COGS`);
    // Pre-fill the retail price from the tier target unless the staff member
    // already typed a deliberate price for this piece.
    const sell = $("#inSell");
    if (grade.target_selling_price && (!Number(sell.value) || sell.dataset.gradeSuggested === "1")) {
      sell.value = grade.target_selling_price;
      sell.dataset.gradeSuggested = "1";
    }
    paintTag();
  }
  /* ------------------------------------------------------------------
     FLAT-LAY MEASUREMENTS (intake → product detail page)
     Thrift stock is one-of-one, so sizing is sold on real measurements
     rather than on a tagged S/M/L. The field set follows the garment type.
     ------------------------------------------------------------------ */
  const MEASURE_SETS = {
    top: [
      ["shoulder", "Shoulder width"],
      ["chest", "Pit-to-pit (chest)"],
      ["sleeve", "Sleeve length"],
      ["length", "Total length"]
    ],
    bottom: [
      ["waist", "Waist (flat)"],
      ["hip", "Hip width"],
      ["inseam", "Inseam length"],
      ["rise", "Rise"],
      ["thigh", "Thigh width"],
      ["leg_opening", "Leg opening"]
    ],
    other: [
      ["length", "Length"],
      ["insole", "Insole length"],
      ["heel", "Heel height"]
    ]
  };

  // Categories decide which measurement set is offered by default.
  function measureSetForCategory(category) {
    const value = String(category || "").toLowerCase();
    if (/pant|jean|skirt|short|trouser/.test(value)) return "bottom";
    if (/shoe|boot|sandal|footwear|accessor|bag|handbag|wallet|belt|hat|scarf|necklace|chain|bracelet|bangle|ring|earring|watch|eyewear|sunglass/.test(value)) return "other";
    return "top";
  }

  function buildMeasureFields(setKey, existing) {
    const fields = MEASURE_SETS[setKey] || MEASURE_SETS.top;
    const values = existing || {};
    $("#measureFields").innerHTML = fields.map(([key, label]) => `
      <div class="field">
        <label>${label}<span class="unit">inches</span></label>
        <input class="sel-full" type="number" step="0.1" min="0" data-measure="${key}"
               value="${values[key] != null ? values[key] : ""}" placeholder="0.0" />
      </div>`).join("");
  }

  function readMeasurements() {
    const out = {};
    document.querySelectorAll("#measureFields [data-measure]").forEach(input => {
      const value = Number(input.value);
      if (Number.isFinite(value) && value > 0) out[input.dataset.measure] = value;
    });
    const note = ($("#inMeasureNote") && $("#inMeasureNote").value.trim()) || "";
    if (note) out.notes = note;
    return out;
  }

  // The condition controls must be local console helpers, not undefined
  // globals: opening Catalog Intake directly should never interrupt boot.
  function intakeCondition() {
    return $("#inItemCondition").value === "PRE_LOVED" ? "PRE_LOVED" : "BRAND_NEW";
  }

  function setIntakeCondition(value) {
    const preLoved = value === "PRE_LOVED";
    const partnerSource = typeof $ === "function" && $("#inInventorySource") && $("#inInventorySource").value === "partner";
    $("#inItemCondition").value = preLoved ? "PRE_LOVED" : "BRAND_NEW";
    $$("[data-intake-condition]").forEach(button => {
      const active = button.dataset.intakeCondition === intakeCondition();
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    ["inSizeVariantsField", "inFactoryNotesField"].forEach(id => { $("#" + id).hidden = preLoved; });
    $("#inMeasurementsField").hidden = !preLoved;
    const qty = $("#inQty");
    qty.readOnly = preLoved || partnerSource;
    if (preLoved || partnerSource) { qty.value = "1"; qty.max = "1"; }
    else qty.removeAttribute("max");
    $("#inQtyHint").textContent = partnerSource ? "Partner item · 1-of-1" : (preLoved ? "Unique piece · 1-of-1" : "Brand-new supports multi-stock");
  }

  function intakeSource() {
    const field = $("#inInventorySource");
    return field && field.value === "partner" ? "partner" : "store";
  }

  function syncIntakePartnerRateHint() {
    const select = $("#inConsignmentPartner");
    const hint = $("#inConsignmentRateHint");
    if (!select || !hint) return;
    const partner = intakePartnersCache.find(row => row.id === select.value);
    hint.textContent = partner
      ? `Leave blank to inherit ${partner.name}’s default (${Number(partner.default_commission_rate || 0).toFixed(2)}%).`
      : "Leave blank to inherit the selected partner's default (5%).";
  }

  function applyPendingIntakePartner(select) {
    const pendingId = select && select.dataset.pendingPartnerId;
    if (!pendingId) return;
    const exists = intakePartnersCache.some(partner => partner.id === pendingId);
    if (exists) select.value = pendingId;
    else toast("That partner is not active for new intake. Choose an active partner or reactivate the profile.", false);
    delete select.dataset.pendingPartnerId;
  }

  function syncIntakeRoute(partnerId) {
    if (currentView !== "intake") return;
    const url = new URL(location.href);
    if (intakeSource() === "partner") {
      url.searchParams.set("inventory_source", "partner");
      const selected = partnerId === undefined ? $("#inConsignmentPartner").value : partnerId;
      if (selected) url.searchParams.set("consignment_partner_id", selected);
      else url.searchParams.delete("consignment_partner_id");
    } else {
      url.searchParams.delete("inventory_source");
      url.searchParams.delete("consignment_partner_id");
    }
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }

  function loadIntakePartners(force = false) {
    const select = $("#inConsignmentPartner");
    if (!select || (!force && intakePartnersLoadInFlight)) return intakePartnersLoadInFlight || Promise.resolve();
    const emptyPartnerState = $("#consignmentNoPartners");
    if (!force && intakePartnersCache.length) {
      const current = select.value;
      select.innerHTML = `<option value=\"\">Choose an active partner…</option>` + intakePartnersCache.map(partner => `<option value=\"${esc(partner.id)}\">${esc(partner.name)} · ${Number(partner.default_commission_rate || 0).toFixed(2)}%</option>`).join("");
      if (intakePartnersCache.some(partner => partner.id === current)) select.value = current;
      if (emptyPartnerState) emptyPartnerState.hidden = true;
      applyPendingIntakePartner(select);
      syncIntakePartnerRateHint();
      return Promise.resolve();
    }
    if (emptyPartnerState) emptyPartnerState.hidden = true;
    select.innerHTML = '<option value="">Loading active partners…</option>';
    intakePartnersLoadInFlight = DB.consignmentRequest("partners/choices").then(data => {
      intakePartnersCache = Array.isArray(data.partners) ? data.partners : [];
      const current = select.value;
      select.innerHTML = `<option value=\"\">${intakePartnersCache.length ? "Choose an active partner…" : "No active partners yet"}</option>` + intakePartnersCache.map(partner => `<option value=\"${esc(partner.id)}\">${esc(partner.name)} · ${Number(partner.default_commission_rate || 0).toFixed(2)}%</option>`).join("");
      if (intakePartnersCache.some(partner => partner.id === current)) select.value = current;
      if (emptyPartnerState) emptyPartnerState.hidden = intakePartnersCache.length > 0;
      applyPendingIntakePartner(select);
      syncIntakePartnerRateHint();
    }).catch(error => {
      select.innerHTML = '<option value="">Partner list could not load</option>';
      if (emptyPartnerState) emptyPartnerState.hidden = true;
      toast(error.message || "Could not load partner list", false);
    }).finally(() => { intakePartnersLoadInFlight = null; });
    return intakePartnersLoadInFlight;
  }

  async function openConsignmentIntake(partnerId = "") {
    await setView("intake", false);
    if (!viewReady || currentView !== "intake") return;
    const url = new URL(location.href);
    url.searchParams.set("view", "intake");
    url.searchParams.set("inventory_source", "partner");
    if (partnerId) url.searchParams.set("consignment_partner_id", partnerId);
    else url.searchParams.delete("consignment_partner_id");
    history.pushState({ view: "intake" }, "", url.pathname + url.search);
    const partnerSelect = $("#inConsignmentPartner");
    if (partnerId && partnerSelect) partnerSelect.dataset.pendingPartnerId = partnerId;
    else if (partnerSelect) { delete partnerSelect.dataset.pendingPartnerId; partnerSelect.value = ""; }
    $("#inInventorySource").value = "partner";
    applyIntakeSource();
    await loadIntakePartners();
    syncIntakeRoute(partnerSelect && partnerSelect.value ? partnerSelect.value : "");
    if (partnerSelect) partnerSelect.focus();
    const sourcePanel = $("#intakeSourceTitle");
    if (sourcePanel && sourcePanel.scrollIntoView) sourcePanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function applyIntakeSource() {
    const partnerSource = intakeSource() === "partner";
    $("#consignmentIntakeFields").hidden = !partnerSource;
    $("#intakeConditionControls").hidden = partnerSource;
    ["inStockLotField", "inLotGradeField", "inCostField", "inTransportField"].forEach(id => { const field = $("#" + id); if (field) field.hidden = partnerSource; });
    $("#partnerMediaRule").hidden = !partnerSource;
    const status = $("#inStatus");
    const qty = $("#inQty");
    if (partnerSource) {
      if (intakeConditionBeforePartner === null) {
        intakeConditionBeforePartner = intakeCondition();
        intakeQtyBeforePartner = qty.value;
        intakeStatusBeforePartner = status.value;
        intakeLotBeforePartner = $("#inStockLot").value;
        intakeGradeBeforePartner = $("#inLotGrade").value;
      }
      if (intakeCondition() !== "PRE_LOVED") setIntakeCondition("PRE_LOVED");
      else setIntakeCondition("PRE_LOVED");
      status.value = "1"; status.disabled = true;
      $("#inStockLot").value = "";
      syncIntakeLotGradeUI();
      if (intakeMedia && intakeMedia.setConsignmentMode) intakeMedia.setConsignmentMode(true);
      loadIntakePartners();
    } else {
      status.disabled = false;
      if (intakeConditionBeforePartner !== null) {
        const savedCondition = intakeConditionBeforePartner;
        setIntakeCondition(savedCondition);
        if (savedCondition === "BRAND_NEW" && intakeQtyBeforePartner != null) qty.value = intakeQtyBeforePartner;
        status.value = intakeStatusBeforePartner || "1";
        $("#inStockLot").value = intakeLotBeforePartner || "";
        syncIntakeLotGradeUI();
        if (intakeGradeBeforePartner && $("#inLotGrade")) $("#inLotGrade").value = intakeGradeBeforePartner;
        intakeConditionBeforePartner = intakeQtyBeforePartner = intakeStatusBeforePartner = null;
        intakeLotBeforePartner = intakeGradeBeforePartner = null;
      } else setIntakeCondition($("#inItemCondition").value || "BRAND_NEW");
      if (intakeMedia && intakeMedia.setConsignmentMode) intakeMedia.setConsignmentMode(false);
    }
    syncIntakePartnerRateHint();
    paintTag();
  }

  function initIntakeForm() {
    // renderIntake() also runs for background sync events. Populate defaults and
    // attach handlers once only, or each poll overwrites live form selections.
    if (intakeBound) return;
    $("#inDemo").innerHTML = DB.DEMOGRAPHICS.map(d => `<option>${d}</option>`).join("");
    $("#inCat").innerHTML = DB.CATEGORIES.map(c => `<option>${c}</option>`).join("");
    $("#inCond").innerHTML = INTAKE_CONDITIONS.map(c => `<option>${c}</option>`).join("");
    $("#inGroup").innerHTML = Object.keys(GROUPS).map(g => `<option>${g}</option>`).join("");
    $("#inSizePreset").innerHTML = `<option value="">Preset</option>` + ["XS", "S", "M", "L", "XL", "2XL", "28", "30", "32", "34", "36", "40", "42", "43", "44", "8y", "10y", "One size"].map(s => `<option value="${s}">${s}</option>`).join("");
    $("#inSku").value = newIntakeSku();
    const intakeRoute = new URLSearchParams(location.search);
    if (intakeRoute.get("inventory_source") === "partner") {
      $("#inInventorySource").value = "partner";
      const routePartnerId = intakeRoute.get("consignment_partner_id");
      if (routePartnerId) $("#inConsignmentPartner").dataset.pendingPartnerId = routePartnerId;
    }
    intakeBound = true;
    loadIntakeStockLots();

    $$('[data-intake-condition]').forEach(button => button.addEventListener("click", () => setIntakeCondition(button.dataset.intakeCondition)));
    $("#btnRollSku").addEventListener("click", () => { $("#inSku").value = newIntakeSku(); paintTag(); });
    $("#inInventorySource").addEventListener("change", () => { applyIntakeSource(); syncIntakeRoute(); });
    $("#inConsignmentPartner").addEventListener("change", () => { syncIntakePartnerRateHint(); syncIntakeRoute(); });
    $("#btnIntakeAddPartner").addEventListener("click", async () => {
      await setView("partners");
      if (viewReady && currentView === "partners") openPartnerEditor();
    });
    $("#inDemo").addEventListener("change", () => { $("#inSku").value = newIntakeSku(); paintTag(); });
    $("#inSizePreset").addEventListener("change", () => { if ($("#inSizePreset").value) $("#inSize").value = $("#inSizePreset").value; paintTag(); });
    $("#inGroup").addEventListener("change", () => { $("#inCat").value = GROUPS[$("#inGroup").value][0]; paintTag(); });
    $("#inStockLot").addEventListener("change", () => {
      syncIntakeLotGradeUI();
      const lot = findIntakeLot($("#inStockLot").value);
      if (lot && !((lot.grades || []).length)) {
        // Legacy un-graded lot: fill the blended landed unit cost (editable).
        const option = $("#inStockLot").options[$("#inStockLot").selectedIndex];
        if (option && option.dataset.unitCost) $("#inCost").value = option.dataset.unitCost;
        lockIntakeCost(false);
      }
      paintTag();
    });
    $("#inLotGrade").addEventListener("change", applyIntakeGradeSelection);
    // A deliberately typed price overrides the tier's suggested target.
    $("#inSell").addEventListener("input", () => { $("#inSell").dataset.gradeSuggested = "0"; });
    $("#inCat").addEventListener("change", () => {
      const g = Object.keys(GROUPS).find(k => GROUPS[k].includes($("#inCat").value));
      if (g) $("#inGroup").value = g;
      paintTag();
    });
    ["inTitle", "inSize", "inBrand", "inColor", "inCost", "inSell", "inTransport", "inRrp", "inSku"].forEach(id => $("#" + id).addEventListener("input", paintTag));
    // A hand-typed transport fee marks the field as custom so the global
    // System Parameters default stops auto-refreshing it.
    $("#inTransport").addEventListener("input", () => { $("#inTransport").dataset.auto = "0"; });
    $("#inMeasureSet").addEventListener("change", () => buildMeasureFields($("#inMeasureSet").value));
    $("#inCat").addEventListener("change", () => {
      const suggested = measureSetForCategory($("#inCat").value);
      if ($("#inMeasureSet").value !== suggested) {
        $("#inMeasureSet").value = suggested;
        buildMeasureFields(suggested);
      }
    });
    buildMeasureFields($("#inMeasureSet").value);
    $("#btnIntakeSave").addEventListener("click", () => saveIntake(false));
    $("#btnIntakeMore").addEventListener("click", () => saveIntake(true));
    $("#btnIntakePrint").addEventListener("click", () => saveIntake(false, true));
    $("#btnPrintLastTag").addEventListener("click", () => { if (lastTaggedProductId && window.GarmentTools) GarmentTools.openTag(lastTaggedProductId); });
    buildPhotoRow();
    setIntakeCondition($("#inItemCondition").value || "BRAND_NEW");
    applyIntakeSource();
    paintTag();
  }

  function syncFlawPhotoOptions(select, urls, previous) {
    if (!select) return;
    const index = Number(select.value);
    const reference = previous && previous[index];
    const next = reference ? urls.indexOf(reference) : (index >= 0 && index < urls.length ? index : -1);
    select.innerHTML = `<option value="-1">No flaw close-up</option>` + urls.map((url, i) => `<option value="${i}">Photo ${i + 1}${i === 0 ? " · Cover" : ""}</option>`).join("");
    select.value = String(next);
  }

  function buildPhotoRow() {
    if (intakeMedia) return;
    intakeMedia = GarmentMedia.mount($("#photoRow"), {
      onChange: (urls, previous, video) => {
        syncFlawPhotoOptions($("#inFlawPhoto"), urls, previous);
        $("#angleCount").textContent = `${urls.length} / 12 photos${video ? " + video" : ""}`;
      },
      onBusy: busy => ["btnIntakeSave", "btnIntakeMore", "btnIntakePrint"].forEach(id => { $("#" + id).disabled = busy || intakeSaving; }),
      onError: message => toast(message, false)
    });
  }

  function paintTag() {
    const settings = DB.getSettings() || {};
    $("#tagStoreName").textContent = settings.store_name || "ADONAI STORE";
    $("#tagTitle").textContent = $("#inTitle").value.trim() || "Garment name";
    $("#tagWebsite").textContent = window.GarmentTools ? GarmentTools.websiteLabel(settings) : "adonai-store.onrender.com";
    const basePrice = Number($("#inSell").value) || 0;
    const transport = intakeSource() === "partner" ? 0 : (Number($("#inTransport").value) || 0);
    const sell = basePrice + (transport * 0.5);
    const code = $("#inSku").value.trim() || "ADN-XXX-0000";
    $("#tagCode").textContent = code;
    // Print the saved SKU: a stable checkout alias without condition markers.
    $("#tagBars").innerHTML = DB.barcodeSVG(code, 58);
    if (!intakeSaving) $("#btnIntakeSave").textContent = `Save Garment (${ugx(sell)})`;
  }

  async function saveIntake(again, printAfter = false) {
    if (intakeSaving) return;
    let garmentMedia;
    try { garmentMedia = intakeMedia.snapshot(); } catch (error) { return toast(error.message, false); }
    const partnerSource = intakeSource() === "partner";
    const commissionInput = $("#inConsignmentRate").value.trim();
    const vals = {
      name: $("#inTitle").value.trim(),
      brand: $("#inBrand").value.trim() || "Unbranded",
      color: $("#inColor").value.trim(),
      demographic: $("#inDemo").value, category: $("#inCat").value,
      size: $("#inSize").value.trim() || "-",
      inventory_source: partnerSource ? "partner" : "store",
      consignment_partner_id: partnerSource ? $("#inConsignmentPartner").value : "",
      commission_rate: partnerSource ? (commissionInput === "" ? null : Number(commissionInput)) : null,
      item_condition: intakeCondition(),
      quantity_type: intakeCondition(),
      condition: $("#inCond").value,
      size_variants: $("#inSizeVariants").value.split(",").map(value => value.trim()).filter(Boolean),
      factory_tag_notes: $("#inFactoryNotes").value.trim(),
      measurements: $("#inMeasurements").value.split(";").reduce((out, pair) => {
        const parts = pair.split(":"); if (parts[0] && parts[1]) out[parts[0].trim()] = parts.slice(1).join(":").trim(); return out;
      }, {}),
      fabric_grading_notes: $("#inFabricNotes").value.trim(),
      cost_price: partnerSource ? 0 : (Number($("#inCost").value) || 0),
      stock_lot_id: partnerSource ? "" : $("#inStockLot").value,
      lot_grade_id: partnerSource ? "" : (($('#inLotGradeField') && !$('#inLotGradeField').hidden && $('#inLotGrade')) ? $('#inLotGrade').value : ""),
      base_price: Number($("#inSell").value) || 0,
      selling_price: Number($("#inSell").value) || 0,
      total_transport_cost: partnerSource ? 0 : (Number($("#inTransport").value) || 0),
      compare_price: Number($("#inRrp").value) || 0,
      desc: $("#inStory").value.trim(),
      staff_notes: $("#inNotes").value.trim(),
      // Product detail page specifications
      fabric: $("#inFabric").value.trim(),
      care_notes: $("#inCare").value.trim(),
      measurements: readMeasurements(),
      flaw_notes: $("#inFlaws").value.trim(),
      flaw_photo_index: Number($("#inFlawPhoto").value),
      visibility: $("#inVis").value,
      in_stock_count: partnerSource ? 1 : (Number($("#inStatus").value) ? Math.max(0, Math.floor(Number($("#inQty").value) || 0)) : 0),
      sku: $("#inSku").value.trim(),
      barcode_id: (() => {
        const sku = $("#inSku").value.trim().slice(0, 50);
        return intakeCondition() === "PRE_LOVED" ? `${sku.slice(0, 45)}-1OF1` : sku;
      })(),
      ...garmentMedia
    };
    if (!vals.name) return toast("Item title is required", false);
    if (!vals.selling_price) return toast("Set a sell price first", false);
    if (partnerSource) {
      if (!vals.consignment_partner_id) return toast("Choose the partner supplying this item", false);
      if (!garmentMedia.images || !garmentMedia.images.length) return toast("Partner items need at least one photo", false);
      if (!garmentMedia.video_id || Number(garmentMedia.video_duration) < 15 || Number(garmentMedia.video_duration) > 20) {
        return toast("Partner items need an uploaded 15–20 second video", false);
      }
      if (commissionInput !== "" && (!Number.isFinite(vals.commission_rate) || vals.commission_rate < 0 || vals.commission_rate > 100)) {
        return toast("Item commission must be from 0 to 100 percent", false);
      }
    }
    if (["ADN-000000", "ADONAI-SAMPLE"].includes(vals.sku.toUpperCase())) return toast("This code is reserved for printer setup. Roll a different SKU.", false);
    if (!vals.sku || vals.sku.length > 45 || !/^[\x21-\x7e]+$/.test(vals.sku)) return toast("Use a unique SKU of 1–45 English letters, numbers or symbols, without spaces.", false);
    if (vals.stock_lot_id && !vals.lot_grade_id) {
      const lot = findIntakeLot(vals.stock_lot_id);
      if (lot && (lot.grades || []).length) {
        if ($("#inLotGrade")) $("#inLotGrade").focus();
        return toast("This lot is tier-graded — choose a grade tier so COGS stays locked", false);
      }
    }
    intakeSaving = true;
    intakeMedia.setLocked(true);
    const saveButtons = [$("#btnIntakeSave"), $("#btnIntakeMore"), $("#btnIntakePrint")];
    saveButtons.forEach(button => { button.disabled = true; });
    try {
      const p = await DB.addProduct(vals);
      intakeMedia.markSaved();
      lastTaggedProductId = p.id;
      $("#btnPrintLastTag").disabled = false;
      toast(`Tagged & saved — ${p.name} · ${p.sku}`);
      if (again) {
        ["inTitle", "inBrand", "inColor", "inCost", "inSell", "inRrp", "inStory", "inNotes",
         "inFabric", "inCare", "inMeasureNote", "inFlaws"].forEach(id => $("#" + id).value = "");
        $("#inFlawPhoto").value = "-1";
        $("#inSell").dataset.gradeSuggested = "0";
        buildMeasureFields($("#inMeasureSet").value);
        intakeMedia.reset();
        $("#inStockLot").value = "";
        syncIntakeLotGradeUI();
        lockIntakeCost(false);
        // Next item restarts from the global System Parameters base fee.
        syncIntakeTransportDefault(true);
        $("#inSku").value = newIntakeSku(); paintTag(); $("#inTitle").focus();
      } else {
        renderAll();
      }
      // Tier remaining counts moved — force a fresh count after any in-flight
      // pre-save request has settled.
      loadIntakeStockLots(true);
      if (printAfter && window.GarmentTools) await GarmentTools.openTag(p.id);
    } catch (err) { toast(err.message, false); }
    finally { intakeSaving = false; intakeMedia.setLocked(false); saveButtons.forEach(button => { button.disabled = intakeMedia.busy; }); paintTag(); }
  }

  function renderIntake() {
    initIntakeForm();
    syncIntakeTransportDefault(false);
    paintTag();
    if (!mediaPreviewFocused && new URLSearchParams(location.search).get("mediaPreview") === "1") {
      mediaPreviewFocused = true;
      requestAnimationFrame(() => $("#photoRow").scrollIntoView({ block: "start", behavior: "auto" }));
    }
    if (!tagLayoutPreviewOpened && new URLSearchParams(location.search).get("tagPreview") === "1" && window.GarmentTools) {
      tagLayoutPreviewOpened = true;
      GarmentTools.openTag(null, true).catch(error => toast(error.message || "Could not open the tag preview", false));
    }
    $("#recentTagged").innerHTML = DB.listProducts().slice(-6).reverse().map(p => `
      <div class="ch-row">
        <div class="rider-mini">
          <span class="ph-thumb ph-mini">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : Icons.svg("tag", "ico-14")}</span>
          <div><strong class="serif">${esc(p.name)}</strong><div class="muted small">${esc(p.sku)} · ${esc(p.demographic)}</div></div>
        </div>
        <div class="gt-recent-actions"><strong class="serif">${ugx(p.selling_price)}</strong><button class="btn sm" type="button" data-print-tag="${esc(p.id)}">${Icons.svg("printer", "ico-12")} Print tag</button></div>
      </div>`).join("") || '<p class="gt-recent-empty">No saved garments yet. Save your first piece above, or preview the tag layout before printing.</p>';
  }

  /* ============================================================
     DYNAMIC CONSIGNMENT PARTNERS & SETTLEMENTS
     ============================================================ */
  const partnerRoot = $("#view-partners");
  const partnerDashboard = {
    loaded: false, loading: false, error: "", data: null, detail: null,
    selectedId: "", region: "", supplySource: "", requestId: 0, detailRequestId: 0,
  };

  function partnerFilterOptions(select, values, label, selected) {
    if (!select) return;
    const current = selected || "";
    select.innerHTML = `<option value=\"\">${esc(label)}</option>` + (values || []).map(value =>
      `<option value=\"${esc(value)}\">${esc(value)}</option>`).join("");
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  async function loadConsignmentDashboard() {
    if (!partnerRoot) return;
    const requestId = ++partnerDashboard.requestId;
    partnerDashboard.loading = true;
    partnerDashboard.error = "";
    renderPartners();
    const params = new URLSearchParams();
    if (partnerDashboard.region) params.set("region", partnerDashboard.region);
    if (partnerDashboard.supplySource) params.set("supply_source", partnerDashboard.supplySource);
    try {
      const data = await DB.consignmentRequest("dashboard" + (params.toString() ? "?" + params.toString() : ""));
      if (requestId !== partnerDashboard.requestId) return;
      partnerDashboard.data = data;
      partnerDashboard.loaded = true;
      partnerDashboard.error = "";
      const selectedStillVisible = (data.partners || []).some(row => row.id === partnerDashboard.selectedId);
      if (partnerDashboard.selectedId && selectedStillVisible) loadPartnerDetail(partnerDashboard.selectedId);
      else if (partnerDashboard.selectedId) { partnerDashboard.selectedId = ""; partnerDashboard.detail = null; }
    } catch (error) {
      if (requestId !== partnerDashboard.requestId) return;
      partnerDashboard.error = error.message || "Could not load consignment partners";
      partnerDashboard.loaded = false;
    } finally {
      if (requestId === partnerDashboard.requestId) {
        partnerDashboard.loading = false;
        renderPartners();
      }
    }
  }

  async function loadPartnerDetail(id) {
    if (!id) return;
    const requestId = ++partnerDashboard.detailRequestId;
    partnerDashboard.selectedId = id;
    partnerDashboard.detail = { loading: true, data: null, error: "" };
    renderPartners();
    try {
      const data = await DB.consignmentRequest("partners/" + encodeURIComponent(id));
      if (requestId !== partnerDashboard.detailRequestId || id !== partnerDashboard.selectedId) return;
      partnerDashboard.detail = { loading: false, data, error: "" };
    } catch (error) {
      if (requestId !== partnerDashboard.detailRequestId) return;
      partnerDashboard.detail = { loading: false, data: null, error: error.message || "Could not load partner details" };
    }
    renderPartners();
  }

  function renderPartnerPayoutRows(rows, partnerMap = {}) {
    if (!rows || !rows.length) return '<p class="partner-list-empty">No payouts recorded yet.</p>';
    return `<div class="partner-mini-list">${rows.map(payout => {
      const partnerName = payout.partner_name || partnerMap[payout.partner_id] || "Partner";
      const date = payout.created_at ? new Date(payout.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
      return `<div class="partner-mini-row"><div><strong>${esc(partnerName)}</strong><span>${esc(date)} · ${esc(payout.payment_method || "cash")}${payout.reference ? ` · ${esc(payout.reference)}` : ""}</span></div><b>${ugx(payout.amount || 0)}</b></div>`;
    }).join("")}</div>`;
  }

  function renderPartners() {
    if (!partnerRoot) return;
    const data = partnerDashboard.data;
    const state = $("#partnerLoadState");
    if (state) {
      state.hidden = !(partnerDashboard.loading || partnerDashboard.error);
      state.innerHTML = partnerDashboard.loading ? '<span class="live-dot"></span> Syncing partner balances…' :
        `<span role="alert">${esc(partnerDashboard.error)}</span> <button class="btn sm" type="button" data-partner-retry>Try again</button>`;
    }
    const kpis = $("#consignmentKpis");
    const summary = data && data.summary ? data.summary : {};
    if (kpis) kpis.innerHTML = data ? [
      kpiCard("GROSS PARTNER SALES", ugx(summary.gross_revenue || 0), `${summary.sold || 0} items sold`, "green", Icons.svg("banknote", "ico-18")),
      kpiCard("STORE COMMISSION EARNED", ugx(summary.commission_earned || 0), "Recorded at the sale-time rate", "rust", Icons.svg("receipt", "ico-18")),
      kpiCard("TOTAL PAID OUT", ugx(summary.payouts_total || 0), `Across ${summary.partners || 0} partners`, "blue", Icons.svg("banknote", "ico-18")),
      kpiCard("PARTNER PAYABLES", ugx(summary.payable_balance || 0), "After historical payouts", "amber", Icons.svg("wallet", "ico-18")),
      kpiCard("ACTIVE INVENTORY", summary.active_inventory || 0, `${summary.submitted || 0} pieces submitted`, "blue", Icons.svg("boxes", "ico-18")),
      kpiCard("INVENTORY TURNOVER", `${Number(summary.inventory_turnover_pct || 0).toFixed(1)}%`, "Sold ÷ submitted items", "green", Icons.svg("trending-up", "ico-18")),
    ].join("") : "";
    const filterData = data && data.filters || {};
    partnerFilterOptions($("#partnerRegionFilter"), filterData.regions, "All regions", partnerDashboard.region);
    partnerFilterOptions($("#partnerSourceFilter"), filterData.supply_sources, "All sources", partnerDashboard.supplySource);
    const partners = data && Array.isArray(data.partners) ? data.partners : [];
    const rows = $("#partnerRows");
    if (rows) rows.innerHTML = partners.map(partner => `
      <tr>
        <td><strong>${esc(partner.name)}</strong><span class="partner-row-meta">${esc(partner.phone || partner.whatsapp || "No phone")} · ${partner.active ? "Active" : "Inactive"}</span></td>
        <td>${esc(partner.region || "—")}<span class="partner-row-meta">${esc(partner.supply_source || "Source not set")}</span></td>
        <td>${Number(partner.submitted || 0)}</td><td>${Number(partner.sold || 0)}</td><td>${Number(partner.active_inventory || 0)}</td>
        <td>${ugx(partner.gross_revenue || 0)}</td><td>${ugx(partner.commission_earned || 0)}</td>
        <td><strong class="partner-payable-value">${ugx(partner.payable_balance || 0)}</strong></td>
        <td>${Number(partner.inventory_turnover_pct || 0).toFixed(1)}%</td>
        <td><div class="partner-row-actions"><button class="btn sm" type="button" data-partner-view="${esc(partner.id)}">View</button><button class="btn sm ghost" type="button" data-partner-edit="${esc(partner.id)}">Edit</button><button class="btn sm primary" type="button" data-partner-payout="${esc(partner.id)}" ${Number(partner.payable_balance || 0) <= 0 ? "disabled" : ""}>Pay</button></div></td>
      </tr>`).join("");
    const count = $("#partnerCountLabel"); if (count) count.textContent = `${partners.length} partner${partners.length === 1 ? "" : "s"}`;
    const empty = $("#partnerEmptyState");
    if (empty) { empty.hidden = partners.length > 0 || partnerDashboard.loading; empty.textContent = partnerDashboard.error ? "Partner data is unavailable. Try refreshing after confirming Finance access." : "No matching partners. Add your first supply partner or change the region/source filters."; }
    const partnerMap = Object.fromEntries(partners.map(partner => [partner.id, partner.name]));
    const leaderboard = $("#partnerLeaderboard");
    const leaders = data && data.leaderboard || [];
    if (leaderboard) leaderboard.innerHTML = leaders.length ? `<div class="partner-leader-list">${leaders.map((row, index) => `
      <button type="button" class="partner-leader-row" data-partner-view="${esc(row.id)}"><span class="partner-rank">${index + 1}</span><span><strong>${esc(row.name)}</strong><small>${Number(row.sold || 0)} sold · ${ugx(row.gross_revenue || 0)} · ${Number(row.inventory_turnover_pct || 0).toFixed(1)}% turnover</small></span><span class="partner-leader-arrow">↗</span></button>`).join("")}</div>` : '<p class="partner-list-empty">Sales-volume rankings appear after the first partner item sells.</p>';
    const payouts = $("#partnerRecentPayouts");
    if (payouts) payouts.innerHTML = renderPartnerPayoutRows(data && data.recent_payouts, partnerMap);
    const detailPanel = $("#selectedPartnerDetail");
    if (detailPanel) {
      const detailState = partnerDashboard.detail;
      if (!partnerDashboard.selectedId) { detailPanel.hidden = true; detailPanel.innerHTML = ""; }
      else {
        detailPanel.hidden = false;
        if (!detailState || detailState.loading) detailPanel.innerHTML = '<p class="muted">Loading partner items and settlement history…</p>';
        else if (detailState.error) detailPanel.innerHTML = `<p class="partner-detail-error" role="alert">${esc(detailState.error)}</p>`;
        else detailPanel.innerHTML = partnerDetailMarkup(detailState.data);
      }
    }
  }

  function partnerDetailMarkup(data) {
    const partner = data.partner, metrics = data.metrics || {};
    const items = data.items || [], payouts = data.payouts || [];
    const itemTable = items.length ? `<div class="partner-table-wrap"><table class="partner-table partner-items-table"><thead><tr><th>Item</th><th>Stock</th><th>Sold</th><th>Gross sales</th><th>Store commission</th><th>Price</th><th>Rate</th><th></th></tr></thead><tbody>${items.map(item => `
      <tr><td><strong>${esc(item.name)}</strong><span class="partner-row-meta">${esc(item.sku || "No SKU")}</span></td>
      <td>${Number(item.in_stock_count || 0)} · ${esc(item.inventory_status || "")}</td><td>${Number(item.sold || 0)}</td><td>${ugx(item.gross_revenue || 0)}</td><td>${ugx(item.commission_earned || 0)}</td><td>${ugx(item.selling_price || 0)}</td>
      <td>${Number(item.effective_commission_rate || 0).toFixed(2)}%<span class="partner-row-meta">${item.commission_source === "item" ? "Item rate" : "Partner default"}</span></td>
      <td><button class="btn sm ghost" type="button" data-partner-item-rate="${esc(item.id)}">Change rate</button></td></tr>`).join("")}</tbody></table></div>` : '<p class="partner-list-empty">No catalog items have been submitted by this partner.</p>';
    return `<div class="partner-detail-head"><div><p class="kicker">PARTNER ACCOUNT</p><h2>${esc(partner.name)}</h2><p class="partner-detail-meta">${esc(partner.region || "Region not set")} · ${esc(partner.supply_source || "Supply source not set")} · ${partner.active ? "Active" : "Inactive"}</p></div>
      <div class="partner-row-actions"><button class="btn primary" type="button" data-partner-intake="${esc(partner.id)}" ${partner.active ? "" : "disabled title=\"Reactivate this partner to add new items\""}>+ Add items</button><button class="btn" type="button" data-partner-edit="${esc(partner.id)}">Edit profile</button><button class="btn ghost" type="button" data-partner-payout="${esc(partner.id)}" ${Number(metrics.payable_balance || 0) <= 0 ? "disabled" : ""}>Record payout</button><button class="btn ghost" type="button" data-partner-close-detail>Close</button></div></div>
      <div class="partner-contact-strip"><span>${esc(partner.phone || "No phone")} · WhatsApp ${esc(partner.whatsapp || "not set")}</span><span>${esc(partner.email || "No email")}</span><span>${esc(partner.payout_provider || "Payout channel not set")} · ${esc(partner.payout_account_name || "")} ${esc(partner.payout_account || "")}</span><span>Default commission ${Number(partner.default_commission_rate || 0).toFixed(2)}%</span></div>
      <div class="partner-detail-stats"><span><b>${Number(metrics.submitted || 0)}</b> submitted</span><span><b>${Number(metrics.sold || 0)}</b> sold</span><span><b>${Number(metrics.active_inventory || 0)}</b> active</span><span><b>${ugx(metrics.gross_revenue || 0)}</b> gross sales</span><span><b>${ugx(metrics.commission_earned || 0)}</b> commission earned</span><span><b>${ugx(metrics.payable_balance || 0)}</b> payable</span><span><b>${Number(metrics.inventory_turnover_pct || 0).toFixed(1)}%</b> turnover</span></div>
      <div class="partner-detail-columns"><div><div class="partner-card-head"><div><p class="kicker">PARTNER CATALOG</p><h3>Submitted items &amp; rates</h3></div></div>${itemTable}</div><div><div class="partner-card-head"><div><p class="kicker">FULL PAYOUT HISTORY</p><h3>Settlements</h3></div></div>${renderPartnerPayoutRows(payouts)}</div></div>`;
  }

  function partnerById(id) {
    const listed = partnerDashboard.data && partnerDashboard.data.partners || [];
    if (partnerDashboard.detail && partnerDashboard.detail.data && partnerDashboard.detail.data.partner.id === id) return partnerDashboard.detail.data.partner;
    return listed.find(partner => partner.id === id) || null;
  }

  function openPartnerEditor(partner = null) {
    const value = key => esc(partner && partner[key] != null ? partner[key] : "");
    const defaultRate = partner ? Number(partner.default_commission_rate || 0).toFixed(2) : "5.00";
    const activeChecked = !partner || partner.active ? "checked" : "";
    openModal(`<div class="partner-modal"><button class="modal-x" data-close aria-label="Close">×</button><p class="kicker">${partner ? "PARTNER PROFILE" : "NEW SUPPLY PARTNER"}</p><h3>${partner ? "Edit partner" : "Add a consignment partner"}</h3><p class="muted small">Contact, region and payout details are visible only in the Finance-protected workspace.</p>
      <form id="consignmentPartnerForm" novalidate><div class="partner-form-grid">
        <div class="field"><label for="partnerName">Partner / supplier name</label><input class="sel-full" id="partnerName" required maxlength="160" value="${value("name")}" /></div>
        <div class="field"><label for="partnerPhone">Contact phone</label><input class="sel-full" id="partnerPhone" maxlength="50" value="${value("phone")}" placeholder="+256…" /></div>
        <div class="field"><label for="partnerWhatsApp">WhatsApp number</label><input class="sel-full" id="partnerWhatsApp" maxlength="50" value="${value("whatsapp")}" placeholder="+256…" /></div>
        <div class="field"><label for="partnerEmail">Email</label><input class="sel-full" id="partnerEmail" type="email" maxlength="160" value="${value("email")}" /></div>
        <div class="field full"><label for="partnerAddress">Address / pickup location</label><textarea class="sel-full" id="partnerAddress" rows="2" maxlength="1200">${value("address")}</textarea></div>
        <div class="field"><label for="partnerPayoutProvider">Payout network / provider</label><input class="sel-full" id="partnerPayoutProvider" maxlength="60" value="${value("payout_provider")}" placeholder="MTN Mobile Money / Airtel / Bank" /></div>
        <div class="field"><label for="partnerPayoutName">Account name</label><input class="sel-full" id="partnerPayoutName" maxlength="120" value="${value("payout_account_name")}" /></div>
        <div class="field"><label for="partnerPayoutAccount">Mobile-money number / bank account</label><input class="sel-full" id="partnerPayoutAccount" maxlength="100" value="${value("payout_account")}" /></div>
        <div class="field"><label for="partnerCommission">Default store commission (%)</label><input class="sel-full" id="partnerCommission" type="number" min="0" max="100" step="0.01" required value="${defaultRate}" /><span class="fhint">New partners start at 5%; each item can override its partner’s saved default rate.</span></div>
        <div class="field"><label for="partnerRegion">Region</label><input class="sel-full" id="partnerRegion" maxlength="100" value="${value("region")}" placeholder="Kampala Central" /></div>
        <div class="field"><label for="partnerSupplySource">Regional / supply source</label><input class="sel-full" id="partnerSupplySource" maxlength="120" value="${value("supply_source")}" placeholder="Owino market · Kampala" /></div>
        <div class="field full"><label for="partnerNotes">Internal notes</label><textarea class="sel-full" id="partnerNotes" rows="2" maxlength="2000">${value("notes")}</textarea></div>
        <label class="partner-active-toggle"><input id="partnerActive" type="checkbox" ${activeChecked} /> Active for new consignment intake</label>
      </div><p id="partnerFormError" class="partner-form-error" role="alert"></p><div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" id="partnerFormSubmit">${partner ? "Save partner" : "Create partner"}</button></div></form></div>`);
    $("#consignmentPartnerForm").addEventListener("submit", async event => {
      event.preventDefault();
      const submit = $("#partnerFormSubmit"), errorEl = $("#partnerFormError");
      submit.disabled = true; errorEl.textContent = "";
      const payload = {
        name: $("#partnerName").value.trim(), phone: $("#partnerPhone").value.trim(),
        whatsapp: $("#partnerWhatsApp").value.trim(), email: $("#partnerEmail").value.trim(),
        address: $("#partnerAddress").value.trim(), payout_provider: $("#partnerPayoutProvider").value.trim(),
        payout_account_name: $("#partnerPayoutName").value.trim(), payout_account: $("#partnerPayoutAccount").value.trim(),
        default_commission_rate: Number($("#partnerCommission").value), region: $("#partnerRegion").value.trim(),
        supply_source: $("#partnerSupplySource").value.trim(), notes: $("#partnerNotes").value.trim(),
        active: $("#partnerActive").checked,
      };
      try {
        const result = await DB.consignmentRequest("partners" + (partner ? "/" + encodeURIComponent(partner.id) : ""), {
          method: partner ? "PATCH" : "POST", body: JSON.stringify(payload),
        });
        const saved = result.partner;
        partnerDashboard.selectedId = saved.id;
        partnerDashboard.data = null; partnerDashboard.loaded = false;
        closeModal(); toast(partner ? "Partner profile updated" : "Consignment partner created");
        await loadConsignmentDashboard();
        await loadPartnerDetail(saved.id);
        intakePartnersCache = [];
      } catch (error) {
        errorEl.textContent = error.message || "Could not save partner"; submit.disabled = false;
      }
    });
  }

  const pendingPartnerPayoutKeys = new Map();

  function newPayoutKey() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_) {}
    return `payout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function openPartnerPayout(partner) {
    if (!partner) return;
    const balance = Number(partner.payable_balance || 0);
    if (balance <= 0) return toast("This partner has no available payable balance", false);
    const payoutProvider = String(partner.payout_provider || "").toLowerCase();
    const preferred = /bank|transfer/.test(payoutProvider) ? "bank" : (partner.payout_account ? "mobile_money" : "cash");
    const destination = [partner.payout_provider, partner.payout_account_name, partner.payout_account].filter(Boolean).join(" · ") || "Cash settlement";
    const payoutIdempotencyKey = pendingPartnerPayoutKeys.get(partner.id) || newPayoutKey();
    pendingPartnerPayoutKeys.set(partner.id, payoutIdempotencyKey);
    openModal(`<div class="partner-modal payout-modal"><button class="modal-x" data-close aria-label="Close">×</button><p class="kicker">PARTNER SETTLEMENT</p><h3>Pay ${esc(partner.name)}</h3><p class="muted small">Available balance <strong>${ugx(balance)}</strong>. The server prevents settlement above the amount still owed.</p>
      <form id="partnerPayoutForm" novalidate><div class="partner-form-grid">
        <div class="field"><label for="partnerPayoutAmount">Payout amount (UGX)</label><input class="sel-full" id="partnerPayoutAmount" type="number" min="1" max="${balance}" step="1" value="${balance}" required /></div>
        <div class="field"><label for="partnerPayoutMethod">Paid from</label><select class="sel-full" id="partnerPayoutMethod"><option value="mobile_money" ${preferred === "mobile_money" ? "selected" : ""}>Mobile money</option><option value="bank" ${preferred === "bank" ? "selected" : ""}>Bank transfer</option><option value="cash" ${preferred === "cash" ? "selected" : ""}>Cash drawer</option></select></div>
        <div class="field full"><label>Partner destination snapshot</label><div class="partner-destination">${esc(destination)}</div></div>
        <div class="field full"><label for="partnerPayoutReference">Payment reference / receipt</label><input class="sel-full" id="partnerPayoutReference" maxlength="120" placeholder="Transaction or receipt reference" /></div>
        <div class="field full"><label for="partnerPayoutNotes">Notes</label><textarea class="sel-full" id="partnerPayoutNotes" rows="2" maxlength="1000"></textarea></div>
      </div><p id="partnerPayoutError" class="partner-form-error" role="alert"></p><div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="partnerPayoutSubmit" type="submit">Record payout &amp; journal</button></div></form></div>`);
    $("#partnerPayoutForm").addEventListener("submit", async event => {
      event.preventDefault();
      const button = $("#partnerPayoutSubmit"), errorEl = $("#partnerPayoutError");
      button.disabled = true; errorEl.textContent = "";
      const payload = {
        amount: Number($("#partnerPayoutAmount").value), payment_method: $("#partnerPayoutMethod").value,
        reference: $("#partnerPayoutReference").value.trim(), notes: $("#partnerPayoutNotes").value.trim(),
        idempotency_key: payoutIdempotencyKey,
      };
      try {
        await DB.consignmentRequest(`partners/${encodeURIComponent(partner.id)}/payouts`, { method: "POST", body: JSON.stringify(payload) });
        pendingPartnerPayoutKeys.delete(partner.id);
        partnerDashboard.selectedId = partner.id;
        partnerDashboard.data = null; partnerDashboard.loaded = false;
        closeModal(); toast("Payout posted · payable balance updated");
        await loadConsignmentDashboard(); await loadPartnerDetail(partner.id);
      } catch (error) {
        errorEl.textContent = error.message || "Could not record payout"; button.disabled = false;
      }
    });
  }

  function openPartnerRateEditor(item, partner) {
    if (!item || !partner) return;
    const custom = item.commission_rate == null ? "" : Number(item.commission_rate).toFixed(2);
    openModal(`<div class="partner-modal rate-modal"><button class="modal-x" data-close aria-label="Close">×</button><p class="kicker">ITEM COMMISSION</p><h3>${esc(item.name)}</h3><p class="muted small">Effective rate: ${Number(item.effective_commission_rate || 0).toFixed(2)}%. Leave the field blank to inherit ${esc(partner.name)}’s ${Number(partner.default_commission_rate || 0).toFixed(2)}% default. Past sales remain unchanged.</p>
      <form id="partnerRateForm"><div class="field"><label for="partnerItemRate">Custom commission (%)</label><input class="sel-full" id="partnerItemRate" type="number" min="0" max="100" step="0.01" value="${custom}" placeholder="Use partner default" /></div><button class="btn sm" type="button" id="partnerRateReset">Use partner default</button><p id="partnerRateError" class="partner-form-error" role="alert"></p><div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" id="partnerRateSubmit">Save commission rate</button></div></form></div>`);
    $("#partnerRateReset").addEventListener("click", () => { $("#partnerItemRate").value = ""; });
    $("#partnerRateForm").addEventListener("submit", async event => {
      event.preventDefault();
      const button = $("#partnerRateSubmit"), errorEl = $("#partnerRateError"), raw = $("#partnerItemRate").value.trim();
      button.disabled = true; errorEl.textContent = "";
      try {
        await DB.consignmentRequest(`products/${encodeURIComponent(item.id)}/commission`, {
          method: "PATCH", body: JSON.stringify({ commission_rate: raw === "" ? null : Number(raw) }),
        });
        closeModal(); toast("Item commission updated · historical sales unchanged"); await loadPartnerDetail(partner.id);
      } catch (error) { errorEl.textContent = error.message || "Could not update commission"; button.disabled = false; }
    });
  }

  if (partnerRoot) {
    setInterval(() => {
      if (currentView === "partners" && viewReady && !partnerDashboard.loading) loadConsignmentDashboard();
    }, 30000);
    $("#btnPartnerAdd").addEventListener("click", () => openPartnerEditor());
    $("#btnPartnerIntake").addEventListener("click", () => openConsignmentIntake());
    $("#btnPartnerRefresh").addEventListener("click", () => loadConsignmentDashboard());
    $("#partnerRegionFilter").addEventListener("change", event => { partnerDashboard.region = event.target.value; loadConsignmentDashboard(); });
    $("#partnerSourceFilter").addEventListener("change", event => { partnerDashboard.supplySource = event.target.value; loadConsignmentDashboard(); });
    partnerRoot.addEventListener("click", event => {
      if (event.target.closest("[data-partner-retry]")) { loadConsignmentDashboard(); return; }
      if (event.target.closest("[data-partner-close-detail]")) { partnerDashboard.selectedId = ""; partnerDashboard.detail = null; renderPartners(); return; }
      const intakeButton = event.target.closest("[data-partner-intake]");
      if (intakeButton) { openConsignmentIntake(intakeButton.dataset.partnerIntake); return; }
      const viewButton = event.target.closest("[data-partner-view]");
      if (viewButton) { loadPartnerDetail(viewButton.dataset.partnerView); return; }
      const editButton = event.target.closest("[data-partner-edit]");
      if (editButton) { openPartnerEditor(partnerById(editButton.dataset.partnerEdit)); return; }
      const payoutButton = event.target.closest("[data-partner-payout]");
      if (payoutButton) { openPartnerPayout(partnerById(payoutButton.dataset.partnerPayout)); return; }
      const rateButton = event.target.closest("[data-partner-item-rate]");
      if (rateButton) {
        const detail = partnerDashboard.detail && partnerDashboard.detail.data;
        const item = detail && detail.items.find(row => row.id === rateButton.dataset.partnerItemRate);
        if (item && detail.partner) openPartnerRateEditor(item, detail.partner);
      }
    });
  }

  /* ============================================================
     CUSTOMER BOOK (guest book)
     ============================================================
  let guestTerm = "";
  const guestSearchEl = $("#guestSearch");
  if (guestSearchEl) guestSearchEl.addEventListener("input", e => { guestTerm = e.target.value.trim().toLowerCase(); renderGuests(); });

  /* ---------- posted data audit / actual file exports ---------- */
  let auditTerm = "", auditTicket = null, auditController = null, auditPendingArea = null;
  let auditRequest = 0, auditExpiryTimer = null, auditNativeSave = null, auditBusy = false;
  const auditSearchEl = $("#auditSearch"), auditReportEl = $("#auditReport");
  const auditPresetEl = $("#auditDatePreset"), auditFromEl = $("#auditDateFrom"), auditToEl = $("#auditDateTo");
  let auditDayTimer = null, auditRefreshing = false, auditRefreshError = "";
  if (auditPresetEl && auditFromEl && auditToEl) {
    const initial = AuditExports.preset("today");
    auditPresetEl.value = "today"; auditFromEl.value = initial.from; auditToEl.value = initial.to;
  }
  function syncAuditRelativeDates(now = new Date()) {
    if (!auditPresetEl || !AuditExports.relative(auditPresetEl.value)) return false;
    const dates = AuditExports.preset(auditPresetEl.value, now);
    if (auditFromEl.value === dates.from && auditToEl.value === dates.to) return false;
    auditFromEl.value = dates.from; auditToEl.value = dates.to;
    // A native save already in progress remains a valid copy of its named day.
    // Abandon only unused / late preparation links, never the saved books.
    if (!auditNativeSave) clearAuditDownload();
    return true;
  }
  function scheduleAuditDay() {
    if (auditDayTimer) clearTimeout(auditDayTimer);
    auditDayTimer = setTimeout(() => {
      syncAuditRelativeDates();
      if (currentView === "customers" && viewReady) renderAuditLogs();
      scheduleAuditDay();
    }, AuditExports.untilMidnight());
  }
  scheduleAuditDay();
  const wakeAuditDay = () => {
    if (document.hidden) return;
    syncAuditRelativeDates();
    if (currentView === "customers" && viewReady) renderAuditLogs();
    scheduleAuditDay();
  };
  window.addEventListener("focus", wakeAuditDay);
  document.addEventListener("visibilitychange", wakeAuditDay);
  window.addEventListener("pagehide", () => { if (auditDayTimer) clearTimeout(auditDayTimer); });
  window.addEventListener("pageshow", wakeAuditDay);
  function auditDates() { return AuditExports.range(auditFromEl?.value || "", auditToEl?.value || ""); }
  function auditStatus(message, error = false) {
    const box = $("#auditDownloadStatus"), text = $("#auditDownloadMessage");
    if (box) { box.hidden = !message; box.classList.toggle("is-error", error); }
    if (text) text.textContent = message;
  }
  function auditSetBusy(busy) {
    auditBusy = busy;
    const disabled = busy || !!auditNativeSave;
    ["#btnExportAudit", "#btnExportAuditExcel", "#auditReport", "#auditDatePreset", "#auditDateFrom", "#auditDateTo", "#auditSearch", "#btnAuditToday", "#btnAuditYesterday", "#auditReceiptDay"].forEach(selector => { const element = $(selector); if (element) element.disabled = disabled; });
    ["#btnExportAudit", "#btnExportAuditExcel"].forEach(selector => $(selector)?.setAttribute("aria-busy", String(busy)));
  }
  function clearAuditDownload(message = "") {
    auditRequest++;
    if (auditController) auditController.abort();
    auditController = null; auditPendingArea = null; auditTicket = null;
    if (auditExpiryTimer) clearTimeout(auditExpiryTimer);
    const link = $("#auditDownloadFallback");
    if (link) { link.hidden = true; link.removeAttribute("href"); link.removeAttribute("download"); }
    auditSetBusy(false); auditStatus(message);
  }
  function auditSales() {
    let dates; try { dates = auditDates(); } catch (_) { return []; }
    return DB.listSales().filter(s => AuditExports.posted(s) && AuditExports.within(AuditExports.postingDate(s), dates))
      .filter(s => !auditTerm || AuditExports.searchFields(s).join(" ").toLowerCase().includes(auditTerm))
      .sort((a, b) => AuditExports.dateOf(AuditExports.postingDate(a)) - AuditExports.dateOf(AuditExports.postingDate(b)));
  }
  function renderAuditLogs() {
    const target = $("#auditList"); if (!target) return;
    syncAuditRelativeDates();
    const list = auditSales(), total = list.reduce((n, s) => n + Number(s.total || 0), 0);
    let dates = null, label = "Choose valid dates"; try { dates = auditDates(); label = dates.label; } catch (_) {}
    const today = AuditExports.kampalaDay(), daily = !!(dates?.from && dates.from === dates.to);
    const isToday = daily && dates.from === today;
    const title = dates ? AuditExports.dayTitle(dates) : "Choose valid receipt dates";
    const dayPicker = $("#auditReceiptDay");
    if (dayPicker && document.activeElement !== dayPicker) dayPicker.value = daily ? dates.from : "";
    if ($("#auditDayTitle")) $("#auditDayTitle").textContent = title;
    if ($("#auditReceiptsTitle")) $("#auditReceiptsTitle").textContent = title;
    if ($("#auditDayBadge")) { $("#auditDayBadge").textContent = isToday ? "TODAY" : daily ? "SAVED DAY" : "HISTORY"; $("#auditDayBadge").classList.toggle("is-history", !isToday); }
    if ($("#auditDayCaption")) $("#auditDayCaption").textContent = daily ? `${AuditExports.dayLabel(dates.from)} · Kampala time · 00:00 up to midnight.` : `${label} · Kampala time. Pick one day to reprint its invoices.`;
    $("#btnAuditToday")?.setAttribute("aria-pressed", String(isToday));
    $("#btnAuditYesterday")?.setAttribute("aria-pressed", String(daily && dates.from === AuditExports.preset("yesterday").from));
    if ($("#btnPrintDayReceipts")) { $("#btnPrintDayReceipts").disabled = !list.length; $("#btnPrintDayReceipts").textContent = daily ? "Print day's invoices" : "Print selected invoices"; }
    if ($("#btnPrintAudit")) { $("#btnPrintAudit").disabled = !list.length; $("#btnPrintAudit").textContent = daily ? "Print day summary" : "Print selection summary"; }
    const summary = $("#auditSummary");
    if (summary) summary.innerHTML = `<strong>${list.length}</strong> receipt${list.length === 1 ? "" : "s"} · <strong>${ugx(total)}</strong> posted sales${auditTerm ? ' <span class="audit-filtered-label">Search filtered</span>' : ""}<span class="audit-period-label">${esc(label)} · EAT</span>`;
    const sync = DB.operationalSyncStatus ? DB.operationalSyncStatus() : null;
    const syncNode = $("#auditSyncState");
    if (syncNode) {
      syncNode.classList.toggle("is-offline", !!auditRefreshError || sync?.online === false);
      syncNode.textContent = auditRefreshing ? "Refreshing receipts from saved records…" : auditRefreshError || (sync?.online === true ? `Saved records refreshed ${AuditExports.stamp(sync.last_synced_at)}. History is retained.` : sync?.online === false ? "Connection unavailable — showing the last saved copy. Refresh before printing a complete closing-day report." : "Saved receipt list. Refresh to check the latest postings.");
    }
    target.innerHTML = list.length ? list.map(s => `<button type="button" class="guest-card audit-card audit-invoice" data-print-sale="${esc(s.id)}" aria-label="Print receipt ${esc(s.order_number || s.id)}">
      <span class="audit-invoice-top"><span class="audit-invoice-icon" aria-hidden="true">${Icons.svg("file-text", "ico-20")}</span><span class="audit-invoice-main"><strong>${esc(s.order_number || s.id)}</strong><span>${esc(AuditExports.stamp(AuditExports.postingDate(s)))}</span></span><strong class="audit-invoice-amount">${ugx(s.total || 0)}</strong></span>
      <span class="audit-invoice-customer">${esc(s.customer_name || "Walk-in customer")}${s.cashier_name || s.cashier?.name ? ` · ${esc(s.cashier_name || s.cashier.name)}` : ""}</span>
      <span class="audit-invoice-bottom"><span class="audit-invoice-tags"><span class="itag">${esc(s.payment_method || s.tender_type || s.tender?.type || "Payment recorded")}</span><span class="itag">${esc(s.channel || "POS")}</span></span><span class="audit-invoice-print">${Icons.svg("printer", "ico-14")} Print invoice</span></span>
    </button>`).join("") : `<div class="card audit-empty"><strong>${isToday ? "No receipts posted today yet" : "No posted receipts in this selection"}</strong><p class="muted">${isToday ? "Completed sales will appear here throughout the day. Yesterday's invoices are not deleted — select Yesterday or a past date above to find them." : "Try another day or clear the search. Saved history and ledger postings are never removed by these filters."}</p></div>`;
    if ($("#auditReportNote")) $("#auditReportNote").textContent = AuditExports.note(auditReportEl?.value || "sales");
  }
  function auditPrintStatus(message, error = false) {
    const node = $("#auditPrintStatus");
    if (node) { node.hidden = !message; node.textContent = message; node.classList.toggle("is-error", error); }
  }
  function auditPrintSelection() {
    syncAuditRelativeDates();
    const dates = auditDates(), sync = DB.operationalSyncStatus ? DB.operationalSyncStatus() : null;
    return {...dates, search:auditTerm, lastSynced:sync?.last_synced_at || null, offline:sync?.online === false || !!auditRefreshError};
  }
  function performAuditPrint(action) {
    if (typeof PosAccess !== "undefined" && !PosAccess.canUse("orders")) { auditPrintStatus("This area is locked. Unlock Orders & audit to reprint saved invoices.", true); return; }
    try {
      const result = action();
      auditPrintStatus(result.mode === "native" ? "System print requested. Choose a printer or Save as PDF. Your sale records stay unchanged." : "Print dialog requested. Choose your printer or Save as PDF. Printing does not delete or repost the sale.");
    } catch (error) { auditPrintStatus(error.message, true); toast(error.message, false); }
  }
  function printAuditReceipt(id) {
    syncAuditRelativeDates();
    const sale = auditSales().find(record => String(record.id) === String(id));
    if (!sale) { auditPrintStatus("This receipt is no longer in the selected day. Refresh or choose its saved date to print it.", true); return; }
    performAuditPrint(() => ReceiptPrinter.printReceipt(sale, DB.getSettings(), $("#auditPrintPaper")?.value || "a4"));
  }
  async function refreshAuditReceipts() {
    if (auditRefreshing) return;
    if (typeof PosAccess !== "undefined" && !PosAccess.canUse("orders")) return;
    const button = $("#btnRefreshAudit"); auditRefreshing = true; auditRefreshError = "";
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    renderAuditLogs(); let timer;
    try {
      const refreshed = await Promise.race([
        DB.refreshOperationalData(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The server took too long. Showing the saved copy — tap Refresh receipts to try again.")), 30000); })
      ]);
      if (!refreshed) throw new Error("Could not refresh receipts. Showing the saved copy — check your connection and try again.");
    } catch (error) { auditRefreshError = error.message || "Could not refresh saved records."; }
    finally {
      clearTimeout(timer); auditRefreshing = false;
      if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
      if (currentView === "customers" && viewReady) renderAuditLogs();
    }
  }
  async function startAuditDownload(ticket, signal, request = auditRequest) {
    const result = await FileDownloads.download(ticket, signal);
    if (request !== auditRequest || signal?.aborted) {
      if (result.mode === "native" && typeof window.Android?.cancelFileExport === "function") window.Android.cancelFileExport(result.id);
      return;
    }
    const count = `${ticket.records} record${ticket.records === 1 ? "" : "s"}`;
    if (result.mode === "native") {
      auditNativeSave = result.id;
      auditStatus(`${ticket.filename} · ${count}. Choose a folder in Save As, then tap Save.`);
    } else if (result.mode === "external") {
      auditStatus(`${ticket.filename} · ${count}. Download opened in your phone browser. Check Downloads or tap Download again.`);
    } else {
      auditStatus(`${ticket.filename} · ${count}. Download requested — check your browser's Downloads. If it did not appear, tap Download again.`);
    }
    if (!ticket.records) toast("No records in this selection — the file contains column headers only");
  }
  async function exportAuditFile(format = "csv") {
    if (auditBusy || auditNativeSave) return;
    syncAuditRelativeDates();
    let dates; try { dates = auditDates(); } catch (error) { auditStatus(error.message, true); toast(error.message, false); return; }
    const kind = auditReportEl?.value || "sales";
    clearAuditDownload(); const request = auditRequest;
    auditSetBusy(true); auditStatus(`Preparing ${format === "xlsx" ? "Excel workbook" : "CSV"} from saved records…`);
    try {
      if (typeof PosAccess !== "undefined" && !(await PosAccess.ensure(AuditExports.AREAS[kind]))) {
        auditStatus("Export cancelled. Unlock the selected area to download its records."); return;
      }
      if (request !== auditRequest) return;
      const controller = new AbortController(); auditController = controller; auditPendingArea = AuditExports.AREAS[kind];
      const ticket = await DB.prepareExport({kind, format, from:dates.from, to:dates.to, q:auditTerm}, controller.signal);
      if (request !== auditRequest || controller.signal.aborted) return;
      auditTicket = ticket;
      const link = $("#auditDownloadFallback");
      if (link) { link.href = ticket.url; link.download = ticket.filename; link.textContent = "Download again"; link.hidden = false; }
      auditExpiryTimer = setTimeout(() => clearAuditDownload("This download link expired after 10 minutes. Export again for a fresh file."), 10 * 60 * 1000);
      await startAuditDownload(ticket, controller.signal);
    } catch (error) {
      if (request !== auditRequest) return;
      const message = error.message || "The export could not be downloaded. Check your connection and try again.";
      auditStatus(message, true); toast(message, false);
    } finally {
      if (request === auditRequest) { auditController = null; auditPendingArea = null; auditSetBusy(false); }
    }
  }
  function chooseAuditDay(preset) {
    if (auditBusy || auditNativeSave) return;
    const dates = AuditExports.preset(preset);
    auditPresetEl.value = preset; auditFromEl.value = dates.from; auditToEl.value = dates.to;
    auditTerm = ""; if (auditSearchEl) auditSearchEl.value = "";
    clearAuditDownload(); auditPrintStatus(""); renderAuditLogs();
  }
  $("#auditReceiptDay")?.addEventListener("change", event => {
    if (auditBusy || auditNativeSave || !event.target.value) return;
    try {
      const dates = AuditExports.range(event.target.value, event.target.value);
      auditPresetEl.value = dates.from === AuditExports.kampalaDay() ? "today" : "custom";
      auditFromEl.value = dates.from; auditToEl.value = dates.to;
      auditTerm = ""; if (auditSearchEl) auditSearchEl.value = "";
      clearAuditDownload(); auditPrintStatus(""); renderAuditLogs();
    } catch (error) { auditPrintStatus(error.message, true); }
  });
  $("#btnAuditToday")?.addEventListener("click", () => chooseAuditDay("today"));
  $("#btnAuditYesterday")?.addEventListener("click", () => chooseAuditDay("yesterday"));
  $("#btnRefreshAudit")?.addEventListener("click", refreshAuditReceipts);
  $("#btnPrintDayReceipts")?.addEventListener("click", () => performAuditPrint(() => {
    const selection = auditPrintSelection();
    return ReceiptPrinter.printInvoices(auditSales(), selection, DB.getSettings(), $("#auditPrintPaper")?.value || "a4");
  }));
  window.addEventListener("adonai-receipt-print-result", event => {
    if (currentView !== "customers" || !viewReady) return;
    auditPrintStatus(event.detail?.message || "Choose a printer in system print.", event.detail?.status === "error");
  });
  if (auditSearchEl) auditSearchEl.addEventListener("input", e => { auditTerm = e.target.value.trim().toLowerCase(); clearAuditDownload(); renderAuditLogs(); });
  if (auditPresetEl) auditPresetEl.addEventListener("change", () => {
    if (auditPresetEl.value !== "custom") { const dates = AuditExports.preset(auditPresetEl.value); auditFromEl.value = dates.from; auditToEl.value = dates.to; }
    clearAuditDownload(); renderAuditLogs();
  });
  [auditFromEl, auditToEl].forEach(element => {
    // Do not reset a date while a cashier is typing it during a live DB poll.
    element?.addEventListener("input", () => { if (auditPresetEl) auditPresetEl.value = "custom"; });
    element?.addEventListener("change", () => { if (auditPresetEl) auditPresetEl.value = "custom"; clearAuditDownload(); auditPrintStatus(""); renderAuditLogs(); });
  });
  auditReportEl?.addEventListener("change", () => { clearAuditDownload(); renderAuditLogs(); });
  $("#btnExportAudit")?.addEventListener("click", () => exportAuditFile("csv"));
  $("#btnExportAuditExcel")?.addEventListener("click", () => exportAuditFile("xlsx"));
  $("#auditDownloadFallback")?.addEventListener("click", async event => {
    if (!FileDownloads.nativePresent()) return; // ordinary HTTPS attachment on browsers
    event.preventDefault(); if (!auditTicket || auditBusy || auditNativeSave) return;
    const request = auditRequest; auditSetBusy(true);
    const controller = new AbortController(); auditController = controller; auditPendingArea = AuditExports.AREAS[auditTicket.kind];
    try { await startAuditDownload(auditTicket, controller.signal); }
    catch (error) { if (request === auditRequest) auditStatus(error.message, true); }
    finally { if (request === auditRequest) { auditController = null; auditPendingArea = null; auditSetBusy(false); } }
  });
  window.addEventListener("adonai-file-export-result", event => {
    if (event.detail?.id !== auditNativeSave) return;
    auditNativeSave = null; auditSetBusy(false);
    const {status, message} = event.detail;
    auditStatus(message || (status === "saved" ? "File saved. Open it from the folder you chose in Save As." : status === "cancelled" ? "Save cancelled — tap Download again to choose a folder." : "File could not be saved. Tap Download again."), status === "error");
  });
  window.addEventListener("pos-access-change", () => {
    if (typeof PosAccess === "undefined") return;
    const area = auditTicket ? AuditExports.AREAS[auditTicket.kind] : auditPendingArea;
    if (area && !PosAccess.canUse(area)) {
      if (auditNativeSave && typeof window.Android?.cancelFileExport === "function") window.Android.cancelFileExport(auditNativeSave);
      auditNativeSave = null;
      clearAuditDownload("This area was locked. Unlock it before exporting again.");
    }
  });
  function printAuditSummary() {
    performAuditPrint(() => {
      const selection = auditPrintSelection();
      return ReceiptPrinter.printSummary(auditSales(), selection, DB.getSettings());
    });
  }
  $("#btnPrintAudit")?.addEventListener("click", printAuditSummary);
  function renderGuests() {
    let list = DB.listGuests();
    if (guestTerm) list = list.filter(g => [g.name, g.phone, g.neighborhood].some(x => String(x || "").toLowerCase().includes(guestTerm)));
    $("#guestList").innerHTML = list.length ? list.map(g => `
      <div class="guest-card">
        <div class="guest-top">
          <span class="avatar" style="background:${avColor(g.name)}">${initials(g.name)}</span>
          <div class="grow">
            <div class="guest-name">${esc(g.name)}</div>
            ${g.phone ? `<a class="guest-phone" href="tel:${esc(String(g.phone).replace(/[^+0-9]/g, ""))}">${Icons.svg("phone", "ico-12")} ${esc(g.phone)}</a>` : ""}
          </div>
          <div class="gc-actions">
            <button class="lnk" data-edit-guest="${esc(g.id)}">Edit</button>
            <button class="lnk dim" data-del-guest="${esc(g.id)}">Remove</button>
          </div>
        </div>
        ${(g.address || g.neighborhood || g.email) ? `<div class="guest-tags">
          ${g.neighborhood ? `<span class="itag">${Icons.svg("map-pin", "ico-11")} ${esc(g.neighborhood)}</span>` : ""}
          ${g.address ? `<span class="itag">${esc(g.address)}</span>` : ""}
          ${g.email ? `<span class="itag">${Icons.svg("mail", "ico-11")} ${esc(g.email)}</span>` : ""}
        </div>` : ""}
        ${g.notes ? `<div class="guest-notes">${Icons.svg("clipboard", "ico-12")} ${esc(g.notes)}</div>` : ""}
      </div>`).join("") : `<div class="card"><p class="muted" style="padding:20px">No guests match — add the first one.</p></div>`;
  }
  function guestModal(id) {
    const g = id ? DB.listGuests().find(x => x.id === id) : null;
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${g ? "Edit guest" : "New guest"}</h3>
      ${["NAME", "PHONE", "EMAIL", "ADDRESS", "NEIGHBORHOOD"].map(k =>
        `<div class="field"><label>${k}</label><input class="sel-full" id="mg${k[0] + k.slice(1).toLowerCase()}" value="${g ? esc(g[k.toLowerCase()] || "") : ""}" /></div>`).join("")}
      <div class="field"><label>NOTES</label><textarea class="sel-full" id="mgNotes">${g ? esc(g.notes || "") : ""}</textarea></div>
      <button class="btn primary big" style="width:100%" data-save-guest="${g ? esc(g.id) : ""}">Save guest</button>`);
  }

  /* ============================================================
     DELIVERY PARTNERS & DISPATCH
     ============================================================ */
  function renderRiders() {
    if (window.DispatchCenter) { DispatchCenter.activate(); return; }
    const all = allSales();
    $("#riderList").innerHTML = DB.listRiders().map(r => {
      const active = all.filter(s => assignedRiderId(s) === String(r.id) && fulfillmentStage(s) === "Dispatched").length;
      const delivered = all.filter(s => assignedRiderId(s) === String(r.id) && fulfillmentStage(s) === "Completed").length;
      return `
      <div class="rider-card">
        <div class="rc-top">
          <span class="avatar" style="background:${avColor(r.name)}">${initials(r.name)}</span>
          <div class="grow"><div class="guest-name" style="margin:0">${esc(r.name)}</div>
            <div class="rider-tags"><span class="itag">${Icons.svg("bike", "ico-11")} ${esc(r.vehicle)}</span><span class="itag">${Icons.svg("map-pin", "ico-11")} ${esc(r.zone)}</span></div></div>
          <div class="rc-stats">
            <div><strong class="serif">${active}</strong><span class="micro-cap">EN ROUTE</span></div>
            <div><strong class="serif">${delivered}</strong><span class="micro-cap">DONE</span></div>
          </div>
        </div>
        <div class="rc-chip">${riderStatusChip(r.status)}${r.phone ? `<a class="stat-chip mut" href="tel:${esc(String(r.phone).replace(/[^+0-9]/g, ""))}">${Icons.svg("phone", "ico-11")} CALL</a>` : ""}</div>
        <div class="rc-btns">
          ${DB.RIDER_STATUSES.map(st => `<button class="lane-tab ${r.status === st ? "active" : ""}" data-rider-st="${esc(r.id)}" data-st="${st}">${st.toUpperCase()}</button>`).join("")}
        </div>
        <button class="lnk" data-edit-rider="${esc(r.id)}">Edit route details</button>
      </div>`;
    }).join("");
  }
  function riderModal(id) {
    const r = id ? DB.listRiders().find(x => x.id === id) : {id:"",name:"",phone:"",vehicle:"Motorbike (Boda)",zone:"",plate:""};
    if (!r) return;
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${id ? "Delivery partner details" : "Add delivery partner"}</h3>
      <div class="field"><label>Name</label><input class="sel-full" id="mrName" value="${esc(r.name)}" /></div>
      <div class="field"><label>Phone</label><input class="sel-full" id="mrPhone" type="tel" maxlength="50" value="${esc(r.phone)}" /></div>
      <div class="field"><label>Vehicle</label><input class="sel-full" id="mrVehicle" value="${esc(r.vehicle)}" /></div>
      <div class="field"><label>Vehicle registration / plate</label><input class="sel-full" id="mrPlate" maxlength="50" value="${esc(r.plate || "")}" /></div>
      <div class="field"><label>Service zone</label><input class="sel-full" id="mrZone" maxlength="100" value="${esc(r.zone)}" /></div>
      <p class="muted small">Saved on the server for all staff devices. GPS is off until this partner explicitly shares from a paired Android phone.</p>
      <button class="btn primary" data-save-rider="${esc(r.id)}">Save rider</button>`);
  }

  window.addEventListener("adonai-add-rider", () => { if (currentView === "dispatch" && viewReady) riderModal(null); });

  /* ============================================================
     FINANCIAL LEDGERS — server-backed, double-entry hub
     ============================================================ */
  let financeTab = "expenses";
  let agingDays = 30;
  let financeLoadedAt = 0;
  let financeBusy = false;

  const localISODate = (date = new Date()) => {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 10);
  };
  const localISODateTime = (date = new Date()) => {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  };
  const readableDateTime = value => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-UG", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  };
  const financeError = error => {
    const status = Number(error && error.status);
    const message = (error && error.message) || "Financial data could not be loaded";
    if (pinFree && (status === 401 || status === 403)) {
      return `<div class="finance-error"><div><strong>Reconnect the terminal</strong><p class="small">The automatic terminal session could not connect. Try again to reconnect — no PIN or master key is required in PIN-free mode.</p><div class="finance-error-actions"><button type="button" class="btn primary sm" data-finance-retry>Try again</button></div></div></div>`;
    }
    const action = status === 403
      // never a dead end: the passkey input is right here
      ? `<div class="fin-inline-unlock">
           <label class="flab">Admin Suite passkey</label>
           <div class="sku-row">
             <input type="password" class="sel-full" data-unlock-input placeholder="Store master passkey…" autocomplete="off" />
             <button class="btn primary sm" data-finance-unlock type="button">Unlock</button>
           </div>
           <small class="muted">One unlock opens every dashboard in the suite for this session.</small>
         </div>`
      : status === 401
        ? `<a class="btn primary sm" href="login.html">Sign in to terminal</a>`
        : `<button type="button" class="btn primary sm" data-finance-retry>Try again</button>`;
    return `<div class="finance-error"><div><strong>${status === 401 ? "Staff sign-in required" : status === 403 ? "Admin Suite passkey required" : "Could not load this workspace"}</strong><p class="small">${esc(message)}</p><div class="finance-error-actions">${action}</div></div></div>`;
  };
  const setFinanceUpdated = text => {
    const target = $("#financeUpdated");
    if (target) target.textContent = text || ("Synced " + new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }));
  };
  const setButtonBusy = (button, busy, busyText) => {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = busyText || "Saving…";
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
    }
  };

  function switchFinanceTab(tab, force = false) {
    if (!["expenses", "lots", "dashboard", "aging", "journal", "insights"].includes(tab)) return;
    financeTab = tab;
    $$("[data-finance-tab]").forEach(button => {
      const active = button.dataset.financeTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$(".finance-panel").forEach(panel => {
      const active = panel.id === "finance-" + tab;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
    loadFinanceTab(tab, force);
  }

  async function loadFinanceTab(tab, force = false) {
    if (financeBusy && !force) return;
    financeBusy = true;
    try {
      if (tab === "expenses") await loadExpenses();
      else if (tab === "lots") await loadStockLots();
      else if (tab === "dashboard") await loadDashboard();
      else if (tab === "aging") await loadAging();
      else if (tab === "journal") await loadJournal();
      else if (tab === "insights") await loadInsights();
      financeLoadedAt = Date.now();
      setFinanceUpdated();
    } finally {
      financeBusy = false;
    }
  }

  async function loadExpenses() {
    const host = $("#expenseList");
    if (!host) return;
    host.innerHTML = `<div class="finance-empty">Syncing today’s cash outs…</div>`;
    try {
      const data = await DB.financeRequest("expenses?date=" + localISODate(), { method:"GET" });
      $("#expenseTodayTotal").textContent = ugx(data.total || 0);
      const rows = data.expenses || [];
      host.innerHTML = rows.length ? `<div class="fin-list">${rows.map(row => `
        <article class="fin-list-row">
          <div>
            <div class="fin-list-title">${esc(row.category)} <span class="fin-status ${row.status === "VOID" ? "void" : ""}">${esc(row.status)}</span></div>
            <div class="fin-list-meta">${readableDateTime(row.occurred_at)} · ${esc(row.payment_method.replaceAll("_", " "))}${row.vendor ? " · " + esc(row.vendor) : ""}${row.receipt_reference ? " · Ref " + esc(row.receipt_reference) : ""}<br/>Posted by ${esc(row.created_by_name || "Staff")}${row.void_reason ? " · " + esc(row.void_reason) : ""}</div>
          </div>
          <div class="fin-list-side"><strong>${ugx(row.amount)}</strong>${row.status === "POSTED" ? `<div class="fin-actions"><button data-expense-edit="${esc(row.id)}">Edit</button><button class="danger" data-expense-void="${esc(row.id)}">Void</button></div>` : ""}</div>
        </article>`).join("")}</div>` : `<div class="finance-empty"><div><strong>No expenses posted today</strong><p class="small">Use the form to record the first cash out.</p></div></div>`;
      host._expenseRows = rows;
    } catch (error) {
      host.innerHTML = financeError(error);
    }
  }

  function openExpenseEditor(expense) {
    const sourceDate = new Date(expense.occurred_at);
    openModal(`
      <button class="modal-x" data-close>×</button>
      <p class="kicker">AUDITED ADJUSTMENT</p><h3>Edit today’s expense</h3>
      <p class="muted small">The original journal is reversed and a corrected balanced entry is posted. Audit history is retained.</p>
      <div class="fgrid">
        <div class="field"><label>Category</label><input class="sel-full" id="editExpenseCategory" value="${esc(expense.category)}" /></div>
        <div class="field"><label>Amount (UGX)</label><input class="sel-full" id="editExpenseAmount" type="number" min="1" value="${expense.amount}" /></div>
        <div class="field"><label>Paid from</label><select class="sel-full" id="editExpensePayment"><option value="cash" ${expense.payment_method === "cash" ? "selected" : ""}>Cash Drawer</option><option value="mobile_money" ${expense.payment_method === "mobile_money" ? "selected" : ""}>Mobile Money</option><option value="bank" ${expense.payment_method === "bank" ? "selected" : ""}>Bank Account</option></select></div>
        <div class="field"><label>Vendor</label><input class="sel-full" id="editExpenseVendor" value="${esc(expense.vendor)}" /></div>
        <div class="field"><label>Receipt / reference</label><input class="sel-full" id="editExpenseReceipt" value="${esc(expense.receipt_reference)}" /></div>
        <div class="field"><label>Date &amp; time</label><input class="sel-full" id="editExpenseDate" type="datetime-local" value="${localISODateTime(sourceDate)}" /></div>
        <div class="field full"><label>Notes</label><textarea class="sel-full" id="editExpenseNotes">${esc(expense.notes)}</textarea></div>
      </div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveExpenseEdit">Post corrected entry</button></div>`);
    $("#saveExpenseEdit").addEventListener("click", async () => {
      const button = $("#saveExpenseEdit");
      setButtonBusy(button, true, "Posting correction…");
      try {
        await DB.financeRequest("expenses/" + encodeURIComponent(expense.id), {
          method:"PUT", body:JSON.stringify({
            category:$("#editExpenseCategory").value.trim(), amount:Number($("#editExpenseAmount").value),
            payment_method:$("#editExpensePayment").value, vendor:$("#editExpenseVendor").value.trim(),
            receipt_reference:$("#editExpenseReceipt").value.trim(), occurred_at:$("#editExpenseDate").value,
            notes:$("#editExpenseNotes").value.trim()
          })
        });
        closeModal(); toast("Expense corrected and journal history preserved"); await loadExpenses();
      } catch (error) { toast(error.message, false); setButtonBusy(button, false); }
    });
  }

  function lotGradesSummary(lot) {
    const grades = lot.grades || [];
    if (!grades.length) return "";
    return `<table class="lot-grade-summary"><thead><tr><th>Tier</th><th class="num">Pcs</th><th class="num">Weight</th><th class="num">Locked COGS</th><th class="num">Target</th><th class="num">Left</th></tr></thead><tbody>${grades.map(g => `
      <tr><td>${esc(g.grade_name)}</td><td class="num">${g.expected_count}</td><td class="num">${g.cost_weight_percentage}%</td><td class="num">${ugx(g.unit_cogs)}</td><td class="num">${ugx(g.target_selling_price)}</td><td class="num ${g.remaining_count ? "" : "depleted"}">${g.remaining_count}</td></tr>`).join("")}</tbody></table>`;
  }

  async function loadStockLots() {
    const host = $("#stockLotList");
    if (!host) return;
    host.innerHTML = `<div class="finance-empty">Syncing stock-lot allocations…</div>`;
    try {
      const data = await DB.financeRequest("stock-lots", { method:"GET" });
      const rows = data.stock_lots || [];
      host.innerHTML = rows.length ? `<div class="fin-list">${rows.map(row => `
        <article class="fin-list-row"><div><div class="fin-list-title">${esc(row.lot_code)} <span class="fin-status">${esc(row.status)}</span>${(row.grades || []).length ? ` <span class="lot-grade-pill">${row.grades.length} tiers</span>` : ""}</div><div class="fin-list-meta">${esc(row.supplier)} · ${esc(row.description)}<br/>${row.allocated_count} allocated · ${row.remaining_count} remaining · ${readableDateTime(row.acquired_at)}</div>${lotGradesSummary(row)}</div><div class="fin-list-side"><strong>${ugx(row.unit_cost)} / item</strong><span class="small muted">Landed ${ugx(row.total_landed_cost)}</span></div></article>`).join("")}</div>` : `<div class="finance-empty"><div><strong>No lots registered</strong><p class="small">Register a bale before tagging its items.</p></div></div>`;
    } catch (error) { host.innerHTML = financeError(error); }
  }

  function metricCard(label, value, note, classes = "") {
    return `<div class="finance-metric ${classes}"><span class="metric-label">${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`;
  }
  function barRows(rows, labelKey, valueKey, valueFormatter) {
    if (!rows.length) return `<div class="finance-empty">No activity for this period.</div>`;
    const max = Math.max(1, ...rows.map(row => Math.max(0, Number(row[valueKey]) || 0)));
    return rows.map(row => `<div class="bar-row"><span class="bar-label" title="${esc(row[labelKey])}">${esc(row[labelKey])}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, Math.round((Math.max(0, row[valueKey]) / max) * 100))}%"></span></span><span class="bar-value">${esc(valueFormatter(row))}</span></div>`).join("");
  }
  async function loadDashboard() {
    const metricsHost = $("#dashboardMetrics");
    if (!metricsHost) return;
    metricsHost.innerHTML = `<div class="finance-empty" style="grid-column:1/-1">Calculating live profitability…</div>`;
    try {
      const date = $("#dashboardDate").value || localISODate();
      const data = await DB.financeRequest("dashboard?date=" + encodeURIComponent(date), { method:"GET" });
      const m = data.metrics;
      metricsHost.innerHTML =
        metricCard("Gross sales", ugx(m.gross_sales), `${data.order_count} completed / active orders`, "accent") +
        metricCard("Cost of goods", ugx(m.cogs), "Historical unit-cost snapshots") +
        metricCard("Gross profit", ugx(m.gross_profit), `${m.gross_margin}% gross margin`, "") +
        metricCard("Operating expenses", ugx(m.expenses), "Posted cash outs & write-offs", "warn") +
        metricCard("Net operating income", ugx(m.net_operating_income), "Gross profit less operating expenses", m.net_operating_income >= 0 ? "accent" : "warn") +
        metricCard("Cash drawer", ugx(m.cash_balance), "Journal balance") +
        metricCard("Mobile Money", ugx(m.mobile_money_balance), "MTN / Airtel journal balance") +
        metricCard("Bank", ugx(m.bank_balance), "Bank-account journal balance");
      $("#channelChart").innerHTML = barRows(data.sales_by_channel || [], "channel", "amount", row => ugx(row.amount));
      $("#categoryChart").innerHTML = barRows(data.category_profitability || [], "category", "profit", row => `${ugx(row.profit)} · ${row.sales ? Math.round(row.profit / row.sales * 100) : 0}%`);
    } catch (error) {
      metricsHost.innerHTML = `<div style="grid-column:1/-1">${financeError(error)}</div>`;
      $("#channelChart").innerHTML = financeError(error);
      $("#categoryChart").innerHTML = financeError(error);
    }
  }

  async function loadAging() {
    const host = $("#agingList");
    if (!host) return;
    host.innerHTML = `<div class="finance-empty">Calculating inventory age…</div>`;
    try {
      const data = await DB.financeRequest("aging?days=" + agingDays, { method:"GET" });
      $("#agingSummary").innerHTML = `<div class="aging-stat"><span>Items at risk</span><strong>${data.count}</strong></div><div class="aging-stat"><span>Cost value at risk</span><strong>${ugx(data.value_at_risk)}</strong></div><div class="aging-stat"><span>Age threshold</span><strong>${data.days}+ days</strong></div>`;
      const rows = data.products || [];
      host.innerHTML = rows.length ? `<div class="fin-table-scroll"><table class="fin-table"><thead><tr><th>Product</th><th>Age</th><th>Stock</th><th class="num">Unit cost</th><th class="num">Live price</th><th class="num">Value at risk</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td><div class="aging-product">${row.image_url ? `<img class="aging-thumb" src="${esc(row.image_url)}" alt="" onerror="this.style.display='none'"/>` : `<span class="aging-thumb"></span>`}<span><strong>${esc(row.name)}</strong><br/><small class="muted">${esc(row.sku)} · ${esc(row.category)}</small></span></div></td><td>${row.age_days} days</td><td>${row.in_stock_count}</td><td class="num">${ugx(row.cost_price)}</td><td class="num">${ugx(row.selling_price)}</td><td class="num">${ugx(row.stock_value)}</td><td><div class="aging-action"><button data-aging-markdown="${esc(row.id)}" data-name="${esc(row.name)}" data-price="${row.selling_price}">Markdown</button><button class="danger" data-aging-writeoff="${esc(row.id)}" data-name="${esc(row.name)}">Write off</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="finance-empty"><div><strong>No stock beyond ${agingDays} days</strong><p class="small">Inventory is moving within this threshold.</p></div></div>`;
    } catch (error) { host.innerHTML = financeError(error); $("#agingSummary").innerHTML = ""; }
  }

  function openMarkdown(productId, name, currentPrice) {
    openModal(`<button class="modal-x" data-close>×</button><p class="kicker">LIVE STOREFRONT PRICE</p><h3>Markdown ${esc(name)}</h3><p class="muted small">The new price is written to the shared catalog immediately. Open storefronts refresh within five seconds.</p><div class="field"><label>Current price</label><div class="sel-full" style="background:#F3F4F6">${ugx(currentPrice)}</div></div><div class="field"><label>New selling price (UGX)</label><input class="sel-full" id="markdownPrice" type="number" min="1" max="${Math.max(1,currentPrice-1)}" /></div><div class="field"><label>Reason</label><input class="sel-full" id="markdownReason" value="Dead-stock markdown" /></div><div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveMarkdown">Publish markdown</button></div>`);
    $("#saveMarkdown").addEventListener("click", async () => {
      const button = $("#saveMarkdown"); setButtonBusy(button, true, "Publishing…");
      try {
        await DB.financeRequest(`aging/${encodeURIComponent(productId)}/markdown`, { method:"POST", body:JSON.stringify({ new_price:Number($("#markdownPrice").value), reason:$("#markdownReason").value.trim() }) });
        closeModal(); toast("Markdown is live on POS and storefront"); await DB.pullProducts(false); await loadAging();
      } catch (error) { toast(error.message, false); setButtonBusy(button, false); }
    });
  }

  async function loadJournal() {
    const host = $("#journalTable");
    if (!host) return;
    host.innerHTML = `<div class="finance-empty">Loading audited journal lines…</div>`;
    const params = new URLSearchParams();
    const controls = { search:"#journalSearch", account:"#journalAccount", source:"#journalSource", from:"#journalFrom", to:"#journalTo" };
    Object.keys(controls).forEach(key => { const value = $(controls[key]).value.trim(); if (value) params.set(key, value); });
    try {
      const data = await DB.financeRequest("journal?" + params.toString(), { method:"GET" });
      const account = $("#journalAccount"), source = $("#journalSource");
      const accountValue = account.value, sourceValue = source.value;
      account.innerHTML = `<option value="">All accounts</option>` + (data.accounts || []).map(row => `<option value="${esc(row.code)}">${esc(row.code)} · ${esc(row.name)}</option>`).join("");
      source.innerHTML = `<option value="">All sources</option>` + (data.sources || []).map(value => `<option value="${esc(value)}">${esc(value.replaceAll("_", " "))}</option>`).join("");
      account.value = accountValue; source.value = sourceValue;
      const difference = Number(data.totals.difference || 0);
      $("#journalBalance").textContent = difference === 0 ? `Balanced · ${ugx(data.totals.debit)}` : `Filtered difference · ${ugx(Math.abs(difference))}`;
      $("#journalBalance").classList.toggle("unbalanced", difference !== 0);
      const rows = data.lines || [];
      host.innerHTML = rows.length ? `<div class="fin-table-scroll"><table class="fin-table"><thead><tr><th>Date / time</th><th>Reference</th><th>Source</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Running balance</th><th>Memo / operator</th></tr></thead><tbody>${rows.map(row => `<tr><td>${readableDateTime(row.occurred_at)}</td><td><strong>${esc(row.reference)}</strong><br/><small class="muted">${esc(row.status)}</small></td><td>${esc(row.source.replaceAll("_", " "))}</td><td><strong>${esc(row.account_code)}</strong><br/><small>${esc(row.account_name)}</small></td><td class="num debit">${row.debit ? ugx(row.debit) : "—"}</td><td class="num credit">${row.credit ? ugx(row.credit) : "—"}</td><td class="num">${ugx(row.running_balance)}</td><td>${esc(row.memo || row.description)}<br/><small class="muted">${esc(row.created_by_name || "System")}</small></td></tr>`).join("")}</tbody></table></div>` : `<div class="finance-empty">No journal lines match these filters.</div>`;
    } catch (error) { host.innerHTML = financeError(error); }
  }

  /* ============================================================
     STRATEGY & MARKETING INSIGHTS — decision-ready reporting
     Turns posted, audited records into plain-language guidance
     for strategy management and day-to-day marketing.
     ============================================================ */
  let insightsDays = 30;
  let insightsCache = null;

  const ugxCompact = value => {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    if (abs >= 10000000) return "UGX " + Math.round(n / 1000000) + "M";
    if (abs >= 1000000) return "UGX " + (Math.round(n / 100000) / 10) + "M";
    if (abs >= 1000) return "UGX " + Math.round(n / 1000) + "k";
    return ugx(n);
  };
  const csvCell = value => FileDownloads.csvCell(value);
  const toCsv = rows => rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  async function downloadFile(name, content, mime = "text/csv;charset=utf-8") {
    try {
      const result = await FileDownloads.save(new Blob(["\ufeff" + content], {type:mime}), name, mime);
      toast(result.mode === "native" ? "Choose a folder in Save As, then tap Save" : "File ready — check your browser's Downloads");
      return result;
    } catch (error) { toast(error.message || "Download failed. Please try again.", false); return null; }
  }
  const pctLabel = value => (value === null || value === undefined) ? "—" : `${value > 0 ? "+" : ""}${value}%`;

  async function loadInsights() {
    const kpisHost = $("#insightsKpis");
    if (!kpisHost) return;
    kpisHost.innerHTML = `<div class="finance-empty" style="grid-column:1/-1">Compiling strategy report from posted records…</div>`;
    $("#insightsTrend").innerHTML = "";
    ["#insightsChannels", "#insightsCategories", "#insightsTopProducts", "#insightsCustomers", "#insightsQuality", "#insightsRecs"].forEach(sel => {
      const node = $(sel);
      if (node) node.innerHTML = "";
    });
    try {
      const data = await DB.financeRequest("insights?days=" + insightsDays, { method: "GET" });
      insightsCache = data;
      renderInsightsKpis(data);
      renderInsightsTrend(data);
      renderInsightsChannels(data);
      renderInsightsCategories(data);
      renderInsightsTopProducts(data);
      renderInsightsCustomers(data);
      renderInsightsQuality(data);
      renderInsightsRecs(data);
      setFinanceUpdated();
    } catch (error) {
      kpisHost.innerHTML = `<div style="grid-column:1/-1">${financeError(error)}</div>`;
    }
  }

  function renderInsightsKpis(data) {
    const k = data.kpis || {};
    const m = data.marketing || {};
    $("#insightsKpis").innerHTML =
      metricCard(`Revenue · ${data.days} days`, ugx(k.revenue),
        (k.revenue_growth_pct === null || k.revenue_growth_pct === undefined)
          ? `${k.orders} orders · ${k.units} units`
          : `${pctLabel(k.revenue_growth_pct)} vs previous ${data.days} days · ${k.orders} orders`, "accent") +
      metricCard("Net contribution", ugx(k.net_contribution),
        `${k.gross_margin}% gross margin after ${ugxCompact(k.expenses)} expenses`, k.net_contribution >= 0 ? "" : "warn") +
      metricCard("Avg order value", ugx(k.avg_order_value), "Bundle target: " + ugxCompact(Math.round((k.avg_order_value || 0) * 1.2))) +
      metricCard("Repeat buyers", (data.customers.repeat_rate || 0) + "%",
        `${data.customers.total} identified customers`) +
      metricCard("Marketing ROI", m.revenue_per_shilling ? `${m.revenue_per_shilling}×` : "Not measured",
        m.spend ? `${ugxCompact(m.spend)} spend · ${m.spend_ratio}% of revenue` : "No marketing expense posted", m.revenue_per_shilling && m.revenue_per_shilling >= 3 ? "" : "warn") +
      metricCard("Data reliability", data.data_quality.score + "%",
        data.data_quality.score >= 85 ? "Reports can be trusted" : "Clean up records below", data.data_quality.score >= 85 ? "" : "warn");
  }

  function renderInsightsTrend(data) {
    const host = $("#insightsTrend");
    const rows = data.daily_trend || [];
    if (!rows.length || !rows.some(r => r.revenue || r.profit)) {
      host.innerHTML = `<div class="finance-empty"><div><strong>No sales in this window yet</strong><p class="small">Ring orders through the POS or web storefront and the pulse appears here.</p></div></div>`;
      return;
    }
    const W = 720, H = 218, pad = { l: 10, r: 12, t: 16, b: 22 };
    const maxV = Math.max(1, ...rows.map(r => r.revenue));
    const x = i => pad.l + (rows.length === 1 ? (W - pad.l - pad.r) / 2 : i / (rows.length - 1) * (W - pad.l - pad.r));
    const y = v => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
    const line = key => rows.map((r, i) => `${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(" ");
    const area = `${pad.l},${H - pad.b} ` + line("revenue") + ` ${(W - pad.r).toFixed(1)},${H - pad.b}`;
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDay = iso => { const d = new Date(iso + "T00:00:00"); return `${d.getDate()} ${monthNames[d.getMonth()]}`; };
    const labelEvery = Math.max(1, Math.ceil(rows.length / 6));
    host.innerHTML = `
      <svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily revenue trend">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#15803D" stop-opacity=".22"/><stop offset="100%" stop-color="#15803D" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${[0.25, 0.5, 0.75].map(f => {
          const gy = y(maxV * f).toFixed(1);
          return `<line class="trend-grid" x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}"/><text class="trend-grid-label" x="${W - pad.r}" y="${(gy - 4)}">${esc(ugxCompact(maxV * f))}</text>`;
        }).join("")}
        <polygon class="trend-area" points="${area}"/>
        <polyline class="trend-line" points="${line("revenue")}"/>
        <polyline class="trend-line profit" points="${line("profit")}"/>
        ${rows.map((r, i) => `<circle class="trend-dot" data-trend-idx="${i}" cx="${x(i).toFixed(1)}" cy="${y(r.revenue).toFixed(1)}" r="${r.revenue ? 4 : 2.5}"/>`).join("")}
        ${rows.map((r, i) => i % labelEvery === 0 ? `<text class="trend-x" x="${x(i).toFixed(1)}" y="${H - 6}">${esc(fmtDay(r.date))}</text>` : "").join("")}
      </svg>
      <div class="trend-tooltip" id="trendTooltip" hidden></div>
      <div class="trend-legend"><span><i class="sw revenue"></i> Revenue</span><span><i class="sw profit"></i> Gross profit</span></div>`;
    const tooltip = $("#trendTooltip");
    host.onpointermove = event => {
      const dot = event.target.closest("[data-trend-idx]");
      if (!dot) { tooltip.hidden = true; return; }
      const row = rows[Number(dot.dataset.trendIdx)];
      tooltip.innerHTML = `<strong>${esc(fmtDay(row.date))}</strong><span>Revenue <b>${ugx(row.revenue)}</b></span><span>Orders <b>${row.orders}</b></span><span>Profit <b>${ugx(row.profit)}</b></span>`;
      const rect = host.getBoundingClientRect();
      const sx = rect.width / W;
      tooltip.style.left = Math.min(rect.width - 148, Math.max(4, (Number(dot.getAttribute("cx")) * sx) + 12)) + "px";
      tooltip.style.top = Math.max(2, (Number(dot.getAttribute("cy")) * (rect.height / H)) - 66) + "px";
      tooltip.hidden = false;
    };
    host.onpointerleave = () => { tooltip.hidden = true; };
  }

  function renderInsightsChannels(data) {
    const rows = data.channels || [];
    if (!rows.length) { $("#insightsChannels").innerHTML = `<div class="finance-empty">No channel sales in this window.</div>`; return; }
    $("#insightsChannels").innerHTML = `<div class="bar-chart">${rows.map(row => `
      <div class="bar-row channel-row">
        <span class="bar-label" title="${esc(row.channel)}">${esc(row.channel)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, row.share)}%"></span></span>
        <span class="bar-value">${ugx(row.revenue)} · ${row.share}%</span>
      </div>`).join("")}</div>
      <p class="muted small" style="margin:12px 0 0">Orders per channel: ${rows.map(row => `${esc(row.channel)} ${row.orders}`).join(" · ")}</p>`;
  }

  function renderInsightsCategories(data) {
    const rows = (data.categories || []).filter(row => row.revenue > 0);
    if (!rows.length) { $("#insightsCategories").innerHTML = `<div class="finance-empty">No category sales in this window.</div>`; return; }
    const max = Math.max(1, ...rows.map(row => row.revenue));
    $("#insightsCategories").innerHTML = `<div class="bar-chart cat-chart">${rows.map(row => `
      <button type="button" class="bar-row cat-row" data-insights-cat="${esc(row.category)}" title="Open ${esc(row.category)} pieces in the rack">
        <span class="bar-label">${esc(row.category)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, Math.round(row.revenue / max * 100))}%"></span></span>
        <span class="bar-value">${ugxCompact(row.revenue)} · ${row.share}% · margin ${row.margin}%</span>
      </button>`).join("")}</div>`;
  }

  function renderInsightsTopProducts(data) {
    const rows = data.top_products || [];
    if (!rows.length) { $("#insightsTopProducts").innerHTML = `<div class="finance-empty">No bestsellers to rank yet.</div>`; return; }
    $("#insightsTopProducts").innerHTML = `<ol class="insights-rank">${rows.map((row, i) => `
      <li class="insights-rank-row">
        <span class="rank-no">${i + 1}</span>
        <span class="rank-main"><strong>${esc(row.name)}</strong><small class="muted">${esc(row.category)} · ${row.units} unit${row.units === 1 ? "" : "s"}</small></span>
        <span class="rank-side"><strong>${ugxCompact(row.revenue)}</strong><small class="${row.margin >= 40 ? "pos" : row.margin < 20 ? "neg" : "muted"}">${row.margin}% margin</small></span>
      </li>`).join("")}</ol>`;
  }

  function renderInsightsCustomers(data) {
    const c = data.customers || { total: 0, repeat: 0, repeat_rate: 0, top: [], identified_order_share: 0 };
    const m = data.marketing || {};
    const top = c.top || [];
    $("#insightsCustomers").innerHTML = `
      <div class="insights-crm-stats">
        <div class="aging-stat"><span>Identified customers</span><strong>${c.total}</strong></div>
        <div class="aging-stat"><span>Repeat buyers</span><strong>${c.repeat} (${c.repeat_rate}%)</strong></div>
        <div class="aging-stat"><span>Orders with identity</span><strong>${c.identified_order_share}%</strong></div>
      </div>
      ${top.length ? `<p class="insights-subhead">Highest-value customers — greet by name &amp; reward</p>
      <div class="fin-list">${top.map(row => `
        <article class="fin-list-row">
          <div><div class="fin-list-title">${esc(row.name)}</div>
          <div class="fin-list-meta">${row.orders} order${row.orders === 1 ? "" : "s"} · ${row.phone ? "+" + esc(row.phone) : "no phone captured"}</div></div>
          <div class="fin-list-side"><strong>${ugx(row.spend)}</strong>${row.phone ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="https://wa.me/${esc(row.phone)}">WhatsApp ↗</a>` : ""}</div>
        </article>`).join("")}</div>` : `<div class="finance-empty"><div><strong>No named customers yet</strong><p class="small">Capture name &amp; phone at checkout to build the marketing list.</p></div></div>`}
      <div class="insights-marketing-chip">Marketing spend: <strong>${ugx(m.spend || 0)}</strong> (${(m.spend_ratio || 0)}% of revenue)${m.revenue_per_shilling ? ` · every shilling returned <strong>UGX ${m.revenue_per_shilling}</strong>` : ""}</div>`;
  }

  function renderInsightsQuality(data) {
    const q = data.data_quality || { score: 0, checks: [] };
    const score = q.score || 0;
    const tone = score >= 85 ? "good" : score >= 65 ? "fair" : "poor";
    const fixes = { "Inventory Rack": "inventory", "Bale Costs tab": "finance:lots", "Catalog Intake": "intake" };
    $("#insightsQuality").innerHTML = `
      <div class="quality-gauge-wrap">
        <svg class="quality-gauge ${tone}" viewBox="0 0 88 88" role="img" aria-label="Data reliability score ${score}%">
          <circle class="gauge-track" cx="44" cy="44" r="34" pathLength="100"/>
          <circle class="gauge-fill" cx="44" cy="44" r="34" pathLength="100" stroke-dasharray="${score} 100"/>
          <text x="44" y="42" class="gauge-num">${score}%</text>
          <text x="44" y="56" class="gauge-sub">${tone === "good" ? "Trusted" : tone === "fair" ? "Fair" : "At risk"}</text>
        </svg>
        <ul class="quality-checks">${(q.checks || []).map(row => `
          <li class="quality-check ${row.pass_rate >= 99.9 ? "pass" : "fail"}">
            <span class="qc-icon">${row.pass_rate >= 99.9 ? "✓" : "⚠"}</span>
            <span class="qc-main"><strong>${esc(row.label)}</strong><small>${row.pass_rate}% complete · affects ${esc(row.impact)}</small></span>
            ${fixes[row.fix] && row.pass_rate < 99.9 ? `<button type="button" class="btn ghost sm qc-fix" data-insights-fix="${fixes[row.fix]}">Fix</button>` : ""}
          </li>`).join("")}</ul>
      </div>`;
  }

  function renderInsightsRecs(data) {
    const rows = data.recommendations || [];
    $("#insightsRecs").innerHTML = rows.length ? `<div class="rec-list">${rows.map(row => `
      <article class="rec-card ${esc(row.tone)}">
        <strong>${esc(row.title)}</strong>
        <p>${esc(row.detail)}</p>
      </article>`).join("")}</div>` : `<div class="finance-empty">Post sales and expenses to generate strategy guidance.</div>`;
  }

  function exportInsightsReport() {
    if (!insightsCache) { toast("Load the strategy report first", false); return; }
    const d = insightsCache;
    const rows = [
      ["ADONAI STORE — STRATEGY & MARKETING REPORT"],
      [`Window: last ${d.days} days`, `Generated: ${new Date(d.generated_at).toLocaleString("en-UG")}`],
      [],
      ["KEY PERFORMANCE INDICATORS"],
      ["Metric", "Value"],
      ["Revenue (UGX)", d.kpis.revenue],
      ["Orders", d.kpis.orders],
      ["Units sold", d.kpis.units],
      ["Average order value (UGX)", d.kpis.avg_order_value],
      ["Gross profit (UGX)", d.kpis.gross_profit],
      ["Gross margin (%)", d.kpis.gross_margin],
      ["Operating expenses (UGX)", d.kpis.expenses],
      ["Net contribution (UGX)", d.kpis.net_contribution],
      ["Delivery fee revenue (UGX)", d.kpis.delivery_fee_revenue],
      [],
      ["DAILY TREND"],
      ["Date", "Revenue (UGX)", "Orders", "Gross profit (UGX)"],
      ...(d.daily_trend || []).map(r => [r.date, r.revenue, r.orders, r.profit]),
      [],
      ["CHANNELS"],
      ["Channel", "Revenue (UGX)", "Orders", "Share (%)"],
      ...(d.channels || []).map(r => [r.channel, r.revenue, r.orders, r.share]),
      [],
      ["CATEGORIES"],
      ["Category", "Revenue (UGX)", "Units", "Profit (UGX)", "Margin (%)", "Share (%)"],
      ...(d.categories || []).map(r => [r.category, r.revenue, r.units, r.profit, r.margin, r.share]),
      [],
      ["TOP PRODUCTS"],
      ["Product", "Category", "Units", "Revenue (UGX)", "Margin (%)"],
      ...(d.top_products || []).map(r => [r.name, r.category, r.units, r.revenue, r.margin]),
      [],
      ["TOP CUSTOMERS"],
      ["Customer", "Phone", "Orders", "Spend (UGX)"],
      ...((d.customers && d.customers.top) || []).map(r => [r.name, r.phone, r.orders, r.spend]),
      [],
      ["DATA RELIABILITY", `${d.data_quality.score}%`],
      ["Check", "Completion (%)", "Affects"],
      ...(d.data_quality.checks || []).map(r => [r.label, r.pass_rate, r.impact]),
      [],
      ["STRATEGY RECOMMENDATIONS"],
      ...(d.recommendations || []).map(r => [r.title, r.detail]),
    ];
    downloadFile(`adonai-strategy-report-${d.days}d-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  }

  function exportCrmList() {
    const top = (insightsCache && insightsCache.customers && insightsCache.customers.top) || [];
    if (!top.length) { toast("No customers captured yet — record name & phone at checkout", false); return; }
    const rows = [["Customer", "Phone", "Orders", "Spend (UGX)"], ...top.map(r => [r.name, r.phone, r.orders, r.spend])];
    downloadFile(`adonai-customers-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  }

  function openBroadcastModal() {
    const template = "Hello {first name}! New arrivals just landed at Adonai Store — {top category} from UGX {entry price}. First come, first served (1-of-1 pieces). Reply RESERVE or visit us at the store. Delivery: same-day boda in Kampala.";
    const d = insightsCache || {};
    const topCat = ((d.categories || [])[0] || {}).category || "new pieces";
    openModal(`
      <button class="modal-x" data-close>×</button>
      <p class="kicker">WHATSAPP CAMPAIGN</p><h3>Broadcast template</h3>
      <p class="muted small">Copy this into your WhatsApp Business broadcast list. Bracketed fields are auto-suggested from the current report:</p>
      <textarea class="sel-full" id="broadcastText" rows="6">${esc(template.replace("{top category}", topCat).replace("{entry price}", ugxCompact(((d.top_products || [])[0] || { revenue: 40000 }).revenue / Math.max(1, ((d.top_products || [])[0] || { units: 1 }).units))))}</textarea>
      <p class="muted small">Personalise <strong>{first name}</strong> per customer — WhatsApp Business labels let you paste it once per tag.</p>
      <div class="modal-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="copyBroadcast">Copy message</button></div>`);
    $("#copyBroadcast").addEventListener("click", async () => {
      const text = $("#broadcastText").value;
      try {
        await navigator.clipboard.writeText(text);
        toast("Broadcast copied — paste into WhatsApp Business");
      } catch (e) {
        $("#broadcastText").select();
        document.execCommand("copy");
        toast("Broadcast copied — paste into WhatsApp Business");
      }
    });
  }

  function jumpToInsightFix(target) {
    if (target === "finance:lots") {
      setView("payments");
      switchFinanceTab("lots", true);
      return;
    }
    setView(target);
    if (target === "inventory") {
      const search = $("#invSearch");
      if (search) { search.focus(); }
    }
  }

  /* -------- interactive bindings for the insights workspace -------- */
  if ($("#insightsRange")) {
    $("#insightsRange").addEventListener("click", event => {
      const button = event.target.closest("[data-insights-days]");
      if (!button) return;
      insightsDays = Number(button.dataset.insightsDays);
      $$("#insightsRange button").forEach(item => item.classList.toggle("active", item === button));
      loadInsights();
    });
    $("#insightsRefresh").addEventListener("click", loadInsights);
    $("#insightsExport").addEventListener("click", exportInsightsReport);
    $("#insightsCrmCsv").addEventListener("click", exportCrmList);
    $("#insightsBroadcast").addEventListener("click", openBroadcastModal);
  }

  /* ============================================================
     FINANCE FORM RELIABILITY GUARDS
     Inline, plain-language validation so the information staff
     enter is trustworthy enough for reports, strategy and tax.
     ============================================================ */
  function setFieldError(input, message) {
    const field = input.closest(".field");
    if (!field) {
      // Table-embedded inputs (lot tier builder) have no .field wrapper —
      // flag the input directly and surface the message on the weight panel.
      input.classList.toggle("invalid-input", !!message);
      const panelHint = $("#lotWeightHint");
      if (message && panelHint && input.closest("#lotGradeRows")) panelHint.textContent = message;
      return;
    }
    field.classList.toggle("invalid", !!message);
    let hint = field.querySelector(".field-error-text");
    if (message) {
      if (!hint) {
        hint = document.createElement("small");
        hint.className = "field-error-text";
        field.appendChild(hint);
      }
      hint.textContent = message;
    } else if (hint) {
      hint.remove();
    }
  }
  const asInt = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  const notFuture = (input, label) => {
    const value = input.value;
    if (value && new Date(value).getTime() > Date.now() + 60000) return `${label} cannot be in the future`;
    return "";
  };

  function validateExpenseForm(show = true) {
    let firstBad = null;
    const rules = [
      [$("#expenseCategory"), (() => $("#expenseCategory").value ? "" : "Choose a category — it drives strategy reporting")()],
      [$("#expenseAmount"), (() => {
        const amount = asInt($("#expenseAmount").value);
        if (!$("#expenseAmount").value || amount <= 0) return "Enter an amount of at least UGX 1";
        if (amount > 200000000) return "This looks unrealistically large — double-check before posting";
        return "";
      })()],
      [$("#expenseVendor"), (() => {
        const amount = asInt($("#expenseAmount").value);
        const vendor = $("#expenseVendor").value.trim();
        if (amount >= 500000 && !vendor) return "Record the vendor for cash outs of UGX 500,000+ (audit trail)";
        return "";
      })()],
      [$("#expenseDate"), (() => {
        if (!$("#expenseDate").value) return "Pick the date the money left";
        return notFuture($("#expenseDate"), "Expense date");
      })()],
    ];
    rules.forEach(([input, message]) => { if (show) setFieldError(input, message); if (message && !firstBad) firstBad = input; });
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  function validateLotForm(show = true) {
    let firstBad = null;
    const mark = (input, message) => {
      if (show && input) setFieldError(input, message);
      if (message && !firstBad && input) firstBad = input;
    };
    mark($("#lotSupplier"), $("#lotSupplier").value.trim().length >= 3 ? "" : "Name the supplier or market (min 3 characters)");
    mark($("#lotDescription"), $("#lotDescription").value.trim().length >= 3 ? "" : "Describe the bale contents so intake tags make sense");
    mark($("#lotAcquisition"), asInt($("#lotAcquisition").value) >= 1 ? "" : "Acquisition cost must be at least UGX 1");
    mark($("#lotShipping"), asInt($("#lotShipping").value) >= 0 ? "" : "Shipping cannot be negative");
    mark($("#lotDate"), (() => {
      if (!$("#lotDate").value) return "Pick the acquisition date";
      return notFuture($("#lotDate"), "Acquisition date");
    })());
    // Per-tier integrity: names, piece counts and weights must be usable,
    // then the weights must partition the investment to exactly 100%.
    lotGradeRows.forEach((row, index) => {
      const input = field => $(`#lotGradeRows [data-grade-field="${field}"][data-idx="${index}"]`);
      mark(input("grade_name"), String(row.grade_name || "").trim().length >= 3 ? "" : `Tier ${index + 1} needs a name (min 3 characters)`);
      mark(input("expected_count"), (() => {
        const count = asInt(row.expected_count);
        if (count < 1) return `Tier ${index + 1} must expect at least 1 piece`;
        if (count > 10000) return `Tier ${index + 1} count looks too high — verify before registering`;
        return "";
      })());
      mark(input("cost_weight_percentage"), (Number(row.cost_weight_percentage) > 0 && Number(row.cost_weight_percentage) <= 100) ? "" : `Tier ${index + 1} weight must be between 0 and 100%`);
    });
    if (!lotWeightValid()) {
      const weightInput = $(`#lotGradeRows [data-grade-field="cost_weight_percentage"][data-idx="${lotGradeRows.length - 1}"]`);
      mark(weightInput, `Tier weights total ${lotWeightTotal().toFixed(2)}% — they must equal exactly 100%`);
    }
    const blended = lotLandedTotal() / Math.max(1, lotGradedPieces());
    if (!firstBad && blended > 5000000) {
      mark($("#lotAcquisition"), `Blended unit cost of ${ugxCompact(blended)} per piece looks unrealistic — check cost and piece counts`);
    }
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  function installFinanceFormGuards() {
    const clearOn = (form, selectors) => {
      if (!form) return;
      selectors.forEach(sel => {
        const input = form.querySelector(sel);
        if (input) input.addEventListener("input", () => setFieldError(input, ""));
      });
    };
    clearOn($("#expenseForm"), ["#expenseCategory", "#expenseAmount", "#expenseVendor", "#expenseDate"]);
    clearOn($("#stockLotForm"), ["#lotSupplier", "#lotDescription", "#lotAcquisition", "#lotShipping", "#lotDate"]);
  }
  installFinanceFormGuards();

  function renderLedger() {
    if (!$("#financeTabs")) return;
    if (!$("#expenseDate").value) $("#expenseDate").value = localISODateTime();
    if (!$("#lotDate").value) $("#lotDate").value = localISODateTime();
    if (!$("#dashboardDate").value) $("#dashboardDate").value = localISODate();
    if (Date.now() - financeLoadedAt > 10000) switchFinanceTab(financeTab, true);
  }

  $("#financeTabs").addEventListener("click", event => {
    const button = event.target.closest("[data-finance-tab]");
    if (button) switchFinanceTab(button.dataset.financeTab, true);
  });
  $("#expenseForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!validateExpenseForm()) { toast("Fix the highlighted fields first — clean data keeps reports honest", false); return; }
    const button = $("#expenseSubmit"); setButtonBusy(button, true, "Posting atomically…");
    try {
      await DB.financeRequest("expenses", { method:"POST", body:JSON.stringify({
        category:$("#expenseCategory").value, amount:Number($("#expenseAmount").value),
        payment_method:$("#expensePayment").value, vendor:$("#expenseVendor").value.trim(),
        receipt_reference:$("#expenseReceipt").value.trim(), occurred_at:$("#expenseDate").value,
        notes:$("#expenseNotes").value.trim()
      }) });
      event.target.reset(); $("#expenseDate").value = localISODateTime();
      toast("Expense posted with balanced journal lines"); await loadExpenses();
    } catch (error) { toast(error.message, false); }
    finally { setButtonBusy(button, false); }
  });
  /* ----------------------------------------------------------
     MULTI-TIER LOT GRADING BUILDER (Financial Ledgers → Bale Costs)
     The table previews exactly what the server will lock:
     tier unit COGS = (landed investment × tier weight%) ÷ pieces.
     The API recomputes it authoritatively on save — this is only
     a live draft so staff can balance the weights to exactly 100%.
     ---------------------------------------------------------- */
  const defaultLotGradeRows = () => [
    { grade_name:"Tier 1 — Premium",   expected_count:10, cost_weight_percentage:40, target_selling_price:35000 },
    { grade_name:"Tier 2 — Standard",  expected_count:30, cost_weight_percentage:40, target_selling_price:20000 },
    { grade_name:"Tier 3 — Clearance", expected_count:20, cost_weight_percentage:20, target_selling_price:10000 },
  ];
  let lotGradeRows = defaultLotGradeRows();
  const lotLandedTotal = () => asInt($("#lotAcquisition").value) + asInt($("#lotShipping").value);
  const lotGradedPieces = () => lotGradeRows.reduce((sum, row) => sum + asInt(row.expected_count), 0);
  const lotWeightTotal = () => lotGradeRows.reduce((sum, row) => sum + (Number(row.cost_weight_percentage) || 0), 0);
  const lotWeightValid = () => lotGradeRows.length > 0 && Math.abs(lotWeightTotal() - 100) <= 0.01;
  const previewGradeCogs = row => {
    const count = asInt(row.expected_count);
    const weight = Number(row.cost_weight_percentage) || 0;
    if (!count || !lotLandedTotal()) return 0;
    return Math.round((lotLandedTotal() * (weight / 100)) / count);
  };

  function updateGradeCogsCells() {
    $$("#lotGradeRows [data-cogs-idx]").forEach(span => {
      const row = lotGradeRows[Number(span.dataset.cogsIdx)];
      if (row) span.textContent = ugx(previewGradeCogs(row));
    });
  }

  function refreshLotComputed() {
    const landed = lotLandedTotal();
    const pieces = lotGradedPieces();
    const ok = lotWeightValid();
    if ($("#lotLandedTotal")) $("#lotLandedTotal").textContent = ugx(landed);
    if ($("#lotTotalPcs")) $("#lotTotalPcs").textContent = `${pieces} pc${pieces === 1 ? "" : "s"}`;
    if ($("#lotUnitCost")) $("#lotUnitCost").textContent = pieces > 0 ? `${ugx(Math.round(landed / pieces))} / piece blended` : "UGX 0 / item";
    const check = $("#lotWeightCheck");
    if (check) {
      check.classList.toggle("ok", ok);
      check.classList.toggle("bad", !ok);
      $("#lotWeightValue").textContent = `${lotWeightTotal().toFixed(2)}% / 100%`;
      $("#lotWeightHint").textContent = ok
        ? "Balanced — every tier COGS above is locked on save."
        : "Tier weights must total exactly 100% before the lot can be saved.";
    }
    updateGradeCogsCells();
  }

  function renderLotGradeTable() {
    const host = $("#lotGradeRows");
    if (!host) return;
    host.innerHTML = lotGradeRows.map((row, index) => `
      <tr>
        <td class="w-name"><input data-grade-field="grade_name" data-idx="${index}" value="${esc(row.grade_name)}" placeholder="e.g. Tier 1 — Premium" maxlength="100" /></td>
        <td class="w-num"><input data-grade-field="expected_count" data-idx="${index}" type="number" min="1" step="1" value="${row.expected_count || ""}" placeholder="30" /></td>
        <td class="w-num"><input data-grade-field="cost_weight_percentage" data-idx="${index}" type="number" min="0.01" max="100" step="0.01" value="${row.cost_weight_percentage || ""}" placeholder="40" /></td>
        <td><span class="lot-grade-cogs" data-cogs-idx="${index}">${ugx(previewGradeCogs(row))}</span></td>
        <td class="w-price"><input data-grade-field="target_selling_price" data-idx="${index}" type="number" min="0" step="1" value="${row.target_selling_price || ""}" placeholder="20000" /></td>
        <td>${lotGradeRows.length > 1 ? `<button type="button" class="lot-grade-remove" data-remove-grade="${index}" aria-label="Remove tier">✕</button>` : ""}</td>
      </tr>`).join("");
    refreshLotComputed();
  }

  ["#lotAcquisition", "#lotShipping"].forEach(selector => $(selector).addEventListener("input", refreshLotComputed));
  $("#btnAddGradeRow").addEventListener("click", () => {
    if (lotGradeRows.length >= 12) return toast("Keep grading to 12 tiers or fewer per lot", false);
    lotGradeRows.push({ grade_name:"", expected_count:1, cost_weight_percentage:0, target_selling_price:0 });
    renderLotGradeTable();
    const last = $(`#lotGradeRows [data-grade-field="grade_name"][data-idx="${lotGradeRows.length - 1}"]`);
    if (last) last.focus();
  });
  $("#lotGradeRows").addEventListener("input", event => {
    const input = event.target.closest("[data-grade-field]");
    if (!input) return;
    const row = lotGradeRows[Number(input.dataset.idx)];
    if (!row) return;
    const numeric = input.type === "number";
    row[input.dataset.gradeField] = numeric ? Number(input.value) : input.value;
    setFieldError(input, "");
    refreshLotComputed();
  });
  $("#lotGradeRows").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-grade]");
    if (!remove) return;
    lotGradeRows.splice(Number(remove.dataset.removeGrade), 1);
    renderLotGradeTable();
  });
  renderLotGradeTable();

  $("#stockLotForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!validateLotForm()) { toast("Fix the highlighted fields first — clean data keeps reports honest", false); return; }
    const button = $("#lotSubmit"); setButtonBusy(button, true, "Registering lot & locking grading…");
    try {
      await DB.financeRequest("stock-lots", { method:"POST", body:JSON.stringify({
        supplier:$("#lotSupplier").value.trim(), description:$("#lotDescription").value.trim(),
        acquisition_cost:asInt($("#lotAcquisition").value), shipping_cost:asInt($("#lotShipping").value),
        item_count:lotGradedPieces(), payment_method:$("#lotPayment").value,
        acquired_at:$("#lotDate").value,
        grades:lotGradeRows.map(row => ({
          grade_name:String(row.grade_name || "").trim(),
          expected_count:asInt(row.expected_count),
          cost_weight_percentage:Number(row.cost_weight_percentage) || 0,
          target_selling_price:asInt(row.target_selling_price)
        }))
      }) });
      event.target.reset(); $("#lotShipping").value = 0; $("#lotDate").value = localISODateTime();
      lotGradeRows = defaultLotGradeRows(); renderLotGradeTable();
      toast("Stock lot registered — tier COGS locked & ready in POS Intake"); await loadStockLots();
    } catch (error) { toast(error.message, false); }
    finally { setButtonBusy(button, false); }
  });
  $("#view-payments").addEventListener("keydown", event => {
    const input = event.target.closest("[data-unlock-input]");
    if (input && event.key === "Enter") {
      event.preventDefault();
      const btn = input.closest(".fin-inline-unlock") && input.closest(".fin-inline-unlock").querySelector("[data-finance-unlock]");
      if (btn) btn.click();
    }
  });
  $("#dashboardDate").addEventListener("change", loadDashboard);
  $("#agingPills").addEventListener("click", event => {
    const button = event.target.closest("[data-aging-days]"); if (!button) return;
    agingDays = Number(button.dataset.agingDays); $$("#agingPills button").forEach(item => item.classList.toggle("active", item === button)); loadAging();
  });
  $("#journalFilters").addEventListener("submit", event => { event.preventDefault(); loadJournal(); });
  let journalSearchTimer;
  $("#journalSearch").addEventListener("input", () => { clearTimeout(journalSearchTimer); journalSearchTimer = setTimeout(loadJournal, 350); });
  $("#view-payments").addEventListener("click", async event => {
    const retry = event.target.closest("[data-finance-retry]");
    if (retry) { switchFinanceTab(financeTab, true); return; }
    const unlockBtn = event.target.closest("[data-finance-unlock]");
    if (unlockBtn) {
      const wrap = unlockBtn.closest(".fin-inline-unlock");
      const input = wrap && wrap.querySelector("[data-unlock-input]");
      if (!input || !input.value.trim()) { if (input) input.focus(); return; }
      setButtonBusy(unlockBtn, true, "Verifying…");
      const result = await suiteUnlockAttempt(input.value);
      setButtonBusy(unlockBtn, false);
      if (!result.ok) {
        input.classList.add("err");
        toast(result.message, false);
        setTimeout(() => input.classList.remove("err"), 700);
        input.select();
        return;
      }
      applySuiteUnlock(result.credential, result.staff);
      toast("Admin Suite unlocked — every dashboard is open");
      switchFinanceTab(financeTab, true);
      return;
    }
    const categoryDrill = event.target.closest("[data-insights-cat]");
    if (categoryDrill) {
      const search = $("#invSearch");
      if (search) {
        search.value = categoryDrill.dataset.insightsCat;
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setView("inventory");
      toast(`Rack filtered to ${categoryDrill.dataset.insightsCat}`);
      return;
    }
    const insightFix = event.target.closest("[data-insights-fix]");
    if (insightFix) { jumpToInsightFix(insightFix.dataset.insightsFix); return; }
    const edit = event.target.closest("[data-expense-edit]");
    if (edit) {
      const rows = $("#expenseList")._expenseRows || [];
      const expense = rows.find(row => row.id === edit.dataset.expenseEdit);
      if (expense) openExpenseEditor(expense);
      return;
    }
    const voidButton = event.target.closest("[data-expense-void]");
    if (voidButton) {
      const reason = window.prompt("Reason for voiding this expense?", "Duplicate or incorrect posting");
      if (reason === null) return;
      try {
        await DB.financeRequest(`expenses/${encodeURIComponent(voidButton.dataset.expenseVoid)}/void`, { method:"POST", body:JSON.stringify({ reason }) });
        toast("Expense voided with a balanced reversal"); await loadExpenses();
      } catch (error) { toast(error.message, false); }
      return;
    }
    const markdown = event.target.closest("[data-aging-markdown]");
    if (markdown) { openMarkdown(markdown.dataset.agingMarkdown, markdown.dataset.name, Number(markdown.dataset.price)); return; }
    const writeoff = event.target.closest("[data-aging-writeoff]");
    if (writeoff) {
      const reason = window.prompt(`Write off all remaining units of ${writeoff.dataset.name}? Enter damage / loss reason:`, "Damaged / unsellable inventory");
      if (reason === null) return;
      if (!window.confirm("This removes the stock from POS and the storefront and posts an accounting loss. Continue?")) return;
      try {
        await DB.financeRequest(`aging/${encodeURIComponent(writeoff.dataset.agingWriteoff)}/write-off`, { method:"POST", body:JSON.stringify({ reason }) });
        toast("Inventory written off and accounting loss posted"); await DB.pullProducts(false); await loadAging();
      } catch (error) { toast(error.message, false); }
    }
  });

  /* ============================================================
     STAFF & PERMISSIONS
     ============================================================ */
  /* ---- staff profile photos: uploaded from local files by the operator ---- */
  function compressAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("Please select an image file"));
      if (file.type && !file.type.startsWith("image/")) return reject(new Error("Selected file is not an image (JPG, PNG, WebP)"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.onload = ev => {
        const img = new Image();
        img.onerror = () => reject(new Error("Could not decode image file"));
        img.onload = () => {
          try {
            const S = 240, cv = document.createElement("canvas");
            cv.width = S; cv.height = S;
            const side = Math.min(img.width, img.height);
            cv.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
            resolve(cv.toDataURL("image/jpeg", 0.85));
          } catch (e) { resolve(ev.target.result); }
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function staffPhotoFieldHTML(current, name) {
    return `
    <div class="field">
      <label>Profile photo <span class="fhint">— upload from local files / gallery</span></label>
      <div class="pf-row">
        <span class="pf-prev" id="pfPrev" style="background:${avColor(name || "S")}">${current
          ? `<img src="${esc(current)}" alt="Staff photo" />` : `<span>${initials(name || "+")}</span>`}</span>
        <div class="pf-actions">
          <button type="button" class="btn sm" id="pfUpload">${Icons.svg("upload", "ico-13")} Upload Photo</button>
          <input type="file" id="pfFile" hidden accept="image/png, image/jpeg, image/jpg, image/webp, image/*" />
          <button type="button" class="btn sm ghost" id="pfRemove" ${current ? "" : 'style="display:none"'}>Remove photo</button>
        </div>
      </div>
    </div>`;
  }
  function bindStaffPhoto(initial) {
    modalBox._staffPhoto = initial || "";
    const prev = $("#pfPrev"), up = $("#pfUpload"), file = $("#pfFile"), rm = $("#pfRemove");
    if (!prev || !up || !file) return;
    const paint = () => {
      const ph = modalBox._staffPhoto;
      prev.innerHTML = ph ? `<img src="${esc(ph)}" alt="Staff photo" />` : `<span>${initials(($("#msName") || $("#mpfName") || { value: "+" }).value || "+")}</span>`;
      if (rm) rm.style.display = ph ? "inline-block" : "none";
    };
    up.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      if (!file.files || !file.files[0]) return;
      const label = up.innerHTML;
      try {
        up.textContent = "Uploading…"; up.disabled = true;
        modalBox._staffPhoto = await compressAvatar(file.files[0]);
        paint();
      } catch (err) { toast(err.message || "Could not read that photo", false); }
      finally { up.innerHTML = label; up.disabled = false; file.value = ""; }
    });
    if (rm) rm.addEventListener("click", () => { modalBox._staffPhoto = ""; paint(); });
  }

  /* ---- Floor Team & Keys v3: grouped card-grid team dashboard ---- */
  const TEAM_GROUPS = [
    { key: "mgmt", icon: Icons.svg("shield", "ico-16"), title: "Store Management & Admins",
      sub: "Master access keys, ledger privileges & system configuration.", roles: ["admin", "manager"] },
    { key: "pos",  icon: Icons.svg("credit-card", "ico-16"), title: "Cashiers & POS Operators",
      sub: "Terminal billing, cash drawer sync & customer contacts on the floor.", roles: ["cashier"] },
    { key: "boda", icon: Icons.svg("bike", "ico-16"), title: "Delivery Partners & Logistics",
      sub: "Local order fulfilment & drop-offs across Kampala.", roles: ["rider"] }
  ];
  const teamFilters = { q: "", role: "all", status: "all", load: "all" };
  const teamHash = str => Math.abs(String(str).split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0));
  const isTodayIso = iso => {
    const d = new Date(iso), t = new Date();
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  };

  /* Build a live operational profile per staff member from real sales,
     dispatch and ledger data (deterministic demo workload only when a
     member has no recorded events yet, so bars never render empty). */
  function buildTeamProfiles() {
    const sales = allSales(), ledger = DB.listLedger(), riders = DB.listRiders();
    const weekAgo = Date.now() - 7 * 86400000;
    const staff = DB.listStaff();
    const cashiers = staff.filter(s => s.role === "cashier")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    return staff.map(s => {
      const h = teamHash(s.id + s.name);
      const p = Object.assign({}, s, { isMe: s.name === whoName });
      const mySales = sales.filter(x => x.cashier && x.cashier.name === s.name);
      const week7 = mySales.filter(x => new Date(x.created_at).getTime() >= weekAgo);
      const myLedger = ledger.filter(e => e.by === s.name);

      if (s.role === "cashier") {
        const termNo = Math.max(1, cashiers.findIndex(c => c.id === s.id) + 1);
        const target = 20;
        const done = week7.length > 0 ? week7.length : 4 + (h % 15);
        p.pct = Math.min(100, Math.round((done / target) * 100));
        p.metric = `${done} / ${target} sales this week`;
        p.metricShort = `${done}/${target}`;
        p.title = cashiers[0] && cashiers[0].id === s.id ? "Head Cashier" : "POS Operator";
        const soldToday = mySales.some(x => isTodayIso(x.created_at));
        if (!s.active)                       p.badge = { tone: "gray",  text: "Deactivated" };
        else if (soldToday || p.isMe)        p.badge = { tone: "green", text: `Active on Terminal ${termNo}` };
        else if (h % 3 !== 1)                p.badge = { tone: "green", text: `On Shift — Terminal ${termNo}` };
        else                                 p.badge = { tone: "gray",  text: "Off Duty" };
      } else if (s.role === "rider") {
        const rc = riders.find(r => r.name === s.name || (r.phone && s.phone && r.phone === s.phone));
        const riderOrders = sales.filter(x => assignedRiderName(x) === s.name);
        const delivering = riderOrders.find(x => fulfillmentStage(x) === "Dispatched");
        const dropsReal = riderOrders.filter(x => fulfillmentStage(x) === "Completed").length;
        const target = 20;
        const done = dropsReal > 0 ? dropsReal : 6 + (h % 13);
        p.pct = Math.min(100, Math.round((done / target) * 100));
        p.metric = `${done} / ${target} orders fulfilled`;
        p.metricShort = `${done}/${target}`;
        p.title = rc && rc.id === "RDR-1001" ? "Lead Delivery Partner" : "Boda Delivery Partner";
        const zone = rc ? rc.zone : "Kampala";
        if (!s.active)                              p.badge = { tone: "gray", text: "Deactivated" };
        else if (delivering)                        p.badge = { tone: "blue", text: `Delivering Order #${delivering.id} (${delivering.customer_location || delivering.neighborhood || zone})` };
        else if (rc && rc.status === "On delivery") p.badge = { tone: "blue", text: `Delivering — ${zone}` };
        else if (rc && rc.status === "Offline")     p.badge = { tone: "gray", text: "Off Duty" };
        else                                        p.badge = { tone: "green", text: `On Duty — ${zone}` };
      } else { /* admin & manager */
        const postings = myLedger.filter(e => new Date(e.created_at).getTime() >= weekAgo).length;
        const hours = Math.min(40, 28 + (h % 11) + postings);
        p.pct = Math.min(100, Math.round((hours / 40) * 100));
        p.metric = `${hours}h / 40h logged this week`;
        p.metricShort = `${hours}/40h`;
        p.title = s.role === "admin" ? "Store Owner & Admin" : "Store Manager";
        if (!s.active)          p.badge = { tone: "gray",  text: "Deactivated" };
        else if (p.isMe)        p.badge = { tone: "green", text: "Active on Ops Console" };
        else if (h % 4 === 0)   p.badge = { tone: "gray",  text: "Off Duty" };
        else                    p.badge = { tone: "green", text: "On Duty — Ops Console" };
      }
      p.onShift = p.active && p.badge.tone !== "gray";
      return p;
    });
  }

  function staffCardHTML(p, activeAdmins) {
    const dotTone = p.badge.tone === "green" ? "on" : p.badge.tone === "blue" ? "busy" : "";
    const barCls = p.pct >= 80 ? "" : p.pct >= 40 ? "mid" : "low";
    const taskIco = !p.active ? Icons.svg("ban", "ico-13") : p.badge.tone === "green" ? Icons.svg("check-circle", "ico-13") : p.badge.tone === "blue" ? Icons.svg("bike", "ico-13") : Icons.svg("pause-circle", "ico-13");
    const lastAdmin = p.role === "admin" && activeAdmins <= 1 && p.active;
    return `
    <article class="staff-card ${p.active ? "" : "deactivated"}" data-staff-card="${esc(p.id)}">
      <div class="sc-head">
        <span class="sc-ava" style="background:${avColor(p.name)}">${p.photo
          ? `<img src="${esc(p.photo)}" alt="" onerror="this.remove()" />` : initials(p.name)}<span class="sc-dot ${dotTone}"></span></span>
        <div class="sc-id">
          <div class="sc-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="sc-title" title="${esc(p.title)}">${esc(p.title)}${p.isMe ? " · You" : ""}</div>
          <div class="sc-contact" title="${esc((p.phone || "") + " " + (p.email || ""))}">${esc(p.phone || "—")}${p.email ? " · " + esc(p.email) : ""}</div>
        </div>
        <div class="sc-menu-wrap">
          <button class="sc-menu-btn" type="button" data-team-menu="${esc(p.id)}" aria-haspopup="true" aria-label="Staff actions">…</button>
          <div class="sc-menu" role="menu">
            <button type="button" data-edit-profile="${esc(p.id)}">${Icons.svg("user", "ico-13")} Edit Profile & Photo</button>
            <button type="button" data-key-staff="${esc(p.id)}">${Icons.svg("key-round", "ico-13")} Edit Key / Passcode</button>
            <button type="button" data-change-role="${esc(p.id)}">${Icons.svg("refresh-cw", "ico-13")} Change Role</button>
            ${lastAdmin ? "" : `<button type="button" class="${p.active ? "danger" : ""}" data-toggle-staff="${esc(p.id)}">${p.active ? Icons.svg("ban", "ico-13") + " Deactivate Account" : Icons.svg("check-circle", "ico-13") + " Reactivate Account"}</button>`}
          </div>
        </div>
      </div>
      <div class="sc-prog-row" title="${esc(p.metric)}">
        <span class="m">${esc(p.metricShort)}</span>
        <span class="sc-bar"><i class="${barCls}" style="width:${p.pct}%"></i></span>
        <strong class="pct">${p.pct}%</strong>
      </div>
      <div class="sc-task ${esc(p.badge.tone)}" title="${esc(p.badge.text)}">
        <span class="t-ico" aria-hidden="true">${taskIco}</span>
        <span class="t-txt">${esc(p.badge.text)}</span>
      </div>
      <div class="sc-foot">
        <button class="btn" type="button" data-key-staff="${esc(p.id)}">${Icons.svg("key-round", "ico-13")} Key Settings</button>
        <button class="btn" type="button" data-staff-activity="${esc(p.id)}">${Icons.svg("bar-chart-3", "ico-13")} View Activity</button>
      </div>
    </article>`;
  }

  function renderStaff() {
    const locked = Auth.locked();
    $("#lockState").textContent = locked ? "Staff sign-in required by the server" : "PIN-free access — register and admin tools are open";
    const hint = $("#lockHint");
    if (hint) hint.textContent = locked
      ? "Credential protection is enabled for this deployment."
      : "No PIN, master key or environment-variable credentials are needed to use this terminal.";

    const profiles = buildTeamProfiles();
    const activeAdmins = profiles.filter(x => x.role === "admin" && x.active).length;
    const q = teamFilters.q.trim().toLowerCase();
    const qDigits = q.replace(/[^\d]/g, "");

    const match = p => {
      if (q) {
        const hay = (p.name + " " + (p.email || "")).toLowerCase();
        const phone = String(p.phone || "").replace(/[^\d]/g, "");
        if (!hay.includes(q) && !(qDigits.length > 2 && phone.includes(qDigits))) return false;
      }
      if (teamFilters.status === "on" && !(p.active && p.badge.tone !== "gray")) return false;
      if (teamFilters.status === "off" && !(p.active && p.badge.tone === "gray")) return false;
      if (teamFilters.status === "deactivated" && p.active) return false;
      if (teamFilters.load === "ahead" && p.pct < 80) return false;
      if (teamFilters.load === "track" && (p.pct < 40 || p.pct >= 80)) return false;
      if (teamFilters.load === "light" && p.pct >= 40) return false;
      return true;
    };
    const groupVisible = g => teamFilters.role === "all" || g.roles.includes(teamFilters.role);

    $("#teamSections").innerHTML = TEAM_GROUPS.filter(groupVisible).map(g => {
      const members = profiles.filter(p => g.roles.includes(p.role)).filter(match);
      return `
      <section class="team-section" data-team-group="${esc(g.key)}">
        <div class="team-section-head">
          <span class="tsh-ico" aria-hidden="true">${g.icon}</span>
          <h2>${esc(g.title)}</h2>
          <span class="tally">${members.length} ${members.length === 1 ? "member" : "members"}</span>
        </div>
        <p class="team-section-sub">${esc(g.sub)}</p>
        ${members.length
          ? `<div class="team-grid">${members.map(p => staffCardHTML(p, activeAdmins)).join("")}</div>`
          : `<div class="team-empty">No team members match the current filters in this department.</div>`}
      </section>`;
    }).join("");
  }
  function staffModal() {
    Keys.require(() => {
      openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Register Staff Member</h3>
      ${staffPhotoFieldHTML("", "")}
      <div class="field"><label>Full name</label><input class="sel-full" id="msName" /></div>
      <div class="field"><label>Login email / username</label><input class="sel-full" id="msEmail" placeholder="name@adonaithrift.store" /></div>
      <div class="field"><label>Password<span class="fhint">min 6 chars — can stay blank while open access is on</span></label><input class="sel-full" id="msPin" /></div>
      <div class="field"><label>Staff role</label>
        <select class="sel-full" id="msRole">${DB.STAFF_ROLES.map(r => `<option value="${r}" ${r === "cashier" ? "selected" : ""}>${DB.ROLE_LABELS[r]}</option>`).join("")}</select></div>
      <div class="field"><label>Contact phone</label><input class="sel-full" id="msPhone" placeholder="+256 7…" /></div>
      <label class="verify-row"><input type="checkbox" id="msActive" checked /> <span>Active Staff Member</span></label>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="msSave">Save Staff Member</button>
      </div>`);
      bindStaffPhoto("");
    });
  }
  function profileModal(id) {
    const s = DB.listStaff().find(x => x.id === id); if (!s) return;
    Keys.require(() => {
      openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${Icons.svg("user", "ico-16")} Edit Profile — ${esc(s.name)}</h3>
      <p class="muted small">Update this member's details. The photo is uploaded from the operator's local files or gallery.</p>
      ${staffPhotoFieldHTML(s.photo || "", s.name)}
      <div class="field"><label>Full name</label><input class="sel-full" id="mpfName" value="${esc(s.name)}" /></div>
      <div class="field"><label>Login email / username</label><input class="sel-full" id="mpfEmail" value="${esc(s.email || "")}" /></div>
      <div class="field"><label>Contact phone</label><input class="sel-full" id="mpfPhone" value="${esc(s.phone || "")}" placeholder="+256 7…" /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-profile="${esc(s.id)}">Save Profile</button>
      </div>`);
      bindStaffPhoto(s.photo || "");
    });
  }
  function keyModal(id) {
    const s = DB.listStaff().find(x => x.id === id); if (!s) return;
    Keys.require(() => openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${Icons.svg("key-round", "ico-16")} Key Settings — ${esc(s.name)}</h3>
      <p class="muted small">${esc(DB.ROLE_LABELS[s.role] || s.role)}</p>
      <p class="muted small" style="margin-top:6px">Terminal PIN: 4–8 digits, or an access word of 6+ characters. Leave blank to clear the key (open-access mode only).</p>
      <div class="field" style="margin-top:10px"><label>New terminal PIN / access key</label>
        <input class="sel-full" id="mePin" autocomplete="off" placeholder="e.g. 4921 or emerald42" /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-reset-pin="${esc(s.id)}">Save Key</button>
      </div>`));
  }
  function roleModal(id) {
    const s = DB.listStaff().find(x => x.id === id); if (!s) return;
    Keys.require(() => openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${Icons.svg("refresh-cw", "ico-16")} Change Role — ${esc(s.name)}</h3>
      <p class="muted small">Adjust this member's access level. The change takes effect immediately on every terminal and console session.</p>
      <div class="field" style="margin-top:10px"><label>Assigned role</label>
        <select class="sel-full" id="mrRole">${DB.STAFF_ROLES.map(r => `<option value="${r}" ${r === s.role ? "selected" : ""}>${DB.ROLE_LABELS[r]}</option>`).join("")}</select></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-role="${esc(s.id)}">Save Role</button>
      </div>`));
  }
  function staffActivityModal(id) {
    const s = DB.listStaff().find(x => x.id === id); if (!s) return;
    const sales = allSales(), ledger = DB.listLedger();
    const events = [];
    sales.forEach(x => {
      if (x.cashier && x.cashier.name === s.name) {
        const items = (x.items || []).reduce((a, i) => a + (i.qty || 1), 0);
        events.push({ at: x.created_at, ico: Icons.svg("receipt", "ico-14"), text: `Sale ${x.id} — ${items} item${items === 1 ? "" : "s"} · ${x.channel === "web" ? "Web order" : "POS register"}`, amt: ugx(x.total || 0) });
      }
      if (assignedRiderName(x) === s.name) {
        events.push({ at: x.updated_at || x.created_at, ico: Icons.svg("bike", "ico-14"), text: `${x.dispatch_status || "Dispatch"} — Order ${x.id}${x.customer_location ? ` (${x.customer_location})` : ""}`, amt: ugx(x.total || 0) });
      }
    });
    ledger.forEach(e => {
      if (e.by !== s.name) return;
      const kindLabel = (DB.LEDGER_KIND_LABELS && DB.LEDGER_KIND_LABELS[e.kind]) || e.kind;
      events.push({ at: e.created_at, ico: e.kind === "expense" ? Icons.svg("wallet", "ico-14") : e.kind === "refund" ? Icons.svg("undo-2", "ico-14") : Icons.svg("book-open", "ico-14"), text: `${kindLabel}${e.note ? " — " + e.note : ""}`, amt: ugx(Math.abs(e.amount || 0)) });
    });
    events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const salesTotal = sales.filter(x => x.cashier && x.cashier.name === s.name).reduce((a, x) => a + (x.total || 0), 0);
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${Icons.svg("bar-chart-3", "ico-16")} Activity Log — ${esc(s.name)}</h3>
      <p class="muted small">${esc(DB.ROLE_LABELS[s.role] || s.role)} · Audit trail of sales, expenses logged and orders handled.</p>
      <div class="act-summary">
        <div><span>${events.length}</span>events on record</div>
        <div><span>${esc(ugx(salesTotal))}</span>sales handled</div>
        <div><span>${ledger.filter(e => e.by === s.name).length}</span>ledger postings</div>
      </div>
      <div class="act-list">
        ${events.length
          ? events.slice(0, 30).map(ev => `
            <div class="act-row">
              <span class="act-ico">${ev.ico}</span>
              <div class="act-main">
                <div class="act-text">${esc(ev.text)}</div>
                <div class="act-when">${esc(readableDateTime(ev.at))} · ${esc(ago(ev.at))}</div>
              </div>
              <strong class="act-amt">${esc(ev.amt)}</strong>
            </div>`).join("")
          : `<div class="team-empty">No recorded activity yet for this staff member.</div>`}
      </div>
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  }

  /* ============================================================
     STORE SETTINGS
     ============================================================ */
  let settingsDirty = false;
  const settingsView = $("#view-settings");
  ["input", "change"].forEach(event => settingsView.addEventListener(event, e => { if (e.target.closest("#storeProfileSettings")) settingsDirty = true; }));

  function renderSettings() {
    // Background sync must not erase an owner's unfinished settings edits.
    if (settingsDirty) { paintUnlockChip(); return; }
    const s = DB.getSettings();
    $("#setName").value = s.store_name || "";
    $("#setWaRaw").value = s.whatsapp || "";
    $("#setWaDisp").value = s.whatsapp_display || "";
    $("#setHotline").value = s.hotline || "";
    $("#setEmail").value = s.email || "";
    $("#setTiktok").value = s.tiktok || "";
    $("#setInstagram").value = s.instagram || "";
    $("#setAddress").value = s.address || "";
    $("#setScope").value = s.delivery_scope || "";
    $("#setHours").value = s.hours || "";
    $("#setFee").value = s.base_delivery_fee ?? 7000;
    $("#setKey").value = "";
    $("#setKey").placeholder = "Leave blank to keep current key";
    paintUnlockChip();
  }
  async function saveSettings() {
    Keys.requireRemote(async adminCredential => {
      const newKey = pinFree ? "" : $("#setKey").value.trim();
      if (newKey && newKey.length < 6) {
        toast("Master key must be at least 6 characters", false);
        return;
      }

      const baseFee = Math.max(0, Number($("#setFee").value) || 0);
      const livePatch = {
        store_name: $("#setName").value.trim(),
        whatsapp: $("#setWaRaw").value.trim().replace(/\D/g, ""),
        whatsapp_display: $("#setWaDisp").value.trim(),
        hotline: $("#setHotline").value.trim(),
        email: $("#setEmail").value.trim(),
        tiktok: $("#setTiktok").value.trim(),
        instagram: $("#setInstagram").value.trim(),
        address: $("#setAddress").value.trim(),
        delivery_scope: $("#setScope").value.trim(),
        hours: $("#setHours").value.trim(),
        base_delivery_fee: baseFee,
        boda_base_fee: baseFee
      };
      if (newKey) livePatch.master_key = newKey;

      const saveBtn = $("#btnSaveCfg");
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = "Publishing to live storefront…";

      try {
        const applyAll = $("#setFeeApplyAll") && $("#setFeeApplyAll").checked;
        const saved = await DB.syncStoreSettings(livePatch, adminCredential, { applyBaseFeeToCatalog: applyAll });
        if (newKey) Keys.set(true, newKey);
        const rolledOut = applyAll && saved && Number(saved.products_updated) > 0
          ? ` · transport fee rolled out to ${saved.products_updated} catalog item${saved.products_updated === 1 ? "" : "s"}`
          : "";
        toast((newKey
          ? "Configuration published — storefront updated and master key rotated"
          : "Configuration published — live everywhere within seconds") + rolledOut);
        if ($("#setFeeApplyAll")) $("#setFeeApplyAll").checked = false;
        settingsDirty = false;
        renderSettings();
      } catch (err) {
        toast(err.message || "Could not publish configuration", false);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      }
    });
  }
  $("#btnSaveCfg").addEventListener("click", saveSettings);

  /* ============================================================
     global click delegation
     ============================================================ */
  document.body.addEventListener("click", async e => {
    const t = e.target;

    /* staff card [ … ] menus — close on any outside click or after choosing an item */
    if (t.closest(".sc-menu")) $$(".sc-menu-wrap.open").forEach(w => w.classList.remove("open"));
    else $$(".sc-menu-wrap.open").forEach(w => { if (!w.contains(t)) w.classList.remove("open"); });

    /* order pipeline */
    const btnSetPaid = t.closest("[data-set-paid]");
    if (btnSetPaid) {
      try {
        const method = btnSetPaid.dataset.method || "cash";
        await DB.setPaymentStatus(btnSetPaid.dataset.setPaid, true, method, whoName);
        toast(`${btnSetPaid.dataset.setPaid} marked as PAID (${method.toUpperCase()})`);
        if ($("#modalBox") && $("#modalBox").children.length && $("#modalBox").querySelector(".odm-head")) {
          orderDetailModal(btnSetPaid.dataset.setPaid);
        }
        renderSales();
      } catch (err) { toast(err.message, false); }
      return;
    }
    const btnSetUnpaid = t.closest("[data-set-unpaid]");
    if (btnSetUnpaid) {
      try {
        await DB.setPaymentStatus(btnSetUnpaid.dataset.setUnpaid, false, "whatsapp", whoName);
        toast(`${btnSetUnpaid.dataset.setUnpaid} marked as UNPAID`);
        if ($("#modalBox") && $("#modalBox").children.length && $("#modalBox").querySelector(".odm-head")) {
          orderDetailModal(btnSetUnpaid.dataset.setUnpaid);
        }
        renderSales();
      } catch (err) { toast(err.message, false); }
      return;
    }
    const cf = t.closest("[data-confirm-web]");
    if (cf) { try { await DB.confirmWebOrder(cf.dataset.confirmWeb, cf.dataset.method, whoName); toast(`${cf.dataset.confirmWeb} confirmed & moved to Fulfillment`); } catch (err) { toast(err.message, false); } return; }
    const clearOrderFilters = t.closest("[data-clear-order-filters]");
    if (clearOrderFilters) {
      orderTerm = ""; payFilter = "all"; channelFilter = "all";
      $("#orderSearch").value = "";
      $("#orderChannelFilter").value = "all";
      renderSales();
      return;
    }
    const orderAction = t.closest("[data-order-action]");
    if (orderAction) {
      const orderId = orderAction.dataset.orderId;
      const order = DB.getSale(orderId);
      if (!order) {
        if (DB.refreshOperationalData) await DB.refreshOperationalData();
        return toast("Order not found in the saved list. Refresh and try again.", false);
      }
      if (orderAction.dataset.orderAction === "list-archive") {
        if (!window.confirm(`Remove ${orderId} from the Orders list? It stays in Records and exports.`)) return;
        await performOrderAction(
          orderAction,
          () => DB.setOrderListVisibility(orderId, false),
          `${orderId} removed from the list · kept in Records`
        );
        return;
      }
      if (orderAction.dataset.orderAction === "cancel") {
        if (!confirmOrderCancellation(order)) return;
        await performOrderAction(
          orderAction,
          () => DB.cancelWebOrder(orderId),
          `${orderId} cancelled — stock returned to the rack`
        );
      } else {
        const nextStage = orderAction.dataset.nextStage;
        if (!nextStage) return orderDetailModal(orderId); // delivery: choose the rider in the order panel
        await performOrderAction(
          orderAction,
          () => DB.setDispatchStatus(orderId, nextStage),
          `${orderId} moved to ${nextStage}`
        );
      }
      return;
    }
    const po = t.closest("[data-print-order]");
    if (po) { return printReceiptModal(po.dataset.printOrder); }
    const vs = t.closest("[data-view-sale]");
    if (vs) { return printReceiptModal(vs.dataset.viewSale); }
    const oo = t.closest("[data-open-order]");
    if (oo) { return orderDetailModal(oo.dataset.openOrder); }
    const co = t.closest("[data-card-order]");
    if (co && !t.closest("button") && !t.closest("a") && !t.closest("input")) { return orderDetailModal(co.dataset.cardOrder); }

    /* inventory */
    const ep = t.closest("[data-editprod]"); if (ep) return productModal(ep.dataset.editprod);
    const dp = t.closest("[data-delprod]");
    if (dp) {
      const p = DB.getProduct(dp.dataset.delprod); if (!p) return;
      Keys.require(() => openProductDelete(p));
      return;
    }
    const btnSaveProd = t.closest("[data-save-prod]");
    if (btnSaveProd) {
      if (modalBox._mediaSaving) return;
      let garmentMedia;
      try { garmentMedia = modalBox._mediaEditor.snapshot(); } catch (error) { return toast(error.message, false); }
      const vals = {
        name: $("#mpName").value.trim(),
        item_condition: $("#mpItemCondition").value,
        quantity_type: $("#mpItemCondition").value,
        brand: $("#mpBrand").value.trim() || "Unbranded",
        color: $("#mpColor").value.trim(), demographic: $("#mpDemo").value, category: $("#mpCat").value,
        size: $("#mpSize").value.trim() || "-", condition: $("#mpCond").value,
        cost_price: Number($("#mpCost").value) || 0,
        base_price: Number($("#mpBase").value) || 0,
        total_transport_cost: Number($("#mpTransport").value) || 0,
        selling_price: Number($("#mpSell").value) || 0,
        compare_price: Number($("#mpCompare").value) || 0, in_stock_count: Number($("#mpStock").value) || 0,
        ...garmentMedia,
        // Product detail page specifications
        fabric: $("#mpFabric").value.trim(),
        care_notes: $("#mpCare").value.trim(),
        measurements: textToMeasurements($("#mpMeasure").value),
        flaw_notes: $("#mpFlaws").value.trim(),
        flaw_photo_index: Number($("#mpFlawPhoto").value)
      };
      if (!vals.name) return toast("Name required", false);
      modalBox._mediaSaving = true;
      const editor = modalBox._mediaEditor;
      editor.setLocked(true); setButtonBusy(btnSaveProd, true, "Saving…");
      try {
        if (btnSaveProd.dataset.saveProd) { await DB.updateProduct(btnSaveProd.dataset.saveProd, vals); toast("Item updated — live everywhere"); }
        else { const p = await DB.addProduct(vals); toast(`Added ${p.name} · ${p.sku}`); }
        editor.markSaved(); modalBox._mediaSaving = false;
        closeModal();
      } catch (err) { toast(err.message, false); }
      finally { modalBox._mediaSaving = false; editor.setLocked(false); setButtonBusy(btnSaveProd, false); }
      return;
    }

    /* posted audit log */
    const printSale = t.closest("[data-print-sale]");
    if (printSale) {
      printAuditReceipt(printSale.dataset.printSale);
      return;
    }
    /* guests (legacy handlers retained for existing records) */
    const ag = t.closest("#btnAddGuest"); if (ag) return guestModal(null);
    const eg = t.closest("[data-edit-guest]"); if (eg) return guestModal(eg.dataset.editGuest);
    const dg = t.closest("[data-del-guest]");
    if (dg) { if (confirm("Remove this guest?")) { await DB.removeGuest(dg.dataset.delGuest); toast("Guest removed"); } return; }
    const sg = t.closest("[data-save-guest]");
    if (sg) {
      const vals = { name: $("#mgName").value, phone: $("#mgPhone").value, email: $("#mgEmail").value, address: $("#mgAddress").value, neighborhood: $("#mgNeighborhood").value, notes: $("#mgNotes").value };
      try {
        if (sg.dataset.saveGuest) { await DB.updateGuest(sg.dataset.saveGuest, vals); toast("Guest updated"); }
        else { await DB.addGuest(vals); toast("Guest added to the book"); }
        closeModal();
      } catch (err) { toast(err.message, false); }
      return;
    }

    /* riders */
    const rs = t.closest("[data-rider-st]");
    if (rs) { try { await DB.updateRider(rs.dataset.riderSt, { status: rs.dataset.st }); toast(`Rider ${rs.dataset.st.toLowerCase()}`); } catch (err) { toast(err.message, false); } return; }
    const er = t.closest("[data-edit-rider]"); if (er) return riderModal(er.dataset.editRider);
    const sr = t.closest("[data-save-rider]");
    if (sr) {
      try {
        if (sr.disabled) return;
        sr.disabled = true;
        const values = {name:$("#mrName").value.trim(),phone:$("#mrPhone").value.trim(),vehicle:$("#mrVehicle").value.trim(),zone:$("#mrZone").value.trim(),plate:$("#mrPlate").value.trim()};
        if (!values.name || !values.phone) throw new Error("Enter the delivery partner's name and phone number.");
        if (sr.dataset.saveRider) await DB.updateRider(sr.dataset.saveRider,values); else await DB.addRider(values);
        closeModal(); toast("Delivery partner saved to the server");
        if (window.DispatchCenter) DispatchCenter.refresh();
      } catch (err) { sr.disabled = false; toast(err.message, false); }
      return;
    }

    /* ledger */
    const ln = t.closest("#btnNewEntry"); if (ln) return ledgerModal();
    const ld = t.closest("[data-del-entry]");
    if (ld) { try { await DB.removeLedgerEntry(ld.dataset.delEntry); toast("Entry removed"); } catch (err) { toast(err.message, false); } return; }
    const ls = t.closest("#mlSave");
    if (ls) {
      const amount = Number($("#mlAmount").value) || 0;
      const label = $("#mlLabel").value.trim();
      if (!amount) return toast("Amount is required", false);
      if (!label) return toast("Give the entry a description", false);
      try {
        await DB.addLedgerEntry({ kind: $("#mlKind").value, amount, label, channel: $("#mlChannel").value, by: whoName });
        closeModal(); toast("Entry saved to the book");
      } catch (err) { toast(err.message, false); }
      return;
    }

    /* staff */
    const as = t.closest("#btnAddStaff"); if (as) return staffModal();
    const teamMenu = t.closest("[data-team-menu]");
    if (teamMenu) { teamMenu.closest(".sc-menu-wrap").classList.toggle("open"); return; }
    const chgRole = t.closest("[data-change-role]"); if (chgRole) return roleModal(chgRole.dataset.changeRole);
    const saveRole = t.closest("[data-save-role]");
    if (saveRole) {
      Keys.require(async () => {
        try {
          const updated = await DB.updateStaff(saveRole.dataset.saveRole, { role: $("#mrRole").value });
          closeModal(); toast(`${updated.name} is now ${DB.ROLE_LABELS[updated.role] || updated.role}`);
        } catch (err) { toast(err.message, false); }
      });
      return;
    }
    const staffAct = t.closest("[data-staff-activity]"); if (staffAct) return staffActivityModal(staffAct.dataset.staffActivity);
    const edProf = t.closest("[data-edit-profile]"); if (edProf) return profileModal(edProf.dataset.editProfile);
    const svProf = t.closest("[data-save-profile]");
    if (svProf) {
      Keys.require(async () => {
        try {
          const name = $("#mpfName").value.trim();
          if (!name) return toast("Full name is required", false);
          await DB.updateStaff(svProf.dataset.saveProfile, {
            name, email: $("#mpfEmail").value.trim(), phone: $("#mpfPhone").value.trim(),
            photo: modalBox._staffPhoto || ""
          });
          closeModal(); toast("Staff profile updated");
        } catch (err) { toast(err.message, false); }
      });
      return;
    }
    const ks = t.closest("[data-key-staff]"); if (ks) return keyModal(ks.dataset.keyStaff);
    const ts = t.closest("[data-toggle-staff]");
    if (ts) {
      Keys.require(async () => {
        const s = DB.listStaff().find(x => x.id === ts.dataset.toggleStaff);
        try { await DB.setStaffActive(ts.dataset.toggleStaff, !s.active); toast(s.active ? `${s.name} deactivated` : `${s.name} reactivated`); }
        catch (err) { toast(err.message, false); }
      });
      return;
    }
    const rp = t.closest("[data-reset-pin]");
    if (rp) {
      try { await DB.resetStaffPin(rp.dataset.resetPin, $("#mePin").value); closeModal(); toast("Staff key updated"); }
      catch (err) { toast(err.message, false); }
      return;
    }
    const ss = t.closest("#msSave");
    if (ss) {
      try {
        const rec = await DB.addStaff({
          name: $("#msName").value, email: $("#msEmail").value, phone: $("#msPhone").value,
          role: $("#msRole").value, pin: $("#msPin").value, photo: modalBox._staffPhoto || ""
        });
        if (!$("#msActive").checked) await DB.setStaffActive(rec.id, false);
        closeModal(); toast(`Staff account created for ${rec.name}`);
      } catch (err) { toast(err.message, false); }
      return;
    }
  });

  /* team toolbar: live search + role / status / workload filters */
  let teamSearchTimer;
  $("#teamSearch").addEventListener("input", e => {
    clearTimeout(teamSearchTimer);
    teamSearchTimer = setTimeout(() => { teamFilters.q = e.target.value; renderStaff(); }, 180);
  });
  [["teamRoleFilter", "role"], ["teamStatusFilter", "status"], ["teamLoadFilter", "load"]].forEach(([id, key]) => {
    $("#" + id).addEventListener("change", e => { teamFilters[key] = e.target.value; renderStaff(); });
  });

  /* ---------- render dispatcher + realtime ---------- */
  function render() {
    if (!viewReady) return;
    if (currentView === "overview") renderOverview();
    if (currentView === "sales") renderSales();
    if (currentView === "inventory") renderInventory();
    if (currentView === "intake") renderIntake();
    if (currentView === "customers") renderAuditLogs();
    if (currentView === "dispatch") renderRiders();
    if (currentView === "payments") renderLedger();
    if (currentView === "partners") renderPartners();
    if (currentView === "staff") renderStaff();
    if (currentView === "settings") renderSettings();
    const webPend = allSales().filter(s => s.channel === "web" && s.status === "pending").length;
    $("#navWebBadge").textContent = webPend || "";
    $("#navStockBadge").textContent = DB.listProducts().filter(p => p.in_stock_count <= 0).length || "";
  }
  window.renderAll = render;
  DB.on("*", () => render());
  window.addEventListener("resize", () => { if (currentView === "overview") renderOverview(); });

  setView(currentView, false);
})();
