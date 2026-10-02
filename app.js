/* ============================================================
   ADONAI — OPERATIONS CONSOLE (admin.html)
   Warm screenshot system · all views live off the shared DB
   with guest book, riders, ledger, intake & Master Key gate.
   ============================================================ */
(function () {
  "use strict";
  // Every destination exposed by the POS drawer belongs to this operations
  // console, so any authenticated terminal user may open it. Destructive and
  // security-sensitive controls remain protected by the secondary Master Key.
  const me = Auth.guard({ role: null });
  if (Auth.locked() && !me) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ugx = DB.ugx;
  const AV_PALETTE = ["#7A2E2E", "#805322", "#2E5E40", "#374A7A", "#6B3A7A", "#22615E", "#4A5E22", "#8A3A22"];
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
  const openModal = html => { modalBox.innerHTML = html; backdrop.classList.add("open"); };
  const closeModal = () => { backdrop.classList.remove("open"); modalBox.innerHTML = ""; };
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
    require(cb) { if (this.unlocked()) return cb(masterCredential); renderMasterModal(cb); },
    requireRemote(cb) {
      if (masterCredential) return cb(masterCredential);
      const active = Auth.me();
      const token = Auth.token();
      if (active && active.role === "admin" && token) return cb(token);
      renderMasterModal(cb);
    }
  };
  function paintUnlockChip() {
    const c = $("#unlockChip");
    if (!c) return;
    if (Keys.unlocked()) { c.textContent = "🔓 Master Key Unlocked"; c.classList.add("on"); }
    else { c.textContent = "🔒 Unlock Master Key"; c.classList.remove("on"); }
  }
  function renderMasterModal(after) {
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Admin Master Key Authorization</h3>
      <p class="muted small" style="margin-bottom:14px">Enter secondary Master Key to unlock protected administrative controls, financial logs, and system settings.</p>
      <div class="sec-box">🔒 <strong>Security Upgrade:</strong> This action requires the secondary Admin Master Key Password to protect store permissions, financial records, and core parameters.</div>
      <div class="field" style="margin-top:14px">
        <label>Master key password</label>
        <div class="sku-row">
          <input id="mkInput" type="password" class="sel-full" placeholder="Enter master key password…" autocomplete="off" />
          <button class="btn sm ghost" id="mkShow" type="button">Show</button>
        </div>
        <p class="muted small" style="margin-top:6px">Default sandbox key is <code>${esc(DB.DEFAULT_MASTER_KEY)}</code></p>
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
        Keys.set(true, val); closeModal(); toast("🔓 Master Key unlocked for this session");
        if (after) after(val);
        return;
      }
      try {
        const authEndpoint = (typeof DB !== "undefined" && DB.apiUrl) ? DB.apiUrl("/api/auth/verify") : "/api/auth/verify";
        const r = await fetch(authEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: val, key: val, terminal_key: val })
        });
        const data = await r.json();
        if (data && data.ok && data.staff && data.staff.role === "admin") {
          const credential = data.token || val;
          Keys.set(true, credential); closeModal(); toast("🔓 Master Key unlocked via Server / Environment");
          if (after) after(credential);
          return;
        }
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
  $("#meRole").textContent = me ? "Role: " + me.role.toUpperCase() : "Roster seeded · keys unset";
  $("#meAvatar").textContent = initials(whoName);

  const btnAdminExit = $("#btnAdminExit");
  if (btnAdminExit) {
    btnAdminExit.addEventListener("click", () => {
      Auth.signOut();
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
  const VALID_VIEWS = ["overview", "sales", "inventory", "intake", "customers", "dispatch", "payments", "staff", "settings"];

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

  function setView(v, updateUrl = true) {
    if (!VALID_VIEWS.includes(v)) v = "overview";
    currentView = v;
    const routeAlreadyActive = new URLSearchParams(location.search).get("view") === v && !location.hash;
    if (updateUrl && !routeAlreadyActive) history.pushState({ view: v }, "", viewUrl(v));
    $$(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    shell.classList.remove("sb-open");
    render();
  }

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
  const fulfillmentStage = s => s.dispatch_status || (s.channel === "web" ? "Unfulfilled" : "Completed");
  const statusChip = s => laneChip(fulfillmentStage(s));
  const laneChip = d => {
    const map = {
      "Unfulfilled": ["pend", "UNFULFILLED"], "Pending": ["pend", "UNFULFILLED"],
      "In Assembly": ["blue", "IN ASSEMBLY"], "Ready for Pickup": ["amber", "READY FOR PICKUP"],
      "Dispatched": ["blue", "DISPATCHED"], "Completed": ["ok", "COMPLETED"],
      "Cancelled": ["bad", "CANCELLED"]
    };
    const [cls, txt] = map[d || "Unfulfilled"] || ["pend", String(d || "Unfulfilled").toUpperCase()];
    return `<span class="stat-chip ${cls}">${txt}</span>`;
  };
  const isOpenWebOrder = s => s.channel === "web" && !["completed", "cancelled"].includes(String(s.status || "").toLowerCase());
  /* KPI stat card — icon chip + accent tone + fluid responsive grid */
  function kpiCard(label, value, sub, tone, icon) {
    return `<div class="kpi-card kpi-${tone || "rust"}">
      <div class="kpi-top"><span class="kpi-ico">${icon || "📈"}</span><span class="kpi-lab">${esc(label)}</span></div>
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
      kpiCard("TODAY'S REVENUE (UGX)", ugx(todayRev), "Closed register & delivery sales", "green", "💰") +
      kpiCard("TODAY'S TICKETS", todayDone.filter(s => s.channel === "pos").length, "In-store POS & web reservations", "rust", "🧾") +
      kpiCard("ONLINE PENDING", webPend.length, "Awaiting packaging / rider", "amber", "📦") +
      kpiCard("ON THE RACK (PIECES)", onRack, `${reserved} reserved in orders`, "blue", "🔖");

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
      ctx.font = "9.5px 'Plus Jakarta Sans', sans-serif"; ctx.fillStyle = "#A08F83"; ctx.textAlign = "center";
      vals.forEach((v, i) => {
        const x = i * step + step / 2;
        const h = v ? Math.max(3, v / max * bh) : 2;
        ctx.fillStyle = v ? color : "#EFE7DC";
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x - 11, y0 + bh - h, 22, h, 4); ctx.fill(); }
        else ctx.fillRect(x - 11, y0 + bh - h, 22, h);
        ctx.fillStyle = "#A08F83";
        ctx.fillText(labels[i], x, y0 + bh + 13);
      });
    };
    drawRow(hVals, ["9a", "10a", "11a", "12p", "1p", "2p", "3p", "4p", "5p", "6p", "7p"], 10, 44, "#C24E2B");
    drawRow(dVals, days.map(d => ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()]), 88, 44, "#1A1410");

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
      ["Sold & Closed", soldQty, "#B8AC9E"]
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
      ["🏪 Register", revPos, "var(--rust)"], ["🌐 Web Storefront", revWeb, "var(--green)"], ["🖼️ Catalog", 0, "var(--blue)"]
    ].map(([lbl, v, color]) => `
      <div class="ch-row ch-stack">
        <div class="ch-info"><span>${lbl}</span><strong>${ugx(v)}</strong></div>
        <div class="ch-bar"><i style="width:${Math.round(v / revAll * 100)}%;background:${color}"></i></div>
      </div>`).join("")
      + `<span class="cash-pill">💵 Cash collected ${ugx(cashTot)}</span>`;

    /* ---- boda pool ---- */
    $("#riderPool").innerHTML = DB.listRiders().slice(0, 3).map(r => {
      const active = allSales().filter(s => s.assigned_rider_id === r.id && s.dispatch_status === "With rider").length;
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
     FULFILLMENT & ORDERS (pipeline lanes)
     ============================================================ */
  const LANES = [
    { key: "incoming", title: "Unfulfilled", sub: "New web orders awaiting processing" },
    { key: "fulfillment", title: "In Assembly", sub: "Items being picked and packed" },
    { key: "ready", title: "Ready / Dispatched", sub: "Ready for pickup or on the way" },
    { key: "completed", title: "Completed", sub: "Fulfilled and closed" }
  ];
  let activeLane = "incoming";
  let orderTerm = "";
  let payFilter = "all"; // 'all' | 'paid' | 'unpaid'

  function isSalePaid(s) {
    if (!s || !s.tender) return false;
    if (s.tender.paid === true) return true;
    if (s.tender.paid === false) return false;
    if (s.channel === "pos" && s.status === "completed") return true;
    if (s.tender.type === "cash" || s.tender.type === "mtn" || s.tender.type === "airtel") return true;
    return false;
  }

  $("#orderSearch").addEventListener("input", e => { orderTerm = e.target.value.trim().toLowerCase(); renderSales(); });

  function renderSales() {
    const sales = allSales();
    const webPend = sales.filter(isOpenWebOrder);
    $("#pendingLine").textContent = `${webPend.length} pending online orders in UGX. Automatic background polling active (every 5s).`;
    $("#navWebBadge").textContent = webPend.length || "";

    // Payment Filter Pills (All / Paid / Unpaid)
    const pPills = $("#payFilterPills");
    if (pPills) {
      const paidCount = sales.filter(isSalePaid).length;
      const unpaidCount = sales.filter(s => !isSalePaid(s)).length;
      pPills.innerHTML = [
        { key: "all", label: `All Orders (${sales.length})` },
        { key: "paid", label: `Paid (${paidCount})` },
        { key: "unpaid", label: `Unpaid (${unpaidCount})` }
      ].map(p => `<button class="dpill ${p.key === payFilter ? 'active' : ''}" data-pay-filter="${p.key}">${p.label}</button>`).join("");
      $$("#payFilterPills .dpill").forEach(b => b.addEventListener("click", () => {
        payFilter = b.dataset.payFilter;
        renderSales();
      }));
    }

    const filtered = sales.filter(s => {
      const matchSearch = !orderTerm || [s.id, s.customer_name, s.customer_phone].some(x => String(x || "").toLowerCase().includes(orderTerm));
      if (!matchSearch) return false;
      if (payFilter === "paid") return isSalePaid(s);
      if (payFilter === "unpaid") return !isSalePaid(s);
      return true;
    });

    $("#laneTabs").innerHTML = LANES.map(l => {
      const n = filtered.filter(s => DB.laneOf(s) === l.key).length;
      return `<button class="lane-tab ${l.key === activeLane ? "active" : ""}" data-lane="${l.key}">${l.title} (${n})</button>`;
    }).join("");
    $$("#laneTabs .lane-tab").forEach(b => b.addEventListener("click", () => { activeLane = b.dataset.lane; renderSales(); }));

    const lane = LANES.find(l => l.key === activeLane);
    const inLane = filtered.filter(s => DB.laneOf(s) === activeLane);
    $("#lanePanel").innerHTML = `
      <div class="lane-card">
        <div class="lane-head"><div><strong class="serif">${lane.title}</strong><div class="muted small">${lane.sub}</div></div><span class="lane-count">${inLane.length}</span></div>
        ${inLane.length ? inLane.map(orderCard).join("") : `<p class="lane-empty">Lane is clear.</p>`}
      </div>`;
  }

  function orderCard(s) {
    const paid = isSalePaid(s);
    const acts = [];
    const stage = fulfillmentStage(s);
    if (stage === "Unfulfilled" || stage === "Pending") {
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-dispatch-to="${esc(s.id)}" data-stage="In Assembly">Start Assembly →</button>
        <button class="btn sm" data-open-order="${esc(s.id)}">Order details</button>
        <button class="btn sm danger" data-cancel-web="${esc(s.id)}">Cancel</button></div>`);
    } else if (stage === "In Assembly" || stage === "Packed") {
      const readyStage = s.delivery_type === "pickup" ? "Ready for Pickup" : "Dispatched";
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-dispatch-to="${esc(s.id)}" data-stage="${readyStage}">Mark ${readyStage} →</button>
        <button class="btn sm" data-open-order="${esc(s.id)}">Order details</button></div>`);
    } else if (stage === "Ready for Pickup" || stage === "Dispatched" || stage === "With rider" || stage === "Handed over") {
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-dispatch-to="${esc(s.id)}" data-stage="Completed">Complete Order ✓</button>
        <button class="btn sm" data-open-order="${esc(s.id)}">Order details</button></div>`);
    } else {
      acts.push(`<div class="pay-row">
        <button class="btn sm" data-print-order="${esc(s.id)}">View receipt</button>
        <button class="btn sm ghost" data-open-order="${esc(s.id)}">Details</button></div>`);
    }
    return `<div class="order-card" data-card-order="${esc(s.id)}">
      <div class="oc-top">
        <strong class="serif">${esc(s.id)}</strong>
        ${s.channel === "web" ? `<span class="stat-chip web">WEB STORE</span>` : `<span class="stat-chip pos">REGISTER</span>`}
        ${laneChip(fulfillmentStage(s))}
        ${paid ? `<span class="stat-chip ok">PAID</span>` : `<span class="stat-chip pend">UNPAID</span>`}
        <span class="muted small oc-when">${ago(s.created_at)}</span>
      </div>
      <div class="oc-body">
        <div class="oc-customer">
          <span class="avatar oc-ava" style="background:${avColor(s.customer_name || "Guest")}">${initials(s.customer_name || "G")}</span>
          <div class="grow">
            <div class="oc-name">${esc(s.customer_name)}${s.customer_phone ? ` <a class="lnk oc-tel" href="tel:${esc(String(s.customer_phone).replace(/[^+0-9]/g, ""))}">📞 ${esc(s.customer_phone)}</a>` : ""}</div>
            <div class="muted small">${esc(itemsSummary(s))}</div>
          </div>
        </div>
        <strong class="oc-total serif">${ugx(s.total)}</strong>
      </div>
      ${acts.join("")}
    </div>`;
  }

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
          <div class="rc-sub">CURATED VINTAGE · KAMPALA</div>
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
                  <div class="rc-it-name">${esc(it.name)}</div>
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
              <span>Rider Delivery Fee</span>
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
        <button class="btn primary sm" id="btnTriggerPrint">🖨 Print 80mm</button>
      </div>
      ${receiptHTML(s)}
      <div class="modal-actions" style="margin-top:14px">
        <button class="btn ghost" data-close>Close</button>
        <button class="btn primary" id="btnTriggerPrint2">🖨 Print Receipt</button>
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
        ${s.assigned_rider_name ? `<span class="stat-chip blue">Rider: ${esc(s.assigned_rider_name)}</span>` : ''}
      </div>

      <div class="odm-section">
        <div class="odm-section-label">Order Items (1-of-1 Thrift)</div>
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
          <span>Rider Delivery Fee</span>
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
              <button class="btn sm primary" data-set-paid="${esc(s.id)}" data-method="cash">💰 Cash</button>
              <button class="btn sm" data-set-paid="${esc(s.id)}" data-method="mtn">📱 MTN MoMo</button>
              <button class="btn sm" data-set-paid="${esc(s.id)}" data-method="airtel">🔴 Airtel</button>
            ` : `
              <button class="btn sm ghost" data-set-unpaid="${esc(s.id)}">↩ Revert to Unpaid</button>
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
        <div class="field">
          <label>ASSIGN BODA RIDER</label>
          <select id="modalRiderSel" class="sel-full">
            ${riders.map(r => `
              <option value="${r.id}" ${s.assigned_rider_id === r.id ? "selected" : ""}>
                ${esc(r.name)} (${esc(r.zone)}) · ${esc(r.status.toUpperCase())}
              </option>
            `).join("")}
          </select>
        </div>

        ${fulfillmentStage(s) === "Unfulfilled" || fulfillmentStage(s) === "Pending" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="In Assembly">📦 Start Assembly</button>
        ` : fulfillmentStage(s) === "In Assembly" || fulfillmentStage(s) === "Packed" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="${s.delivery_type === "pickup" ? "Ready for Pickup" : "Dispatched"}">✓ Mark ${s.delivery_type === "pickup" ? "Ready for Pickup" : "Dispatched"}</button>
        ` : fulfillmentStage(s) === "Ready for Pickup" || fulfillmentStage(s) === "Dispatched" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="Completed">✓ Complete Order</button>
        ` : ""}

        <button class="btn ghost btn-full" id="btnCancelOrderModal">Cancel Order &amp; Release Item to Rack</button>
        <button class="btn light btn-full" id="btnPrintReceiptModal">🖨 Print Receipt</button>
      </div>
    `);

    const sel = $("#modalRiderSel");
    const btnDisp = $("#btnDispatchRider");
    if (btnDisp) {
      btnDisp.addEventListener("click", async () => {
        const riderId = sel ? sel.value : null;
        if (!riderId) return toast("Please select a rider", false);
        try {
          await DB.assignRiderToOrder(s.id, riderId);
          toast(`Order ${s.id} dispatched with rider`);
          closeModal();
          activeLane = "rider";
          renderSales();
        } catch (err) {
          toast(err.message, false);
        }
      });
    }

    const btnAdv = $("#btnAdvRider");
    if (btnAdv) {
      btnAdv.addEventListener("click", async () => {
        try {
          await DB.setDispatchStatus(s.id, btnAdv.dataset.advanceStage);
          toast(`${s.id} → ${btnAdv.dataset.advanceStage}`);
          closeModal();
          renderSales();
        } catch (err) {
          toast(err.message, false);
        }
      });
    }

    const btnCanc = $("#btnCancelOrderModal");
    if (btnCanc) {
      btnCanc.addEventListener("click", async () => {
        if (confirm(`Cancel order ${s.id} and return items to shelf rack?`)) {
          try {
            await DB.cancelWebOrder(s.id);
            toast("Order cancelled — items restored to rack");
            closeModal();
            renderSales();
          } catch (err) {
            toast(err.message, false);
          }
        }
      });
    }

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
        <span class="ph-thumb">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : "🧥"}</span>
        <div class="stock-main">
          <div class="stock-title-row">
            <div class="grow">
              <div class="stock-name">${esc(p.name)}</div>
              <div class="stock-sku">${esc(p.sku || p.barcode_id || "")}</div>
            </div>
            ${inStock ? `<span class="stat-chip ok">AVAILABLE</span>` : `<span class="stat-chip bad">SOLD</span>`}
          </div>
          <div class="stock-tags">
            <span class="itag">${esc(p.demographic)}</span>
            <span class="itag">${esc(p.category)}</span>
            <span class="itag">📏 ${esc(p.size)}</span>
            <span class="itag">${esc(p.condition)}</span>
            ${p.brand ? `<span class="itag">🏷️ ${esc(p.brand)}</span>` : ""}
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
          <button class="btn sm ghost" data-editprod="${esc(p.id)}">✏️ Edit</button>
          <button class="btn sm ghost dim" data-delprod="${esc(p.id)}">🗑 Delete</button>
        </div>
      </div>`;
    }).join("") : `<div class="card"><p class="muted" style="padding:20px">No products match these filters.</p></div>`;
  }

  /* ---- product editor modal (edit / delete) ---- */
  function productModal(id) {
    const p = id ? DB.getProduct(id) : null;
    const v = (k, d = "") => p ? esc(p[k] != null ? p[k] : d) : d;
    const modalImageState = { image_url: p ? (p.image_url || "") : "" };
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>${p ? "Edit item" : "New item"}</h3>
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
        <div class="field"><label>Selling (UGX)</label><input id="mpSell" type="number" class="sel-full" value="${p ? p.selling_price : ""}" /></div>
      </div>
      <div class="fgrid">
        <div class="field"><label>Compare-at (UGX)</label><input id="mpCompare" type="number" class="sel-full" value="${p ? p.compare_price : ""}" /></div>
        <div class="field"><label>Stock</label><input id="mpStock" type="number" class="sel-full" value="${p ? p.in_stock_count : 1}" /></div>
      </div>
      ${Intake.imageFieldHTML(modalImageState.image_url)}
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-prod="${p ? esc(p.id) : ""}">${p ? "Save changes" : "Add item"}</button>
      </div>`);
    Intake.bindImageEditor(modalBox, modalImageState);
    modalBox._imageState = modalImageState;
  }

  /* ============================================================
     CATALOG INTAKE (with print tag preview)
     ============================================================ */
  const DEMO_CODES = { Men: "MEN", Women: "WOM", Children: "KID" };
  const GROUPS = { "Apparel": ["Tops & Shirts", "Dresses & Skirts", "Pants & Jeans"], "Outerwear": ["Outerwear & Jackets"], "Footwear": ["Shoes"], "Accessories": ["Accessories"], "Kids": ["Children Wear"] };
  const intakePhotos = ["", "", "", ""];   // front, back, fabric, tag
  let intakeBound = false;

  function demoSku() {
    const demo = $("#inDemo").value || "Men";
    return `ADN-${DEMO_CODES[demo] || "GEN"}-${1000 + Math.floor(Math.random() * 9000)}`;
  }
  async function loadIntakeStockLots() {
    const select = $("#inStockLot");
    if (!select) return;
    try {
      const data = await DB.financeRequest("stock-lots", { method:"GET" });
      const current = select.value;
      const lots = (data.stock_lots || []).filter(lot => lot.remaining_count > 0);
      select.innerHTML = `<option value="">No registered lot selected</option>` + lots.map(lot => `<option value="${esc(lot.id)}" data-unit-cost="${lot.unit_cost}">${esc(lot.lot_code)} · ${esc(lot.supplier)} · ${lot.remaining_count} left · ${ugx(lot.unit_cost)}/item</option>`).join("");
      select.value = current;
    } catch (error) {
      select.innerHTML = `<option value="">Sign in to load registered lots</option>`;
    }
  }
  function initIntakeForm() {
    $("#inDemo").innerHTML = DB.DEMOGRAPHICS.map(d => `<option>${d}</option>`).join("");
    $("#inCat").innerHTML = DB.CATEGORIES.map(c => `<option>${c}</option>`).join("");
    $("#inCond").innerHTML = DB.CONDITIONS.map(c => `<option>${c}</option>`).join("");
    $("#inGroup").innerHTML = Object.keys(GROUPS).map(g => `<option>${g}</option>`).join("");
    $("#inSizePreset").innerHTML = `<option value="">Preset</option>` + ["XS", "S", "M", "L", "XL", "2XL", "28", "30", "32", "34", "36", "40", "42", "43", "44", "8y", "10y", "One size"].map(s => `<option value="${s}">${s}</option>`).join("");
    $("#inSku").value = demoSku();
    loadIntakeStockLots();

    if (intakeBound) return;
    intakeBound = true;
    $("#btnRollSku").addEventListener("click", () => { $("#inSku").value = demoSku(); paintTag(); });
    $("#inDemo").addEventListener("change", () => { $("#inSku").value = demoSku(); paintTag(); });
    $("#inSizePreset").addEventListener("change", () => { if ($("#inSizePreset").value) $("#inSize").value = $("#inSizePreset").value; paintTag(); });
    $("#inGroup").addEventListener("change", () => { $("#inCat").value = GROUPS[$("#inGroup").value][0]; paintTag(); });
    $("#inStockLot").addEventListener("change", () => {
      const option = $("#inStockLot").options[$("#inStockLot").selectedIndex];
      if (option && option.dataset.unitCost) $("#inCost").value = option.dataset.unitCost;
      paintTag();
    });
    $("#inCat").addEventListener("change", () => {
      const g = Object.keys(GROUPS).find(k => GROUPS[k].includes($("#inCat").value));
      if (g) $("#inGroup").value = g;
      paintTag();
    });
    ["inTitle", "inSize", "inBrand", "inColor", "inCost", "inSell", "inRrp", "inSku"].forEach(id => $("#" + id).addEventListener("input", paintTag));
    $("#btnIntakeSave").addEventListener("click", () => saveIntake(false));
    $("#btnIntakeMore").addEventListener("click", () => saveIntake(true));
    buildPhotoRow();
    paintTag();
  }

  function buildPhotoRow() {
    const SLOTS = [
      ["1. Front View", ""], ["2. Back View", "Reverse cut & seams"],
      ["3. Fabric / Texture", "Close-up weave & material"], ["4. Brand & Size Tag", "Authenticity & care tag"]
    ];
    $("#photoRow").innerHTML = SLOTS.map((s, i) => `
      <div class="ph-slot" data-slot="${i}">
        <div class="ph-prev ${i === 0 ? "hero" : ""}">${intakePhotos[i] ? `<img src="${esc(intakePhotos[i])}" alt="" />` : ""}<span class="ph-lbl">${s[0]}</span>${s[1] ? `<span class="ph-sub">${s[1]}</span>` : ""}</div>
        <div class="ph-btns">
          <button class="btn sm" data-phgal="${i}" type="button">📁 Gallery / File</button>
          ${intakePhotos[i] ? `<button class="btn sm ghost" data-phrem="${i}" type="button">Remove</button>` : ""}
        </div>
      </div>`).join("");
    paintAngles();
  }
  function paintAngles() {
    const n = intakePhotos.filter(Boolean).length;
    $("#angleCount").textContent = `${n} / 4 angles`;
    $$(".ph-slot").forEach((el, i) => {
      const prev = $(".ph-prev", el);
      prev.innerHTML = (intakePhotos[i] ? `<img src="${esc(intakePhotos[i])}" alt="" />` : "")
        + `<span class="ph-lbl">${["1. Front View", "2. Back View", "3. Fabric / Texture", "4. Brand & Size Tag"][i]}</span>`;
      if (i > 0) { const sub = ["", "Reverse cut & seams", "Close-up weave & material", "Authenticity & care tag", ""][i]; if (sub) prev.insertAdjacentHTML("beforeend", `<span class="ph-sub">${sub}</span>`); }
    });
  }
  function pickPhoto(slot) {
    const fi = document.createElement("input");
    fi.type = "file"; fi.accept = "image/png, image/jpeg, image/jpg, image/webp, image/*";
    fi.onchange = async () => {
      const f = fi.files && fi.files[0]; if (!f) return;
      try {
        const url = await Intake.compressImage(f);
        intakePhotos[slot] = url;
        buildPhotoRow();
      } catch (err) {
        toast(err.message || "Failed to load photo", false);
      }
    };
    fi.click();
  }

  function paintTag() {
    const demo = $("#inDemo").value || "Men", cat = $("#inCat").value || "Tops & Shirts";
    $("#tagKicker").textContent = `${demo.toUpperCase()} · ${cat.toUpperCase()}`;
    $("#tagTitle").textContent = $("#inTitle").value.trim() || "Item Title";
    $("#tagMeta").textContent = `Brand: ${$("#inBrand").value.trim() || "Unbranded"} | Size: ${$("#inSize").value.trim() || "Standard"} | Color: ${$("#inColor").value.trim() || "Standard"}`;
    const sell = Number($("#inSell").value) || 0, rrp = Number($("#inRrp").value) || 0;
    $("#tagPrice").textContent = ugx(sell);
    $("#tagStrike").textContent = rrp > sell ? ugx(rrp) : "";
    const code = $("#inSku").value.trim() || "ADN-XXX-0000";
    $("#tagCode").textContent = code;
    // real Code 128 barcode from the SKU
    $("#tagBars").innerHTML = DB.barcodeSVG(code, 46);
    $("#btnIntakeSave").textContent = `Tag & Save (${ugx(sell)})`;
  }

  async function saveIntake(again) {
    const vals = {
      name: $("#inTitle").value.trim(),
      brand: $("#inBrand").value.trim() || "Unbranded",
      color: $("#inColor").value.trim(),
      demographic: $("#inDemo").value, category: $("#inCat").value,
      size: $("#inSize").value.trim() || "-",
      condition: $("#inCond").value,
      cost_price: Number($("#inCost").value) || 0,
      stock_lot_id: $("#inStockLot").value,
      base_price: Number($("#inSell").value) || 0,
      selling_price: Number($("#inSell").value) || 0,
      total_transport_cost: Number($("#inTransport").value) || 0,
      compare_price: Number($("#inRrp").value) || 0,
      desc: $("#inStory").value.trim(),
      staff_notes: $("#inNotes").value.trim(),
      visibility: $("#inVis").value,
      in_stock_count: Number($("#inStatus").value) ? 1 : 0,
      sku: $("#inSku").value.trim(),
      images: intakePhotos.filter(Boolean),
      image_url: intakePhotos[0] || intakePhotos.find(Boolean) || ""
    };
    if (!vals.name) return toast("Item title is required", false);
    if (!vals.selling_price) return toast("Set a sell price first", false);
    try {
      const p = await DB.addProduct(vals);
      toast(`🏷️ Tagged & saved — ${p.name} · ${p.sku}`);
      if (again) {
        ["inTitle", "inBrand", "inColor", "inCost", "inSell", "inRrp", "inStory", "inNotes"].forEach(id => $("#" + id).value = "");
        intakePhotos.fill(""); paintAngles();
        $("#inStockLot").value = "";
        $("#inSku").value = demoSku(); paintTag(); $("#inTitle").focus();
      } else {
        renderAll();
      }
    } catch (err) { toast(err.message, false); }
  }

  function renderIntake() {
    initIntakeForm();
    paintTag();
    $("#recentTagged").innerHTML = DB.listProducts().slice(-6).reverse().map(p => `
      <div class="ch-row">
        <div class="rider-mini">
          <span class="ph-thumb ph-mini">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : "🏷️"}</span>
          <div><strong class="serif">${esc(p.name)}</strong><div class="muted small">${esc(p.sku)} · ${esc(p.demographic)}</div></div>
        </div>
        <strong class="serif">${ugx(p.selling_price)}</strong>
      </div>`).join("");
  }

  /* ============================================================
     CUSTOMER BOOK (guest book)
     ============================================================ */
  let guestTerm = "";
  $("#guestSearch").addEventListener("input", e => { guestTerm = e.target.value.trim().toLowerCase(); renderGuests(); });
  function renderGuests() {
    let list = DB.listGuests();
    if (guestTerm) list = list.filter(g => [g.name, g.phone, g.neighborhood].some(x => String(x || "").toLowerCase().includes(guestTerm)));
    $("#guestList").innerHTML = list.length ? list.map(g => `
      <div class="guest-card">
        <div class="guest-top">
          <span class="avatar" style="background:${avColor(g.name)}">${initials(g.name)}</span>
          <div class="grow">
            <div class="guest-name">${esc(g.name)}</div>
            ${g.phone ? `<a class="guest-phone" href="tel:${esc(String(g.phone).replace(/[^+0-9]/g, ""))}">📞 ${esc(g.phone)}</a>` : ""}
          </div>
          <div class="gc-actions">
            <button class="lnk" data-edit-guest="${esc(g.id)}">Edit</button>
            <button class="lnk dim" data-del-guest="${esc(g.id)}">Remove</button>
          </div>
        </div>
        ${(g.address || g.neighborhood || g.email) ? `<div class="guest-tags">
          ${g.neighborhood ? `<span class="itag">📍 ${esc(g.neighborhood)}</span>` : ""}
          ${g.address ? `<span class="itag">${esc(g.address)}</span>` : ""}
          ${g.email ? `<span class="itag">✉️ ${esc(g.email)}</span>` : ""}
        </div>` : ""}
        ${g.notes ? `<div class="guest-notes">📝 ${esc(g.notes)}</div>` : ""}
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
     BODA RIDERS & DISPATCH
     ============================================================ */
  function renderRiders() {
    const all = allSales();
    $("#riderList").innerHTML = DB.listRiders().map(r => {
      const active = all.filter(s => s.assigned_rider_id === r.id && s.dispatch_status === "With rider").length;
      const delivered = all.filter(s => s.assigned_rider_id === r.id && s.dispatch_status === "Delivered").length;
      return `
      <div class="rider-card">
        <div class="rc-top">
          <span class="avatar" style="background:${avColor(r.name)}">${initials(r.name)}</span>
          <div class="grow"><div class="guest-name" style="margin:0">${esc(r.name)}</div>
            <div class="rider-tags"><span class="itag">🛵 ${esc(r.vehicle)}</span><span class="itag">📍 ${esc(r.zone)}</span></div></div>
          <div class="rc-stats">
            <div><strong class="serif">${active}</strong><span class="micro-cap">EN ROUTE</span></div>
            <div><strong class="serif">${delivered}</strong><span class="micro-cap">DONE</span></div>
          </div>
        </div>
        <div class="rc-chip">${riderStatusChip(r.status)}${r.phone ? `<a class="stat-chip mut" href="tel:${esc(String(r.phone).replace(/[^+0-9]/g, ""))}">📞 CALL</a>` : ""}</div>
        <div class="rc-btns">
          ${DB.RIDER_STATUSES.map(st => `<button class="lane-tab ${r.status === st ? "active" : ""}" data-rider-st="${esc(r.id)}" data-st="${st}">${st.toUpperCase()}</button>`).join("")}
        </div>
        <button class="lnk" data-edit-rider="${esc(r.id)}">Edit route details</button>
      </div>`;
    }).join("");
  }
  function riderModal(id) {
    const r = DB.listRiders().find(x => x.id === id);
    if (!r) return;
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Rider details</h3>
      <div class="field"><label>Name</label><input class="sel-full" id="mrName" value="${esc(r.name)}" /></div>
      <div class="field"><label>Phone</label><input class="sel-full" id="mrPhone" value="${esc(r.phone)}" /></div>
      <div class="field"><label>Vehicle</label><input class="sel-full" id="mrVehicle" value="${esc(r.vehicle)}" /></div>
      <div class="field"><label>Zone</label><input class="sel-full" id="mrZone" value="${esc(r.zone)}" /></div>
      <button class="btn primary" data-save-rider="${esc(r.id)}">Save rider</button>`);
  }

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
    return `<div class="finance-error"><div><strong>${status === 401 ? "Staff sign-in required" : status === 403 ? "Manager authorization required" : "Could not load this workspace"}</strong><p class="small">${esc(message)}</p>${status === 401 ? `<a class="btn primary sm" href="login.html">Sign in to terminal</a>` : ""}</div></div>`;
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
    if (!["expenses", "lots", "dashboard", "aging", "journal"].includes(tab)) return;
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

  async function loadStockLots() {
    const host = $("#stockLotList");
    if (!host) return;
    host.innerHTML = `<div class="finance-empty">Syncing stock-lot allocations…</div>`;
    try {
      const data = await DB.financeRequest("stock-lots", { method:"GET" });
      const rows = data.stock_lots || [];
      host.innerHTML = rows.length ? `<div class="fin-list">${rows.map(row => `
        <article class="fin-list-row"><div><div class="fin-list-title">${esc(row.lot_code)} <span class="fin-status">${esc(row.status)}</span></div><div class="fin-list-meta">${esc(row.supplier)} · ${esc(row.description)}<br/>${row.allocated_count} allocated · ${row.remaining_count} remaining · ${readableDateTime(row.acquired_at)}</div></div><div class="fin-list-side"><strong>${ugx(row.unit_cost)} / item</strong><span class="small muted">Landed ${ugx(row.total_landed_cost)}</span></div></article>`).join("")}</div>` : `<div class="finance-empty"><div><strong>No lots registered</strong><p class="small">Register a bale before tagging its items.</p></div></div>`;
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
    openModal(`<button class="modal-x" data-close>×</button><p class="kicker">LIVE STOREFRONT PRICE</p><h3>Markdown ${esc(name)}</h3><p class="muted small">The new price is written to the shared catalog immediately. Open storefronts refresh within five seconds.</p><div class="field"><label>Current price</label><div class="sel-full" style="background:#f3f1ed">${ugx(currentPrice)}</div></div><div class="field"><label>New selling price (UGX)</label><input class="sel-full" id="markdownPrice" type="number" min="1" max="${Math.max(1,currentPrice-1)}" /></div><div class="field"><label>Reason</label><input class="sel-full" id="markdownReason" value="Dead-stock markdown" /></div><div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveMarkdown">Publish markdown</button></div>`);
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
  const updateLotUnitCost = () => {
    const total = (Number($("#lotAcquisition").value) || 0) + (Number($("#lotShipping").value) || 0);
    const count = Number($("#lotItemCount").value) || 0;
    $("#lotUnitCost").textContent = count > 0 ? `${ugx(Math.round(total / count))} / item` : "UGX 0 / item";
  };
  ["#lotAcquisition", "#lotShipping", "#lotItemCount"].forEach(selector => $(selector).addEventListener("input", updateLotUnitCost));
  $("#stockLotForm").addEventListener("submit", async event => {
    event.preventDefault(); const button = $("#lotSubmit"); setButtonBusy(button, true, "Registering lot…");
    try {
      await DB.financeRequest("stock-lots", { method:"POST", body:JSON.stringify({
        supplier:$("#lotSupplier").value.trim(), description:$("#lotDescription").value.trim(),
        acquisition_cost:Number($("#lotAcquisition").value), shipping_cost:Number($("#lotShipping").value),
        item_count:Number($("#lotItemCount").value), payment_method:$("#lotPayment").value,
        acquired_at:$("#lotDate").value
      }) });
      event.target.reset(); $("#lotShipping").value = 0; $("#lotDate").value = localISODateTime(); updateLotUnitCost();
      toast("Stock lot registered — unit cost is ready in POS Intake"); await loadStockLots();
    } catch (error) { toast(error.message, false); }
    finally { setButtonBusy(button, false); }
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
          <button type="button" class="btn sm" id="pfUpload">📁 Upload Photo</button>
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
      const label = up.textContent;
      try {
        up.textContent = "⏳ Uploading…"; up.disabled = true;
        modalBox._staffPhoto = await compressAvatar(file.files[0]);
        paint();
      } catch (err) { toast(err.message || "Could not read that photo", false); }
      finally { up.textContent = label; up.disabled = false; file.value = ""; }
    });
    if (rm) rm.addEventListener("click", () => { modalBox._staffPhoto = ""; paint(); });
  }

  /* ---- Floor Team & Keys v3: grouped card-grid team dashboard ---- */
  const TEAM_GROUPS = [
    { key: "mgmt", icon: "🛡️", title: "Store Management & Admins",
      sub: "Master access keys, ledger privileges & system configuration.", roles: ["admin", "manager"] },
    { key: "pos",  icon: "💳", title: "Cashiers & POS Operators",
      sub: "Terminal billing, cash drawer sync & customer contacts on the floor.", roles: ["cashier"] },
    { key: "boda", icon: "🏍️", title: "Boda Dispatch & Logistics",
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
        const riderOrders = sales.filter(x => (x.assigned_rider_name || x.rider_name) === s.name);
        const delivering = riderOrders.find(x => x.dispatch_status === "Out for Delivery" || x.dispatch_status === "Packed");
        const dropsReal = riderOrders.filter(x => x.dispatch_status === "Delivered").length;
        const target = 20;
        const done = dropsReal > 0 ? dropsReal : 6 + (h % 13);
        p.pct = Math.min(100, Math.round((done / target) * 100));
        p.metric = `${done} / ${target} orders fulfilled`;
        p.metricShort = `${done}/${target}`;
        p.title = rc && rc.id === "RDR-1001" ? "Lead Dispatch Rider" : "Boda Courier";
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
    const taskIco = !p.active ? "⛔" : p.badge.tone === "green" ? "✅" : p.badge.tone === "blue" ? "🛵" : "⏸";
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
            <button type="button" data-edit-profile="${esc(p.id)}">👤 Edit Profile & Photo</button>
            <button type="button" data-key-staff="${esc(p.id)}">🔑 Edit Key / Passcode</button>
            <button type="button" data-change-role="${esc(p.id)}">🔁 Change Role</button>
            ${lastAdmin ? "" : `<button type="button" class="${p.active ? "danger" : ""}" data-toggle-staff="${esc(p.id)}">${p.active ? "⛔ Deactivate Account" : "✅ Reactivate Account"}</button>`}
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
        <button class="btn" type="button" data-key-staff="${esc(p.id)}">🔑 Key Settings</button>
        <button class="btn" type="button" data-staff-activity="${esc(p.id)}">📊 View Activity</button>
      </div>
    </article>`;
  }

  function renderStaff() {
    const locked = Auth.locked();
    $("#lockToggle").checked = locked;
    $("#lockState").textContent = locked ? "Access lock ON — terminals require a staff key" : "Open access mode — stores & terminals are unlocked";

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
      <h3>👤 Edit Profile — ${esc(s.name)}</h3>
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
      <h3>🔑 Key Settings — ${esc(s.name)}</h3>
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
      <h3>🔁 Change Role — ${esc(s.name)}</h3>
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
        events.push({ at: x.created_at, ico: "🧾", text: `Sale ${x.id} — ${items} item${items === 1 ? "" : "s"} · ${x.channel === "web" ? "Web order" : "POS register"}`, amt: ugx(x.total || 0) });
      }
      if ((x.assigned_rider_name || x.rider_name) === s.name) {
        events.push({ at: x.updated_at || x.created_at, ico: "🏍️", text: `${x.dispatch_status || "Dispatch"} — Order ${x.id}${x.customer_location ? ` (${x.customer_location})` : ""}`, amt: ugx(x.total || 0) });
      }
    });
    ledger.forEach(e => {
      if (e.by !== s.name) return;
      const kindLabel = (DB.LEDGER_KIND_LABELS && DB.LEDGER_KIND_LABELS[e.kind]) || e.kind;
      events.push({ at: e.created_at, ico: e.kind === "expense" ? "💸" : e.kind === "refund" ? "↩️" : "📒", text: `${kindLabel}${e.note ? " — " + e.note : ""}`, amt: ugx(Math.abs(e.amount || 0)) });
    });
    events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const salesTotal = sales.filter(x => x.cashier && x.cashier.name === s.name).reduce((a, x) => a + (x.total || 0), 0);
    openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>📊 Activity Log — ${esc(s.name)}</h3>
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
  function renderSettings() {
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
    $("#setFee").value = s.base_delivery_fee || 7000;
    $("#setKey").value = "";
    $("#setKey").placeholder = "Leave blank to keep current key";
    paintUnlockChip();
  }
  async function saveSettings() {
    Keys.requireRemote(async adminCredential => {
      const newKey = $("#setKey").value.trim();
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
        await DB.syncStoreSettings(livePatch, adminCredential);
        if (newKey) Keys.set(true, newKey);
        toast(newKey
          ? "Configuration published — storefront updated and master key rotated"
          : "Configuration published — live storefront will refresh within 5 seconds");
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
    const cw = t.closest("[data-cancel-web]");
    if (cw) { try { await DB.cancelWebOrder(cw.dataset.cancelWeb); toast("Order cancelled — stock returned"); } catch (err) { toast(err.message, false); } return; }
    const dt = t.closest("[data-dispatch-to]");
    if (dt) { try { await DB.setDispatchStatus(dt.dataset.dispatchTo, dt.dataset.stage); toast(`${dt.dataset.dispatchTo} → ${dt.dataset.stage}`); } catch (err) { toast(err.message, false); } return; }
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
      Keys.require(async () => {
        if (confirm(`Permanently delete “${p.name}” (${p.sku})? This cannot be undone.`)) {
          await DB.removeProduct(p.id); toast("Item deleted from the rack");
        }
      });
      return;
    }
    const btnSaveProd = t.closest("[data-save-prod]");
    if (btnSaveProd) {
      const vals = {
        name: $("#mpName").value.trim(), brand: $("#mpBrand").value.trim() || "Unbranded",
        color: $("#mpColor").value.trim(), demographic: $("#mpDemo").value, category: $("#mpCat").value,
        size: $("#mpSize").value.trim() || "-", condition: $("#mpCond").value,
        cost_price: Number($("#mpCost").value) || 0, selling_price: Number($("#mpSell").value) || 0,
        compare_price: Number($("#mpCompare").value) || 0, in_stock_count: Number($("#mpStock").value) || 0,
        image_url: modalBox._imageState ? modalBox._imageState.image_url : ""
      };
      if (!vals.name) return toast("Name required", false);
      try {
        if (btnSaveProd.dataset.saveProd) { await DB.updateProduct(btnSaveProd.dataset.saveProd, vals); toast("Item updated — live everywhere"); }
        else { const p = await DB.addProduct(vals); toast(`Added ${p.name} · ${p.sku}`); }
        closeModal();
      } catch (err) { toast(err.message, false); }
      return;
    }

    /* intake photo slots */
    const pg = t.closest("[data-phgal]"); if (pg) return pickPhoto(Number(pg.dataset.phgal));
    const pr = t.closest("[data-phrem]"); if (pr) { intakePhotos[Number(pr.dataset.phrem)] = ""; buildPhotoRow(); return; }

    /* guests */
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
        await DB.updateRider(sr.dataset.saveRider, { name: $("#mrName").value, phone: $("#mrPhone").value, vehicle: $("#mrVehicle").value, zone: $("#mrZone").value });
        closeModal(); toast("Rider route updated");
      } catch (err) { toast(err.message, false); }
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

  $("#lockToggle").addEventListener("change", e => {
    Keys.require(() => DB.updateSettings({ access_locked: e.target.checked }).then(() => {
      toast(e.target.checked ? "🔒 Access lock ON — POS & console now require staff keys" : "🔓 Open access mode enabled");
      if (e.target.checked && !DB.listStaff().some(s => s.pin)) toast("No staff keys are set yet — unlock stays symbolic until you add one", true);
    }));
  });

  /* ---------- render dispatcher + realtime ---------- */
  function render() {
    if (currentView === "overview") renderOverview();
    if (currentView === "sales") renderSales();
    if (currentView === "inventory") renderInventory();
    if (currentView === "intake") renderIntake();
    if (currentView === "customers") renderGuests();
    if (currentView === "dispatch") renderRiders();
    if (currentView === "payments") renderLedger();
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
