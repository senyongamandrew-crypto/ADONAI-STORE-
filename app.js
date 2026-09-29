/* ============================================================
   ADONAI — OPERATIONS CONSOLE (admin.html)
   Warm screenshot system · all views live off the shared DB
   with guest book, riders, ledger, intake & Master Key gate.
   ============================================================ */
(function () {
  "use strict";
  const me = Auth.guard({ role: "admin" });     // open access until the lock is enabled
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
  const Keys = {
    unlocked() { return sessionStorage.getItem(KEY_FLAG) === "1"; },
    set(v) { v ? sessionStorage.setItem(KEY_FLAG, "1") : sessionStorage.removeItem(KEY_FLAG); paintUnlockChip(); },
    require(cb) { if (this.unlocked()) return cb(); renderMasterModal(cb); }
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
    const go = () => {
      if (DB.verifyMasterKey(input.value)) {
        Keys.set(true); closeModal(); toast("🔓 Master Key unlocked for this session");
        if (after) after();
      } else {
        input.classList.add("err"); toast("Incorrect master key", false);
        setTimeout(() => input.classList.remove("err"), 700);
      }
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
  $("#btnMenu").addEventListener("click", () => shell.classList.toggle("sb-open"));
  $("#sbScrim").addEventListener("click", () => shell.classList.remove("sb-open"));

  // sync live ticker — Ns since last DB touch, `Auto 5s` cadence label
  let lastTouch = Date.now();
  setInterval(() => {
    const txt = $("#syncText");
    if (!navigator.onLine) { txt.textContent = "Reconnecting…"; return; }
    txt.textContent = `Sync Live · ${Math.min(59, Math.floor((Date.now() - lastTouch) / 1000))}s | Auto 5s`;
  }, 1000);
  window.addEventListener("online", () => render());
  window.addEventListener("offline", () => { $("#syncText").textContent = "Reconnecting…"; });

  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; });
  const tryInstall = () => {
    if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; }
    else toast("Open browser menu → “Add to Home screen” to install the POS app");
  };
  $("#btnInstallTop").addEventListener("click", tryInstall);
  $("#sidebarInstall").addEventListener("click", tryInstall);

  // staff identity in sidebar
  const whoName = me ? me.name : "Open access";
  $("#meName").textContent = whoName;
  $("#meRole").textContent = me ? "Role: " + me.role.toUpperCase() : "Roster seeded · keys unset";
  $("#meAvatar").textContent = initials(whoName);

  /* =============== navigation =============== */
  const VALID_VIEWS = ["overview", "sales", "inventory", "intake", "customers", "dispatch", "payments", "staff", "settings"];
  function currentHashView() {
    const h = (location.hash || "").replace(/^#\/?/, "").trim();
    return VALID_VIEWS.includes(h) ? h : null;
  }
  let currentView = currentHashView() || "overview";

  function setView(v, updateHash = true) {
    if (!VALID_VIEWS.includes(v)) v = "overview";
    currentView = v;
    if (updateHash) {
      if (location.hash.replace(/^#\/?/, "") !== v) {
        history.replaceState(null, "", "#" + v);
      }
    }
    $$(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    shell.classList.remove("sb-open");
    render();
  }
  $$(".nav-item[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  window.addEventListener("hashchange", () => {
    const hv = currentHashView();
    if (hv && hv !== currentView) setView(hv, false);
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
  const statusChip = s => {
    const map = { pending: ["pend", "PENDING"], completed: ["ok", "COMPLETED"], cancelled: ["bad", "CANCELLED"] };
    const [cls, txt] = map[s.status] || ["pend", s.status.toUpperCase()];
    return `<span class="stat-chip ${cls}">${txt}</span>`;
  };
  const laneChip = d => {
    const map = { "With rider": ["blue", "WITH RIDER"], "Handed over": ["amber", "HANDED OVER"], "Delivered": ["ok", "DELIVERED"], "Packed": ["pend", "PACKED"], "Pending": ["pend", "IN QUEUE"] };
    const [cls, txt] = map[d || "Pending"] || ["pend", d];
    return `<span class="stat-chip ${cls}">${txt}</span>`;
  };
  function kpiCard(label, value, sub) {
    return `<div class="kpi-card">
      <div class="kpi-lab">${esc(label)}</div>
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
    $("#greetingH").textContent = "Good evening, " + name.split(" ")[0];
    $("#dateLine").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toUpperCase() + " · KAMPALA, UGANDA";

    const sales = allSales();
    const done = validSales();
    const t0 = todayMid().getTime();
    const webPend = sales.filter(s => s.channel === "web" && s.status === "pending");
    const reserved = webPend.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);
    const todayDone = done.filter(s => new Date(s.created_at).getTime() >= t0);
    const todayRev = todayDone.reduce((a, s) => a + s.total, 0);
    const onRack = DB.listProducts().filter(p => p.in_stock_count > 0).length;

    $("#kpiCards").innerHTML =
      kpiCard("TODAY'S REVENUE (UGX)", ugx(todayRev), "Closed register & delivery sales") +
      kpiCard("TODAY'S TICKETS", todayDone.filter(s => s.channel === "pos").length, "In-store POS & WhatsApp reservations") +
      kpiCard("ONLINE PENDING", webPend.length, "Awaiting packaging / rider") +
      kpiCard("ON THE RACK (PIECES)", onRack, `${reserved} reserved in orders`);

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
      ? `${webPend.length} WhatsApp order(s) waiting for confirmation — the poller picked them up.`
      : "No pending WhatsApp orders right now. The poller is watching every 5 seconds.";
    $("#pollDot").classList.toggle("hot", webPend.length > 0);

    /* ---- rack bars ---- */
    const soldQty = done.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);
    const rackTotal = Math.max(1, onRack + reserved + soldQty);
    $("#rackBars").innerHTML = [
      ["Available for Sale", onRack, "var(--rgreen)"],
      ["Reserved in Orders", reserved, "var(--ramber)"],
      ["Sold & Closed", soldQty, "#B8AC9E"]
    ].map(([lbl, v, c]) => `
      <div class="rack-row"><span class="rack-lbl">${lbl}</span><span class="rack-val">${v}</span>
        <div class="rack-track"><div style="width:${Math.round(v / rackTotal * 100)}%;background:${c}"></div></div>
      </div>`).join("");

    /* ---- channels ---- */
    const revPos = done.filter(s => s.channel === "pos").reduce((a, s) => a + s.total, 0);
    const revWeb = done.filter(s => s.channel === "web").reduce((a, s) => a + s.total, 0);
    const cashTot = done.filter(s => s.tender && s.tender.type === "cash").reduce((a, s) => a + s.total, 0);
    $("#channelRows").innerHTML = [
      ["Register", revPos], ["WhatsApp", revWeb], ["Catalog", 0]
    ].map(([lbl, v]) => `<div class="ch-row"><span>${lbl}</span><strong>${ugx(v)}</strong></div>`).join("")
      + `<span class="cash-pill">Cash ${ugx(cashTot)}</span>`;

    /* ---- boda pool ---- */
    $("#riderPool").innerHTML = DB.listRiders().slice(0, 3).map(r => `
      <div class="ch-row"><div><strong class="serif">${esc(r.name)}</strong><div class="muted small">${esc(r.zone)}</div></div>
      ${riderStatusChip(r.status)}</div>`).join("");

    /* ---- recent transactions ---- */
    $("#recentTx").innerHTML = sales.slice(0, 5).map(s => `
      <button class="tx-row" data-view-sale="${esc(s.id)}">
        <div><strong class="serif">${esc(s.id)}</strong> ${esc(s.customer_name)}<div class="muted small">${ago(s.created_at)}</div></div>
        <span class="tx-right">${statusChip(s)} <strong>${ugx(s.total)}</strong></span>
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
    { key: "incoming",    title: "Incoming",        sub: "Pending, not queued" },
    { key: "fulfillment", title: "Fulfillment",     sub: "Confirmed & packing" },
    { key: "rider",       title: "With Boda Rider", sub: "Out on delivery" },
    { key: "handed",      title: "Handed Over",     sub: "Handed to customer" },
    { key: "completed",   title: "Completed / Closed", sub: "Booked & archived" }
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
    const webPend = sales.filter(s => s.channel === "web" && s.status === "pending");
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
    if (s.channel === "web" && s.status === "pending") {
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-open-order="${esc(s.id)}">Manage / Dispatch →</button>
        ${!paid ? `
          <button class="btn sm" data-set-paid="${esc(s.id)}" data-method="cash">💰 Cash</button>
          <button class="btn sm" data-set-paid="${esc(s.id)}" data-method="mtn">📱 MoMo</button>
        ` : `
          <button class="btn sm ghost" data-set-unpaid="${esc(s.id)}">Mark Unpaid</button>
        `}
        <button class="btn sm danger" data-cancel-web="${esc(s.id)}">Cancel</button></div>`);
    } else if (activeLane === "fulfillment") {
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-open-order="${esc(s.id)}">🛵 Dispatch with rider →</button>
        ${!paid ? `<button class="btn sm" data-set-paid="${esc(s.id)}" data-method="cash">Mark Paid</button>` : ""}
        <button class="btn sm" data-print-order="${esc(s.id)}">🖨 Receipt</button></div>`);
    } else if (activeLane === "rider") {
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-dispatch-to="${esc(s.id)}" data-stage="Handed over">Mark handed over →</button>
        ${!paid ? `<button class="btn sm" data-set-paid="${esc(s.id)}" data-method="cash">Mark Paid</button>` : ""}
        <button class="btn sm" data-open-order="${esc(s.id)}">Details</button></div>`);
    } else if (activeLane === "handed") {
      acts.push(`<div class="pay-row">
        <button class="btn sm primary" data-dispatch-to="${esc(s.id)}" data-stage="Delivered">Complete &amp; close ✓</button>
        <button class="btn sm" data-open-order="${esc(s.id)}">Details</button></div>`);
    } else {
      acts.push(`<div class="pay-row">
        <button class="btn sm" data-print-order="${esc(s.id)}">View receipt</button>
        <button class="btn sm ghost" data-open-order="${esc(s.id)}">Details</button></div>`);
    }
    return `<div class="order-card" data-card-order="${esc(s.id)}">
      <div class="oc-top">
        <strong class="serif">${esc(s.id)}</strong>
        ${s.channel === "web" ? `<span class="stat-chip web">WHATSAPP</span>` : `<span class="stat-chip pos">REGISTER</span>`}
        ${s.status === "pending" ? `<span class="stat-chip pend">PENDING</span>` : s.status === "completed" ? `<span class="stat-chip ok">COMPLETED</span>` : `<span class="stat-chip bad">CANCELLED</span>`}
        ${paid ? `<span class="stat-chip ok">PAID</span>` : `<span class="stat-chip pend">UNPAID</span>`}
        ${s.status === "completed" && s.channel === "web" ? laneChip(s.dispatch_status) : ""}
        <span class="muted small" style="margin-left:auto">${ago(s.created_at)}</span>
      </div>
      <div class="oc-body">
        <div><strong>${esc(s.customer_name)}</strong> <span class="muted small">${esc(s.customer_phone || "")}</span>
          <div class="muted small">${esc(itemsSummary(s))}</div></div>
        <strong class="oc-total">${ugx(s.total)}</strong>
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
          <div class="rc-t-mark">T</div>
          <h2 class="rc-title">Adonai</h2>
          <div class="rc-sub">THRIFT STORE</div>
        </div>
        <div class="rc-meta-top">
          <strong>${esc(S.store_name || "Adonai Thrift Store")}</strong><br/>
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
          <div class="rc-cust-row"><span class="rc-cust-k">Customer:</span> <strong class="rc-cust-v">${esc(s.customer_name || "Walk-in customer")}</strong></div>
          <div class="rc-cust-row"><span class="rc-cust-k">Phone:</span> <span class="rc-cust-v">${esc(s.customer_phone || "—")}</span></div>
          <div class="rc-cust-row"><span class="rc-cust-k">Location:</span> <span class="rc-cust-v">${esc(s.delivery_area ? `${s.delivery_area}${s.delivery_address ? " - " + s.delivery_address : ""}` : s.delivery_address || "Storefront Walk-in")}</span></div>
          <div class="rc-cust-row"><span class="rc-cust-k">Sales Channel:</span> <span class="rc-cust-v">${s.channel === "web" ? "WhatsApp" : "In-Store POS"}</span></div>
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
        <span class="stat-chip ${s.status === 'completed' ? 'ok' : s.status === 'cancelled' ? 'bad' : 'pend'}">${s.status.toUpperCase()}</span>
        <span class="stat-chip ${paid ? 'ok' : 'pend'}">${paid ? 'PAID' : 'UNPAID'}</span>
        <span class="stat-chip ${s.channel === 'web' ? 'web' : 'pos'}">${s.channel === 'web' ? 'WhatsApp' : 'Register'}</span>
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

      ${s.customer_phone ? `
        <a class="btn wa-chat-full-btn" href="https://wa.me/${esc(s.customer_phone.replace(/[^0-9]/g, ''))}?text=${encodeURIComponent(`Hello ${s.customer_name}, Adonai Thrift Store here regarding your order ${s.id}...`)}" target="_blank" rel="noopener">
          💬 Open WhatsApp Order Chat ↗
        </a>
      ` : ""}

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

        ${s.dispatch_status === "With rider" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="Handed over">📦 Mark Handed Over to Customer</button>
        ` : s.dispatch_status === "Handed over" ? `
          <button class="btn primary btn-full" id="btnAdvRider" data-advance-stage="Delivered">✓ Complete &amp; Settle Order</button>
        ` : `
          <button class="btn primary btn-full" id="btnDispatchRider">🛵 Dispatch to Boda Rider</button>
        `}

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
      return `<div class="stock-row">
        <span class="ph-thumb">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : "🧥"}</span>
        <div class="stock-main">
          <div class="stock-name">${esc(p.name)}</div>
          <div class="stock-sku">${esc(p.sku)}</div>
          <div class="muted small">${esc(p.brand)} · Size: ${esc(p.size)} · ${esc(p.condition)}</div>
          <div class="muted small serif" style="margin-top:2px">${esc(p.demographic)}</div>
          <div class="muted small">${esc(p.category)}</div>
          <div class="stock-price">${ugx(p.selling_price)}</div>
          <div class="muted small">${p.compare_price ? `<s>${ugx(p.compare_price)}</s> <span class="off">-${off}%</span>` : ""}</div>
          <div class="muted small">Cost: ${ugx(p.cost_price)}</div>
          <div class="stock-foot">
            ${p.in_stock_count > 0 ? `<span class="stat-chip ok">AVAILABLE</span>` : `<span class="stat-chip bad">SOLD</span>`}
            <span class="micro-cap">ONLINE + IN-STORE</span>
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
  function initIntakeForm() {
    $("#inDemo").innerHTML = DB.DEMOGRAPHICS.map(d => `<option>${d}</option>`).join("");
    $("#inCat").innerHTML = DB.CATEGORIES.map(c => `<option>${c}</option>`).join("");
    $("#inCond").innerHTML = DB.CONDITIONS.map(c => `<option>${c}</option>`).join("");
    $("#inGroup").innerHTML = Object.keys(GROUPS).map(g => `<option>${g}</option>`).join("");
    $("#inSizePreset").innerHTML = `<option value="">Preset</option>` + ["XS", "S", "M", "L", "XL", "2XL", "28", "30", "32", "34", "36", "40", "42", "43", "44", "8y", "10y", "One size"].map(s => `<option value="${s}">${s}</option>`).join("");
    $("#inSku").value = demoSku();

    if (intakeBound) return;
    intakeBound = true;
    $("#btnRollSku").addEventListener("click", () => { $("#inSku").value = demoSku(); paintTag(); });
    $("#inDemo").addEventListener("change", () => { $("#inSku").value = demoSku(); paintTag(); });
    $("#inSizePreset").addEventListener("change", () => { if ($("#inSizePreset").value) $("#inSize").value = $("#inSizePreset").value; paintTag(); });
    $("#inGroup").addEventListener("change", () => { $("#inCat").value = GROUPS[$("#inGroup").value][0]; paintTag(); });
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
      selling_price: Number($("#inSell").value) || 0,
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
      <div class="ch-row"><div><strong class="serif">${esc(p.name)}</strong><div class="muted small">${esc(p.sku)} · ${esc(p.demographic)}</div></div><strong>${ugx(p.selling_price)}</strong></div>`).join("");
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
        <div class="gc-actions"><button class="lnk" data-edit-guest="${esc(g.id)}">Edit</button><button class="lnk dim" data-del-guest="${esc(g.id)}">Remove</button></div>
        <div class="guest-name">${esc(g.name)}</div>
        <div class="guest-phone">${esc(g.phone)}</div>
        ${g.address ? `<div class="muted small">${esc(g.address)}${g.neighborhood ? `, ${esc(g.neighborhood)}` : ""}</div>` : (g.neighborhood ? `<div class="muted small">${esc(g.neighborhood)}</div>` : "")}
        ${g.email ? `<div class="muted small">${esc(g.email)}</div>` : ""}
        ${g.notes ? `<div class="guest-notes">${esc(g.notes)}</div>` : ""}
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
    $("#riderList").innerHTML = DB.listRiders().map(r => `
      <div class="rider-card">
        <div class="rc-top">
          <span class="avatar" style="background:${avColor(r.name)}">${initials(r.name)}</span>
          <div class="grow"><div class="guest-name" style="margin:0">${esc(r.name)}</div>
            <div class="muted small">${esc(r.vehicle)} · ${esc(r.zone)}</div></div>
          <span class="lane-count">${0} active</span>
        </div>
        <div class="rc-chip">${riderStatusChip(r.status)}</div>
        <div class="rc-btns">
          ${DB.RIDER_STATUSES.map(st => `<button class="lane-tab ${r.status === st ? "active" : ""}" data-rider-st="${esc(r.id)}" data-st="${st}">${st.toUpperCase()}</button>`).join("")}
        </div>
        <button class="lnk" data-edit-rider="${esc(r.id)}">Edit route details</button>
      </div>`).join("");
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
     FINANCIAL LEDGER
     ============================================================ */
  let ledgerFilter = "all";
  function renderLedger() {
    const sum = DB.ledgerSummary();
    $("#ledgerKpis").innerHTML =
      kpiCard("TODAY'S SALES", ugx(sum.todaySales)) +
      kpiCard("ALL-TIME REVENUE", ugx(sum.revenue)) +
      kpiCard("TOTAL OUTFLOW", "UGX " + sum.outflow.toLocaleString("en-US")) +
      kpiCard("NET BALANCE", ugx(sum.revenue + sum.outflow));
    $("#ledgerPills").innerHTML = ["all", ...DB.LEDGER_KINDS].map(k =>
      `<button class="lane-tab ${ledgerFilter === k ? "active" : ""}" data-kf="${k}">${k.toUpperCase()}</button>`).join("");
    $$("#ledgerPills .lane-tab").forEach(b => b.addEventListener("click", () => { ledgerFilter = b.dataset.kf; renderLedger(); }));
    let list = DB.listLedger();
    if (ledgerFilter !== "all") list = list.filter(e => e.kind === ledgerFilter);
    $("#ledgerRows").innerHTML = list.length ? list.map(e => `
      <div class="ledger-row">
        <div class="grow"><strong>${esc(e.label)}</strong>
          <div class="muted small">${ago(e.created_at)} · ${esc(e.note)}</div></div>
        <span class="stat-chip ${e.kind === "sale" ? "ok" : e.kind === "expense" ? "bad" : "pend"}">${e.kind.toUpperCase()}</span>
        <strong class="${e.amount >= 0 ? "amt-pos" : "amt-neg"}">${e.amount >= 0 ? "" : "-"}${ugx(Math.abs(e.amount))}</strong>
        ${e.kind !== "sale" ? `<button class="lnk dim" data-del-entry="${esc(e.id)}">Delete</button>` : ""}
      </div>`).join("") : `<div class="card"><p class="muted" style="padding:20px">The book is empty for this filter.</p></div>`;
  }
  function ledgerModal() {
    Keys.require(() => openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Record Ledger Entry</h3>
      <p class="muted small" style="margin-bottom:12px">Record expenses, boda fuel floats, supplies, or cash adjustments.</p>
      <div class="field"><label>Entry category</label>
        <select class="sel-full" id="mlKind">${DB.LEDGER_KINDS.filter(k => k !== "sale").map(k => `<option value="${k}">${DB.LEDGER_KIND_LABELS[k]}</option>`).join("")}</select></div>
      <div class="field"><label>Amount in UGX</label><input class="sel-full" id="mlAmount" type="number" min="0" placeholder="e.g. 15000" /></div>
      <div class="field"><label>Payment channel</label>
        <select class="sel-full" id="mlChannel"><option value="cash">Cash Drawer</option><option value="mtn">MTN MoMo Float</option><option value="airtel">Airtel Money Float</option></select></div>
      <div class="field"><label>Description / reason</label><input class="sel-full" id="mlLabel" placeholder="e.g. Boda rider delivery fuel float – Jinja dispatch" /></div>
      <button class="btn primary big" style="width:100%" id="mlSave">Save Entry to Book</button>`));
  }

  /* ============================================================
     STAFF & PERMISSIONS
     ============================================================ */
  function renderStaff() {
    const locked = Auth.locked();
    $("#lockToggle").checked = locked;
    $("#lockState").textContent = locked ? "Access lock ON — terminals require a staff key" : "Open access mode — stores & terminals are unlocked";
    $("#staffRows").innerHTML = DB.listStaff().map(s => `
      <div class="staff-row ${s.active ? "" : "off"}">
        <span class="avatar" style="background:${avColor(s.name)}">${initials(s.name)}</span>
        <div class="grow">
          <div class="guest-name" style="margin:0">${esc(s.name)}${s.active ? "" : " <span class='stat-chip bad'>DEACTIVATED</span>"}</div>
          <div class="muted small">${esc(s.email || "—")}${s.phone ? " · " + esc(s.phone) : ""}</div>
        </div>
        <span class="stat-chip role-${esc(s.role)}">${s.role.toUpperCase()}</span>
        <button class="lnk" data-key-staff="${esc(s.id)}">Edit Key</button>
        ${s.role === "admin" && DB.listStaff().filter(x => x.role === "admin" && x.active).length <= 1 && s.active
          ? "" : `<button class="lnk dim" data-toggle-staff="${esc(s.id)}">${s.active ? "Deactivate" : "Activate"}</button>`}
      </div>`).join("");
  }
  function staffModal() {
    Keys.require(() => openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Register Staff Member</h3>
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
      </div>`));
  }
  function keyModal(id) {
    const s = DB.listStaff().find(x => x.id === id); if (!s) return;
    Keys.require(() => openModal(`
      <button class="modal-x" data-close>×</button>
      <h3>Edit Key — ${esc(s.name)}</h3>
      <p class="muted small">4–8 digit PIN or a word of 6+ characters. Leave blank to clear the key (open mode only).</p>
      <div class="field" style="margin-top:10px"><label>New staff key</label>
        <input class="sel-full" id="mePin" autocomplete="off" /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-reset-pin="${esc(s.id)}">Save Key</button>
      </div>`));
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
    Keys.require(async () => {
      await DB.updateSettings({
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
        base_delivery_fee: Number($("#setFee").value) || 0
      });
      const newKey = $("#setKey").value.trim();
      if (newKey) { await DB.setMasterKey(newKey); toast("Configuration saved — master key rotated"); }
      else toast("Configuration saved — live across storefront & terminals");
      renderSettings();
    });
  }
  $("#btnSaveCfg").addEventListener("click", saveSettings);

  /* ============================================================
     global click delegation
     ============================================================ */
  document.body.addEventListener("click", async e => {
    const t = e.target;

    /* order pipeline */
    const sp = t.closest("[data-set-paid]");
    if (sp) {
      try {
        const method = sp.dataset.method || "cash";
        await DB.setPaymentStatus(sp.dataset.setPaid, true, method, whoName);
        toast(`${sp.dataset.setPaid} marked as PAID (${method.toUpperCase()})`);
        if ($("#modalBox") && $("#modalBox").children.length && $("#modalBox").querySelector(".odm-head")) {
          orderDetailModal(sp.dataset.setPaid);
        }
        renderSales();
      } catch (err) { toast(err.message, false); }
      return;
    }
    const su = t.closest("[data-set-unpaid]");
    if (su) {
      try {
        await DB.setPaymentStatus(su.dataset.setUnpaid, false, "whatsapp", whoName);
        toast(`${su.dataset.setUnpaid} marked as UNPAID`);
        if ($("#modalBox") && $("#modalBox").children.length && $("#modalBox").querySelector(".odm-head")) {
          orderDetailModal(su.dataset.setUnpaid);
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
    const sp = t.closest("[data-save-prod]");
    if (sp) {
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
        if (sp.dataset.saveProd) { await DB.updateProduct(sp.dataset.saveProd, vals); toast("Item updated — live everywhere"); }
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
          role: $("#msRole").value, pin: $("#msPin").value
        });
        if (!$("#msActive").checked) await DB.setStaffActive(rec.id, false);
        closeModal(); toast(`Staff account created for ${rec.name}`);
      } catch (err) { toast(err.message, false); }
      return;
    }
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
    lastTouch = Date.now();
  }
  window.renderAll = render;
  DB.on("*", () => render());
  window.addEventListener("resize", () => { if (currentView === "overview") renderOverview(); });

  setView(currentView, false);
})();
