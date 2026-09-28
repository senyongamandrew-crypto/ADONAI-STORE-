/* ============ Adonai OPS Dashboard — admin logic (reads the shared DB) ============ */
(function () {
  "use strict";

  const me = Auth.guard({ role: "admin" });      // open access until the lock is enabled
  if (Auth.locked() && !me) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const dstr = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " +
           d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  const isToday = iso => new Date(iso).toDateString() === new Date().toDateString();
  const daysAgo = (iso, n) => { const c = new Date(); c.setDate(c.getDate() - n); return new Date(iso) >= c; };

  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* ---------- navigation ---------- */
  const TITLES = { overview: "Overview", sales: "Sales", inventory: "Inventory", customers: "Customers", payments: "Payments", staff: "Staff & Access" };
  let currentView = "overview";
  let salesScope = "all";
  let term = "";

  function setView(v) {
    currentView = v;
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    $("#pageTitle").textContent = TITLES[v];
    render();
  }
  $$(".nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  document.body.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]"); if (g) setView(g.dataset.goto);
  });
  $("#globalSearch").addEventListener("input", e => { term = e.target.value.trim().toLowerCase(); render(); });
  const matches = (...f) => !term || f.some(x => String(x).toLowerCase().includes(term));

  /* ---------- derived data ---------- */
  function allSales() { return DB.listSales(); }
  function validSales() { return allSales().filter(s => s.status === "completed"); }
  const tenderLabel = t => !t ? "—" : { cash: "Cash", mtn: "MTN MoMo", airtel: "Airtel Money", whatsapp: "WhatsApp (pending)" }[t.type] || t.type;
  const channelBadge = ch => ch === "pos"
    ? `<span class="tag tag-pos">🖥 POS</span>` : `<span class="tag tag-web">💬 WEB</span>`;
  const statusBadge = st => `<span class="status ${st === "completed" ? "delivered" : st === "pending" ? "pending" : "cancelled"}">${st}</span>`;
  const itemsSummary = s => s.items.map(l => `${l.qty}× ${l.name}`).join(", ");

  /* ---------- OVERVIEW ---------- */
  function stats() {
    const sales = validSales();
    const today = sales.filter(s => isToday(s.created_at));
    const rev = list => list.reduce((s, x) => s + x.total, 0);
    const units = list => list.reduce((s, x) => s + x.items.reduce((a, l) => a + l.qty, 0), 0);
    const pos = today.filter(s => s.channel === "pos"), web = today.filter(s => s.channel === "web");
    const pendingWeb = allSales().filter(s => s.channel === "web" && s.status === "pending");
    const outStock = DB.listProducts().filter(p => p.in_stock_count <= 0);
    return {
      revToday: rev(today), aov: today.length ? Math.round(rev(today) / today.length) : 0,
      units: units(today), txns: today.length,
      revPos: rev(pos), revWeb: rev(web), txPos: pos.length, txWeb: web.length,
      pendingWeb, outStock
    };
  }

  function renderKPIs() {
    const s = stats();
    $("#kpis").innerHTML = [
      { label: "Revenue today", value: DB.ugx(s.revToday), sub: `${s.txns} sales · ${s.units} items`, cls: "green" },
      { label: "Avg order (today)", value: DB.ugx(s.aov), sub: "across channels", cls: "" },
      { label: "Pending web orders", value: s.pendingWeb.length, sub: "WhatsApp to confirm", cls: "amber" },
      { label: "Out of stock", value: s.outStock.length, sub: "pieces fully sold", cls: "red" }
    ].map(k => `
      <div class="kpi ${k.cls}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>`).join("");
  }

  function renderChart() {
    const cv = $("#revenueChart"); if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || (cv.parentElement.clientWidth - 36) || 480, h = 220;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";

    const sales = validSales();
    const buckets = [];
    for (let d = 13; d >= 0; d--) {
      const day = new Date(); day.setDate(day.getDate() - d);
      const key = day.toDateString();
      const on = ch => sales.filter(s => new Date(s.created_at).toDateString() === key && s.channel === ch)
                            .reduce((sum, x) => sum + x.total, 0);
      buckets.push({ label: day.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), pos: on("pos"), web: on("web") });
    }
    $("#chartTotal").textContent = DB.ugx(buckets.reduce((s, b) => s + b.pos + b.web, 0)) + " total";

    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const max = Math.max(...buckets.map(b => b.pos + b.web), 1);
    const padL = 8, padB = 22, padT = 10, cw = (w - padL * 2) / buckets.length;

    ctx.strokeStyle = "rgba(139,149,184,.15)"; ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const y = padT + (h - padB - padT) * (g / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padL, y); ctx.stroke();
    }
    buckets.forEach((b, i) => {
      const x = padL + i * cw + cw * 0.2, bw = cw * 0.6;
      const hPos = (b.pos / max) * (h - padB - padT);
      const hWeb = (b.web / max) * (h - padB - padT);
      ctx.fillStyle = "#6c7bff";
      ctx.fillRect(x, h - padB - hPos, bw, hPos);                       // POS (bottom)
      ctx.fillStyle = "#4dd6a5";
      ctx.fillRect(x, h - padB - hPos - hWeb, bw, hWeb);                // Web (stacked)
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(139,149,184,.8)"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(b.label, x + bw / 2, h - 6);
      }
    });
  }

  function renderChannelSplit() {
    const s = stats();
    const total = Math.max(1, s.revPos + s.revWeb);
    const pPos = Math.round((s.revPos / total) * 100);
    $("#channelSplit").innerHTML = `
      <div class="pipe-row"><div class="lbl">In-store POS</div>
        <div class="pipe-track"><div class="pipe-fill" style="width:${pPos}%;background:#6c7bff"></div></div>
        <div class="val">${DB.ugx(s.revPos)}</div></div>
      <div class="pipe-row"><div class="lbl">WhatsApp web</div>
        <div class="pipe-track"><div class="pipe-fill" style="width:${100 - pPos}%;background:#4dd6a5"></div></div>
        <div class="val">${DB.ugx(s.revWeb)}</div></div>
      <p class="muted small" style="margin-top:10px">${s.txPos} counter sale(s) · ${s.txWeb} online order(s) today</p>`;
  }

  function renderLatestSales() {
    const rows = allSales().slice(0, 7).map(s => `
      <tr>
        <td><strong>${esc(s.id)}</strong></td>
        <td>${channelBadge(s.channel)}</td>
        <td class="rowdim">${esc(itemsSummary(s))}</td>
        <td class="num">${DB.ugx(s.total)}</td>
        <td class="rowdim">${dstr(s.created_at)}</td>
        <td>${statusBadge(s.status)}</td>
      </tr>`).join("");
    $("#latestSalesTbl").innerHTML = `<thead><tr><th>Sale</th><th>Channel</th><th>Items</th><th class="num">Total</th><th>When</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function renderStockAlerts() {
    const out = DB.listProducts().filter(p => p.in_stock_count <= 0);
    $("#lowStockList").innerHTML = out.length ? out.map(p => `
      <div class="alert">
        <div>🏷️</div>
        <div class="grow">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${esc(p.barcode_id)} · ${esc(p.category)} · sold at ${DB.ugx(p.selling_price)}</div>
        </div>
        <span class="status out">sold</span>
        <button class="btn sm" data-restock="${esc(p.id)}">Restock</button>
      </div>`).join("") : `<p class="muted">Everything is in stock ✅</p>`;
  }

  /* ---------- SALES ---------- */
  function renderSales() {
    let list = allSales();
    if (["pos", "web"].includes(salesScope)) list = list.filter(s => s.channel === salesScope);
    if (["pending", "completed", "cancelled"].includes(salesScope)) list = list.filter(s => s.status === salesScope);
    list = list.filter(s => matches(s.id, itemsSummary(s), s.customer_name, s.cashier && s.cashier.name, tenderLabel(s.tender)));

    const webPending = allSales().filter(s => s.channel === "web" && s.status === "pending").length;
    $("#navWebBadge").textContent = webPending || "";

    $("#salesTbl").innerHTML = `
      <thead><tr><th>Sale</th><th>Channel</th><th>Items</th><th class="num">Total</th><th>Tender</th><th>Customer / Cashier</th><th>When</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.length ? list.map(s => `
        <tr>
          <td><strong>${esc(s.id)}</strong></td>
          <td>${channelBadge(s.channel)}</td>
          <td class="rowdim">${esc(itemsSummary(s))}</td>
          <td class="num">${DB.ugx(s.total)}</td>
          <td>${esc(tenderLabel(s.tender))}${s.tender && s.tender.ref ? `<div class="rowdim small">ref ${esc(s.tender.ref)}</div>` : ""}</td>
          <td>${esc(s.channel === "web" ? (s.customer_name + (s.customer_phone ? " · " + s.customer_phone : "")) : (s.cashier ? s.cashier.name : "Staff"))}</td>
          <td class="rowdim">${dstr(s.created_at)}</td>
          <td>${statusBadge(s.status)}</td>
          <td>
            ${s.channel === "web" && s.status === "pending" ? `
              <button class="btn sm primary" data-confirm-web="${esc(s.id)}">Confirm paid</button>
              <button class="btn sm danger" data-cancel-web="${esc(s.id)}">Cancel</button>` : ""}
            ${s.status === "completed" ? `<button class="btn sm" data-view-sale="${esc(s.id)}">Receipt</button>` : ""}
          </td>
        </tr>`).join("") : `<tr><td colspan="9" class="rowdim" style="padding:24px">No sales match.</td></tr>`}</tbody>`;
  }
  $("#salesFilters").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    salesScope = c.dataset.scope;
    $$("#salesFilters .chip").forEach(x => x.classList.toggle("active", x === c));
    renderSales();
  });

  /* ---------- INVENTORY ---------- */
  function renderInventory() {
    const list = DB.listProducts().filter(p => matches(p.id, p.barcode_id, p.name, p.category));
    const out = DB.listProducts().filter(p => p.in_stock_count <= 0).length;
    $("#navStockBadge").textContent = out || "";
    $("#inventoryTbl").innerHTML = `
      <thead><tr><th>Photo</th><th>SKU</th><th>Barcode</th><th>Item</th><th>Category</th><th class="num">Cost</th><th class="num">Selling</th><th class="num">Margin</th><th class="num">Stock</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.length ? list.map(p => {
        const st = p.in_stock_count <= 0 ? "out" : "ok";
        const margin = p.cost_price > 0 ? Math.round(((p.selling_price - p.cost_price) / p.cost_price) * 100) : null;
        return `<tr>
          <td><span class="pthumb">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : ""}</span></td>
          <td class="rowdim">${esc(p.id)}</td>
          <td><code>${esc(p.barcode_id)}</code></td>
          <td><strong>${esc(p.name)}</strong><div class="rowdim small">Size ${esc(p.size)} · ${esc(p.condition)}</div></td>
          <td>${esc(p.category)}</td>
          <td class="num">${DB.ugx(p.cost_price)}</td>
          <td class="num">${DB.ugx(p.selling_price)}</td>
          <td class="num">${margin === null ? "—" : margin + "%"}</td>
          <td class="num">${p.in_stock_count}</td>
          <td><span class="status ${st}">${st === "ok" ? "in stock" : "sold"}</span></td>
          <td>
            <button class="btn sm" data-restock="${esc(p.id)}">+ Stock</button>
            <button class="btn sm" data-editprod="${esc(p.id)}">Edit</button>
          </td>
        </tr>`;
      }).join("") : `<tr><td colspan="11" class="rowdim" style="padding:24px">No products match.</td></tr>`}</tbody>`;
  }

  /* ---------- CUSTOMERS ---------- */
  function renderCustomers() {
    const map = new Map();
    allSales().forEach(s => {
      if (s.status === "cancelled") return;
      const key = s.channel === "web" ? (s.customer_name || "Web customer") + "|" + (s.customer_phone || "") : "__walkin__";
      const cur = map.get(key) || { name: s.channel === "web" ? (s.customer_name || "Web customer") : "Walk-in customers (POS)", phone: s.channel === "web" ? s.customer_phone : "—", orders: 0, spent: 0 };
      cur.orders++; cur.spent += s.total; map.set(key, cur);
    });
    const rows = Array.from(map.values())
      .filter(c => matches(c.name, c.phone))
      .sort((a, b) => b.spent - a.spent)
      .map(c => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone || "—")}</td><td class="num">${c.orders}</td><td class="num">${DB.ugx(c.spent)}</td></tr>`).join("");
    $("#customersTbl").innerHTML = `<thead><tr><th>Customer</th><th>Phone</th><th class="num">Orders</th><th class="num">Lifetime value</th></tr></thead><tbody>${rows}</tbody>`;
  }

  /* ---------- PAYMENTS ---------- */
  function renderPayments() {
    const completed = validSales();
    const today = completed.filter(s => isToday(s.created_at));
    const sum = (l, f) => l.filter(f).reduce((s, x) => s + x.total, 0);
    const cash = sum(today, s => s.tender.type === "cash");
    const momo = sum(today, s => s.tender.type === "mtn" || s.tender.type === "airtel");
    $("#payKpis").innerHTML = [
      { label: "Collected today", value: DB.ugx(today.reduce((s, x) => s + x.total, 0)), cls: "green" },
      { label: "Cash today", value: DB.ugx(cash), cls: "" },
      { label: "MoMo today", value: DB.ugx(momo), cls: "" },
      { label: "Transactions today", value: today.length, cls: "amber" }
    ].map(k => `<div class="kpi ${k.cls}"><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div></div>`).join("");

    const rows = completed
      .filter(s => matches(s.id, tenderLabel(s.tender), s.customer_name, s.tender && s.tender.ref))
      .slice(0, 60)
      .map(s => {
        let detail = "—";
        if (s.tender.type === "cash") detail = `Tendered ${DB.ugx(s.tender.tendered)} · change ${DB.ugx(s.tender.change || 0)}`;
        else if (s.tender.type === "mtn" || s.tender.type === "airtel") detail = `Ref ${esc(s.tender.ref || "—")} · verified by ${esc(s.tender.verified_by || "staff")}`;
        return `<tr>
          <td><strong>${esc(s.id)}</strong></td>
          <td>${channelBadge(s.channel)}</td>
          <td>${esc(tenderLabel(s.tender))}</td>
          <td class="rowdim">${detail}</td>
          <td class="num">${DB.ugx(s.total)}</td>
          <td class="rowdim">${dstr(s.created_at)}</td>
        </tr>`;
      }).join("");
    $("#paymentsTbl").innerHTML = `<thead><tr><th>Sale</th><th>Channel</th><th>Method</th><th>Details</th><th class="num">Amount</th><th>When</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="rowdim" style="padding:24px">No payments yet.</td></tr>`}</tbody>`;
  }

  /* ---------- STAFF & ACCESS ---------- */
  function renderStaff() {
    const locked = DB.getSettings().access_locked;
    $("#lockToggle").checked = locked;
    $("#lockState").textContent = locked ? "🔒 Staff lock is ON — PIN required" : "🔓 Open access mode";
    const staff = DB.listStaff();
    $("#staffTbl").innerHTML = `
      <thead><tr><th>ID</th><th>Name</th><th>Role</th><th>PIN</th><th>Added</th><th></th></tr></thead>
      <tbody>${staff.length ? staff.map(s => `
        <tr>
          <td class="rowdim">${esc(s.id)}</td>
          <td><strong>${esc(s.name)}</strong></td>
          <td><span class="tag ${s.role === "admin" ? "tag-pos" : "tag-web"}">${s.role === "admin" ? "🛡 admin" : "🧾 cashier"}</span></td>
          <td><code>${esc(s.pin)}</code></td>
          <td class="rowdim">${dstr(s.created_at)}</td>
          <td>
            <button class="btn sm" data-resetpin="${esc(s.id)}">Reset PIN</button>
            <button class="btn sm danger" data-rmstaff="${esc(s.id)}">Remove</button>
          </td>
        </tr>`).join("") :
        `<tr><td colspan="6" class="rowdim" style="padding:24px">No staff accounts yet — the system is open to everyone. Add your first cashier or admin, then switch the lock on.</td></tr>`}</tbody>`;
  }

  /* ---------- modals ---------- */
  const backdrop = $("#modalBackdrop"), modalBox = $("#modalBox");
  const openModal = html => { modalBox.innerHTML = html; backdrop.classList.add("open"); };
  const closeModal = () => backdrop.classList.remove("open");
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeModal(); });

  let prodImageState = { image_url: "" };

  function productModal(editId) {
    const p = editId ? DB.getProduct(editId) : null;
    prodImageState = { image_url: p ? (p.image_url || "") : "" };
    openModal(`
      <h3>${p ? "Edit — " + esc(p.name) : "Add thrift item"}</h3>
      ${p ? `<p class="muted small" style="margin-bottom:10px">Barcode: <code>${esc(p.barcode_id)}</code> (scannable by the POS)</p>`
          : `<p class="muted small" style="margin-bottom:10px">A scannable barcode is generated automatically and the item goes live on the POS AND the storefront instantly.</p>`}
      <div class="field"><label>Name</label><input id="mpName" value="${p ? esc(p.name) : ""}" placeholder="e.g. Vintage Denim Jacket" /></div>
      <div class="grid two-fields">
        <div class="field"><label>Category</label>
          <select id="mpCat">${DB.CATEGORIES.map(c => `<option ${p && p.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label>Size</label><input id="mpSize" value="${p ? esc(p.size) : ""}" placeholder="M / 42 / -" /></div>
      </div>
      <div class="grid two-fields">
        <div class="field"><label>Condition</label>
          <select id="mpCond">${DB.CONDITIONS.map(c => `<option ${p && p.condition === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label>Stock count</label><input id="mpStock" type="number" min="0" value="${p ? p.in_stock_count : 1}" /></div>
      </div>
      <div class="grid two-fields">
        <div class="field"><label>Cost price (UGX)</label><input id="mpCost" type="number" min="0" value="${p ? p.cost_price : ""}" /></div>
        <div class="field"><label>Selling price (UGX)</label><input id="mpSell" type="number" min="0" value="${p ? p.selling_price : ""}" /></div>
      </div>
      ${Intake.imageFieldHTML(prodImageState.image_url)}
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-prod="${p ? esc(p.id) : ""}">${p ? "Save changes" : "Add item"}</button>
      </div>`);
    Intake.bindImageEditor(modalBox, prodImageState);
  }

  function restockModal(id) {
    const p = DB.getProduct(id); if (!p) return;
    openModal(`
      <h3>Restock — ${esc(p.name)}</h3>
      <p class="muted small" style="margin-bottom:12px">Currently in stock: <strong>${p.in_stock_count}</strong></p>
      <div class="field"><label>Units to add</label><input id="mrQty" type="number" min="1" value="1" autofocus /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-do-restock="${esc(p.id)}">Add stock</button>
      </div>`);
  }

  function confirmWebModal(id) {
    const s = DB.getSale(id); if (!s) return;
    openModal(`
      <h3>Confirm payment — ${esc(s.id)}</h3>
      <p class="muted small" style="margin-bottom:12px">
        ${esc(s.customer_name)} · ${DB.ugx(s.total)} via WhatsApp.<br/>Confirm how the customer paid:
      </p>
      <div class="field"><label>Payment method received</label>
        <select id="mcwMethod">
          <option value="cash">Cash</option>
          <option value="mtn">MTN MoMo</option>
          <option value="airtel">Airtel Money</option>
        </select></div>
      <div class="modal-actions">
        <button class="btn" data-close>Back</button>
        <button class="btn primary" data-do-confirm-web="${esc(s.id)}">Mark as paid</button>
      </div>`);
  }

  function saleDetailModal(id) {
    const s = DB.getSale(id); if (!s) return;
    const rows = s.items.map(l => `<tr><td>${esc(l.qty)}× ${esc(l.name)}</td><td class="num">${DB.ugx(l.unit_price)}</td><td class="num">${DB.ugx(l.line_total)}</td></tr>`).join("");
    let tender = "";
    if (s.tender.type === "cash") tender = `Cash — tendered ${DB.ugx(s.tender.tendered)}, change ${DB.ugx(s.tender.change || 0)}`;
    else if (s.tender.type === "mtn" || s.tender.type === "airtel") tender = `${tenderLabel(s.tender)} — ref ${esc(s.tender.ref || "—")}${s.tender.verified_by ? " · verified by " + esc(s.tender.verified_by) : ""}`;
    else tender = tenderLabel(s.tender);
    openModal(`
      <h3>Receipt — ${esc(s.id)}</h3>
      <p class="muted small" style="margin-bottom:10px">${dstr(s.created_at)} · ${s.channel === "pos" ? "In-store (POS)" : "WhatsApp web"} · served by ${esc(s.cashier ? s.cashier.name : s.customer_name)}</p>
      <table class="tbl"><thead><tr><th>Item</th><th class="num">Unit</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="tot-strip"><span>Total</span><strong>${DB.ugx(s.total)}</strong></div>
      <p class="muted small" style="margin-top:8px">${tender}</p>
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  }

  function staffModal() {
    openModal(`
      <h3>Add staff account</h3>
      <div class="field"><label>Full name</label><input id="msName" placeholder="e.g. Sarah Nakato" /></div>
      <div class="field"><label>Role</label>
        <select id="msRole"><option value="cashier">Cashier — POS only</option><option value="admin">Admin — POS + dashboard</option></select></div>
      <div class="field"><label>PIN (4–8 digits)</label><input id="msPin" inputmode="numeric" maxlength="8" placeholder="e.g. 4321" /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-staff>Create account</button>
      </div>`);
  }

  /* ---------- global action delegation ---------- */
  document.body.addEventListener("click", async e => {
    const t = e.target;
    if (t.closest("[data-close]")) return closeModal();

    const rst = t.closest("[data-restock]");   if (rst) return restockModal(rst.dataset.restock);
    const edp = t.closest("[data-editprod]");  if (edp) return productModal(edp.dataset.editprod);
    const cfw = t.closest("[data-confirm-web]"); if (cfw) return confirmWebModal(cfw.dataset.confirmWeb);
    const vs  = t.closest("[data-view-sale]"); if (vs) return saleDetailModal(vs.dataset.viewSale);

    const cxw = t.closest("[data-cancel-web]");
    if (cxw) {
      try { await DB.cancelWebOrder(cxw.dataset.cancelWeb); toast("Order cancelled — stock returned to the shelf"); }
      catch (err) { toast(err.message); }
      return;
    }

    const dcw = t.closest("[data-do-confirm-web]");
    if (dcw) {
      try {
        const s = await DB.confirmWebOrder(dcw.dataset.doConfirmWeb, $("#mcwMethod").value);
        closeModal(); toast(`${s.id} marked as paid ✓`);
      } catch (err) { toast(err.message); }
      return;
    }

    const dsp = t.closest("[data-save-prod]");
    if (dsp) {
      const vals = {
        name: $("#mpName").value.trim(), category: $("#mpCat").value, size: $("#mpSize").value.trim() || "-",
        condition: $("#mpCond").value, cost_price: Number($("#mpCost").value) || 0,
        selling_price: Number($("#mpSell").value) || 0, in_stock_count: Number($("#mpStock").value) || 0,
        image_url: prodImageState.image_url
      };
      if (!vals.name) return toast("Item name is required");
      try {
        if (dsp.dataset.saveProd) { await DB.updateProduct(dsp.dataset.saveProd, vals); toast("Item updated — live everywhere"); }
        else { const p = await DB.addProduct(vals); toast(`Added ${p.name} · barcode ${p.barcode_id}`); }
        closeModal();
      } catch (err) { toast(err.message); }
      return;
    }

    const dr = t.closest("[data-do-restock]");
    if (dr) {
      try {
        const p = await DB.adjustStock(dr.dataset.doRestock, Math.max(1, Number($("#mrQty").value) || 1));
        closeModal(); toast(`${p.name} — now ${p.in_stock_count} in stock`);
      } catch (err) { toast(err.message); }
      return;
    }

    const ss = t.closest("[data-save-staff]");
    if (ss) {
      try {
        const rec = await DB.addStaff({ name: $("#msName").value.trim(), role: $("#msRole").value, pin: $("#msPin").value.trim() });
        closeModal(); toast(`Staff account created for ${rec.name}`);
      } catch (err) { toast(err.message); }
      return;
    }

    const rm = t.closest("[data-rmstaff]");
    if (rm) {
      await DB.removeStaff(rm.dataset.rmstaff); toast("Staff account removed");
      return;
    }

    const rp = t.closest("[data-resetpin]");
    if (rp) {
      const pin = prompt("New PIN (4–8 digits):");
      if (pin === null) return;
      try { await DB.resetStaffPin(rp.dataset.resetpin, pin); toast("PIN updated"); }
      catch (err) { toast(err.message); }
    }
  });

  $("#btnAddProduct").addEventListener("click", () => productModal(null));
  $("#btnAddStaff").addEventListener("click", staffModal);
  $("#lockToggle").addEventListener("change", async e => {
    await DB.updateSettings({ access_locked: e.target.checked });
    toast(e.target.checked ? "🔒 Staff lock enabled — POS & dashboard now require a PIN" : "🔓 Open access mode enabled");
  });

  /* ---------- render dispatcher ---------- */
  function render() {
    if (currentView === "overview") { renderKPIs(); renderChart(); renderChannelSplit(); renderLatestSales(); renderStockAlerts(); }
    if (currentView === "sales") renderSales();
    if (currentView === "inventory") renderInventory();
    if (currentView === "customers") renderCustomers();
    if (currentView === "payments") renderPayments();
    if (currentView === "staff") renderStaff();
    // keep sidebar badges live on every view
    $("#navWebBadge").textContent = allSales().filter(s => s.channel === "web" && s.status === "pending").length || "";
    $("#navStockBadge").textContent = DB.listProducts().filter(p => p.in_stock_count <= 0).length || "";
  }

  /* real-time: POS sales / storefront orders land here instantly */
  DB.on("*", () => render());
  window.addEventListener("resize", () => { if (currentView === "overview") renderChart(); });

  $("#todayLine").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  render();
})();
