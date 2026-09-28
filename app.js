/* ============ Adonai Store OPS — app logic ============ */
(function () {
  "use strict";

  /* ---------- State (localStorage backed) ---------- */
  const LS_KEY = "adonai-ops-state-v1";

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to seed */ }
    const orders = generateSeedOrders();
    return {
      products: JSON.parse(JSON.stringify(SEED_PRODUCTS)),
      customers: JSON.parse(JSON.stringify(SEED_CUSTOMERS)),
      orders,
      payments: derivePayments(orders, SEED_CUSTOMERS)
    };
  }

  let state = loadState();
  const save = () => localStorage.setItem(LS_KEY, JSON.stringify(state));

  /* ---------- Helpers ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const ugx = n => "UGX " + Number(n).toLocaleString("en-UG");
  const dstr = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
      " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  const isToday = iso => {
    const d = new Date(iso), n = new Date();
    return d.toDateString() === n.toDateString();
  };
  const daysAgo = (iso, n) => {
    const d = new Date(iso), cut = new Date();
    cut.setDate(cut.getDate() - n);
    return d >= cut;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const customerName = id => (state.customers.find(c => c.id === id) || {}).name || id;

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* ---------- Navigation ---------- */
  const TITLES = { overview: "Overview", orders: "Orders", inventory: "Inventory", customers: "Customers", payments: "Payments" };
  let currentView = "overview";
  let orderFilter = "all";
  let searchTerm = "";

  function setView(v) {
    currentView = v;
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    $("#pageTitle").textContent = TITLES[v];
    render();
  }

  $$(".nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  document.body.addEventListener("click", e => {
    const goto = e.target.closest("[data-goto]");
    if (goto) setView(goto.dataset.goto);
  });

  /* ---------- Search ---------- */
  $("#globalSearch").addEventListener("input", e => {
    searchTerm = e.target.value.trim().toLowerCase();
    render();
  });
  const matches = (...fields) => !searchTerm || fields.some(f => String(f).toLowerCase().includes(searchTerm));

  /* ---------- KPIs & overview ---------- */
  function computedStats() {
    const todayOrders = state.orders.filter(o => isToday(o.createdAt) && o.status !== "cancelled");
    const revToday = todayOrders.reduce((s, o) => s + o.total, 0);
    const rev7 = state.orders.filter(o => daysAgo(o.createdAt, 7) && o.status !== "cancelled")
                             .reduce((s, o) => s + o.total, 0);
    const pending = state.orders.filter(o => o.status === "pending").length;
    const lowStock = state.products.filter(p => p.stock > 0 && p.stock <= p.reorderAt);
    const outStock = state.products.filter(p => p.stock <= 0);
    return { todayOrders, revToday, rev7, pending, lowStock, outStock };
  }

  function renderKPIs() {
    const s = computedStats();
    $("#kpis").innerHTML = [
      { label: "Revenue today", value: ugx(s.revToday), sub: s.todayOrders.length + " orders today", cls: "green" },
      { label: "Revenue · 7 days", value: ugx(s.rev7), sub: "excl. cancelled", cls: "" },
      { label: "Pending orders", value: s.pending, sub: "need action", cls: "amber" },
      { label: "Low / out of stock", value: (s.lowStock.length + s.outStock.length), sub: s.outStock.length + " fully out", cls: "red" }
    ].map(k => `
      <div class="kpi ${k.cls}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>`).join("");
  }

  function renderChart() {
    const cv = $("#revenueChart");
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth - 36;
    const h = 220;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";

    // last 14 days revenue buckets
    const buckets = [];
    for (let d = 13; d >= 0; d--) {
      const day = new Date(); day.setDate(day.getDate() - d);
      const key = day.toDateString();
      const sum = state.orders
        .filter(o => new Date(o.createdAt).toDateString() === key && o.status !== "cancelled")
        .reduce((s, o) => s + o.total, 0);
      buckets.push({ label: day.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), sum });
    }
    $("#chartTotal").textContent = ugx(buckets.reduce((s, b) => s + b.sum, 0)) + " total";

    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const max = Math.max(...buckets.map(b => b.sum), 1);
    const padL = 8, padB = 22, padT = 10;
    const cw = (w - padL * 2) / buckets.length;

    // gridlines
    ctx.strokeStyle = "rgba(139,149,184,.15)";
    ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const y = padT + (h - padB - padT) * (g / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padL, y); ctx.stroke();
    }

    buckets.forEach((b, i) => {
      const bh = (b.sum / max) * (h - padB - padT);
      const x = padL + i * cw + cw * 0.2;
      const y = h - padB - bh;
      const grad = ctx.createLinearGradient(0, y, 0, h - padB);
      grad.addColorStop(0, "#6c7bff");
      grad.addColorStop(1, "rgba(108,123,255,.25)");
      ctx.fillStyle = grad;
      const bw = cw * 0.6, r = 4;
      ctx.beginPath();
      ctx.moveTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.arcTo(x + bw, y, x + bw, y + r, r);
      ctx.lineTo(x + bw, h - padB);
      ctx.lineTo(x, h - padB);
      ctx.closePath(); ctx.fill();

      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(139,149,184,.8)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(b.label.split(" ")[0] + " " + b.label.split(" ")[1], x + bw / 2, h - 6);
      }
    });
  }

  function renderPipeline() {
    const counts = {};
    STATUSES.concat(["shipped"]).forEach(s => counts[s] = 0);
    state.orders.forEach(o => counts[o.status] = (counts[o.status] || 0) + 1);
    const max = Math.max(...Object.values(counts), 1);
    const colors = { pending: "#ffb454", paid: "#6c7bff", shipped: "#38bdf8", delivered: "#4dd6a5", cancelled: "#ff6b7a" };
    $("#pipeline").innerHTML = STATUSES.map(st => `
      <div class="pipe-row">
        <div class="lbl">${st}</div>
        <div class="pipe-track"><div class="pipe-fill" style="width:${(counts[st] / max) * 100}%;background:${colors[st]}"></div></div>
        <div class="val">${counts[st]}</div>
      </div>`).join("");
  }

  function orderRow(o, actions) {
    const items = o.items.map(i => `${i.qty}× ${i.name}`).join(", ");
    return `<tr>
      <td><strong>${esc(o.id)}</strong></td>
      <td>${esc(customerName(o.customerId))}</td>
      <td class="rowdim">${esc(items)}</td>
      <td class="num">${ugx(o.total)}</td>
      <td>${esc(o.method)}</td>
      <td class="rowdim">${dstr(o.createdAt)}</td>
      <td><span class="status ${o.status}">${o.status}</span></td>
      ${actions ? "<td>" + actions(o) + "</td>" : ""}
    </tr>`;
  }

  function orderActions(o) {
    const flow = { pending: "paid", paid: "shipped", shipped: "delivered" };
    let btns = "";
    if (flow[o.status]) {
      btns += `<button class="btn sm primary" data-adv="${o.id}" data-to="${flow[o.status]}">→ ${flow[o.status]}</button> `;
    }
    if (!["delivered", "cancelled"].includes(o.status)) {
      btns += `<button class="btn sm danger" data-cancel="${o.id}">✕</button>`;
    }
    return btns;
  }

  function renderLatestOrders() {
    const rows = state.orders.slice(0, 6).map(o => orderRow(o)).join("");
    $("#latestOrdersTbl").innerHTML =
      `<thead><tr><th>Order</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Method</th><th>Placed</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function renderLowStock() {
    const s = computedStats();
    const items = [...s.outStock, ...s.lowStock];
    $("#lowStockList").innerHTML = items.length ? items.map(p => `
      <div class="alert">
        <div>${p.stock <= 0 ? "🚫" : "⚠️"}</div>
        <div class="grow">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${esc(p.id)} · reorder at ${p.reorderAt}</div>
        </div>
        <span class="status ${p.stock <= 0 ? "out" : "low"}">${p.stock <= 0 ? "out" : p.stock + " left"}</span>
        <button class="btn sm" data-restock="${p.id}">Restock</button>
      </div>`).join("") :
      `<p class="muted">All stock levels healthy ✅</p>`;
  }

  /* ---------- Orders view ---------- */
  function renderOrders() {
    let list = state.orders.filter(o => orderFilter === "all" || o.status === orderFilter);
    list = list.filter(o => matches(o.id, customerName(o.customerId), o.method, o.items.map(i => i.name).join(" ")));
    $("#ordersTbl").innerHTML =
      `<thead><tr><th>Order</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Method</th><th>Placed</th><th>Status</th><th>Actions</th></tr></thead>
       <tbody>${list.length ? list.map(o => orderRow(o, orderActions)).join("") :
         `<tr><td colspan="8" class="rowdim" style="padding:24px">No orders match.</td></tr>`}</tbody>`;
    const pendingCount = state.orders.filter(o => o.status === "pending").length;
    $("#navOrdersBadge").textContent = pendingCount || "";
  }

  $("#orderFilters").addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    orderFilter = chip.dataset.status;
    $$("#orderFilters .chip").forEach(c => c.classList.toggle("active", c === chip));
    renderOrders();
  });

  function advanceOrder(id, to) {
    const o = state.orders.find(x => x.id === id);
    if (!o) return;
    o.status = to;

    if (to === "paid" && !state.payments.some(p => p.orderId === id)) {
      state.payments.unshift({
        id: "PAY-" + id.slice(4), orderId: id,
        customer: customerName(o.customerId), method: o.method,
        amount: o.total, date: new Date().toISOString()
      });
    }
    if (to === "shipped") {
      o.items.forEach(it => {
        const p = state.products.find(pr => pr.id === it.productId);
        if (p) p.stock = Math.max(0, p.stock - it.qty);
      });
    }
    save(); render();
    toast(`Order ${id} marked as ${to}`);
  }

  function cancelOrder(id) {
    const o = state.orders.find(x => x.id === id);
    if (!o) return;
    o.status = "cancelled";
    save(); render();
    toast(`Order ${id} cancelled`);
  }

  /* ---------- Inventory view ---------- */
  function renderInventory() {
    const list = state.products.filter(p => matches(p.id, p.name, p.category));
    $("#inventoryTbl").innerHTML =
      `<thead><tr><th>SKU</th><th>Product</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th><th>Actions</th></tr></thead>
       <tbody>${list.length ? list.map(p => {
         const st = p.stock <= 0 ? "out" : p.stock <= p.reorderAt ? "low" : "ok";
         return `<tr>
           <td class="rowdim">${esc(p.id)}</td>
           <td><strong>${esc(p.name)}</strong></td>
           <td>${esc(p.category)}</td>
           <td class="num">${ugx(p.price)}</td>
           <td class="num">${p.stock}</td>
           <td><span class="status ${st}">${st === "ok" ? "in stock" : st}</span></td>
           <td>
             <button class="btn sm" data-restock="${p.id}">+ Stock</button>
             <button class="btn sm" data-editprod="${p.id}">Edit</button>
           </td>
         </tr>`;
       }).join("") : `<tr><td colspan="7" class="rowdim" style="padding:24px">No products match.</td></tr>`}</tbody>`;

    const s = computedStats();
    $("#navStockBadge").textContent = (s.lowStock.length + s.outStock.length) || "";
  }

  /* ---------- Customers view ---------- */
  function renderCustomers() {
    const list = state.customers.filter(c => matches(c.id, c.name, c.area, c.phone));
    $("#customersTbl").innerHTML =
      `<thead><tr><th>Customer</th><th>Phone</th><th>Area</th><th class="num">Orders</th><th class="num">Lifetime value</th></tr></thead>
       <tbody>${list.map(c => {
         const cos = state.orders.filter(o => o.customerId === c.id && o.status !== "cancelled");
         const ltv = cos.reduce((s, o) => s + o.total, 0);
         return `<tr>
           <td><strong>${esc(c.name)}</strong><div class="rowdim small">${esc(c.id)}</div></td>
           <td>${esc(c.phone)}</td>
           <td>${esc(c.area)}</td>
           <td class="num">${cos.length}</td>
           <td class="num">${ugx(ltv)}</td>
         </tr>`;
       }).join("")}</tbody>`;
  }

  /* ---------- Payments view ---------- */
  function renderPayments() {
    const list = state.payments.filter(p => matches(p.id, p.orderId, p.customer, p.method));
    const today = state.payments.filter(p => isToday(p.date)).reduce((s, p) => s + p.amount, 0);
    const byMethod = {};
    state.payments.forEach(p => byMethod[p.method] = (byMethod[p.method] || 0) + p.amount);
    const topMethod = Object.entries(byMethod).sort((a, b) => b[1] - a[1])[0] || ["—", 0];

    $("#payKpis").innerHTML = [
      { label: "Collected today", value: ugx(today), cls: "green" },
      { label: "Total collected", value: ugx(state.payments.reduce((s, p) => s + p.amount, 0)), cls: "" },
      { label: "Top method", value: esc(topMethod[0]), cls: "" },
      { label: "Transactions", value: state.payments.length, cls: "amber" }
    ].map(k => `
      <div class="kpi ${k.cls}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
      </div>`).join("");

    $("#paymentsTbl").innerHTML =
      `<thead><tr><th>Payment</th><th>Order</th><th>Customer</th><th>Method</th><th class="num">Amount</th><th>Date</th></tr></thead>
       <tbody>${list.length ? list.map(p => `
         <tr>
           <td><strong>${esc(p.id)}</strong></td>
           <td class="rowdim">${esc(p.orderId)}</td>
           <td>${esc(p.customer)}</td>
           <td>${esc(p.method)}</td>
           <td class="num">${ugx(p.amount)}</td>
           <td class="rowdim">${dstr(p.date)}</td>
         </tr>`).join("") : `<tr><td colspan="6" class="rowdim" style="padding:24px">No payments yet.</td></tr>`}</tbody>`;
  }

  /* ---------- Modals ---------- */
  const backdrop = $("#modalBackdrop");
  const modalBox = $("#modalBox");
  const openModal = html => { modalBox.innerHTML = html; backdrop.classList.add("open"); };
  const closeModal = () => backdrop.classList.remove("open");
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeModal(); });

  function newOrderModal() {
    openModal(`
      <h3>New order</h3>
      <div class="field">
        <label>Customer</label>
        <select id="moCustomer">${state.customers.map(c => `<option value="${c.id}">${esc(c.name)} — ${esc(c.area)}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label>Product</label>
        <select id="moProduct">${state.products.filter(p => p.stock > 0).map(p => `<option value="${p.id}">${esc(p.name)} (${ugx(p.price)}) — ${p.stock} in stock</option>`).join("")}</select>
      </div>
      <div class="field">
        <label>Quantity</label>
        <input id="moQty" type="number" min="1" value="1" />
      </div>
      <div class="field">
        <label>Payment method</label>
        <select id="moMethod">${METHODS.map(m => `<option>${m}</option>`).join("")}</select>
      </div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-create-order>Create order</button>
      </div>`);
  }

  function productModal(editId) {
    const p = editId ? state.products.find(x => x.id === editId) : null;
    openModal(`
      <h3>${p ? "Edit product" : "Add product"}</h3>
      <div class="field"><label>Name</label><input id="mpName" value="${p ? esc(p.name) : ""}" placeholder="Product name" /></div>
      <div class="field"><label>Category</label><input id="mpCat" value="${p ? esc(p.category) : ""}" placeholder="e.g. Apparel" /></div>
      <div class="field"><label>Price (UGX)</label><input id="mpPrice" type="number" min="0" value="${p ? p.price : ""}" /></div>
      <div class="field"><label>Stock</label><input id="mpStock" type="number" min="0" value="${p ? p.stock : ""}" /></div>
      <div class="field"><label>Reorder threshold</label><input id="mpReorder" type="number" min="0" value="${p ? p.reorderAt : 10}" /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save-prod="${p ? p.id : ""}">${p ? "Save changes" : "Add product"}</button>
      </div>`);
  }

  function restockModal(id) {
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    openModal(`
      <h3>Restock — ${esc(p.name)}</h3>
      <p class="muted small" style="margin-bottom:12px">Current stock: <strong>${p.stock}</strong></p>
      <div class="field"><label>Units to add</label><input id="mrQty" type="number" min="1" value="10" autofocus /></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-do-restock="${p.id}">Add stock</button>
      </div>`);
  }

  /* ---------- Modal / table action delegation ---------- */
  document.body.addEventListener("click", e => {
    const t = e.target;
    if (t.closest("[data-close]")) return closeModal();

    const adv = t.closest("[data-adv]");      if (adv) return advanceOrder(adv.dataset.adv, adv.dataset.to);
    const cnl = t.closest("[data-cancel]");   if (cnl) return cancelOrder(cnl.dataset.cancel);
    const rst = t.closest("[data-restock]");  if (rst) return restockModal(rst.dataset.restock);
    const edp = t.closest("[data-editprod]"); if (edp) return productModal(edp.dataset.editprod);

    if (t.closest("[data-create-order]")) {
      const pid = $("#moProduct").value;
      const qty = Math.max(1, parseInt($("#moQty").value, 10) || 1);
      const p = state.products.find(x => x.id === pid);
      if (!p) return;
      const nextNum = Math.max(...state.orders.map(o => parseInt(o.id.slice(4), 10)), 1041) + 1;
      state.orders.unshift({
        id: "ORD-" + nextNum,
        customerId: $("#moCustomer").value,
        items: [{ productId: p.id, name: p.name, qty, price: p.price }],
        total: p.price * qty,
        method: $("#moMethod").value,
        status: "pending",
        createdAt: new Date().toISOString()
      });
      save(); closeModal(); render();
      toast("Order ORD-" + nextNum + " created");
      return;
    }

    const sp = t.closest("[data-save-prod]");
    if (sp) {
      const id = sp.dataset.saveProd;
      const vals = {
        name: $("#mpName").value.trim() || "Untitled product",
        category: $("#mpCat").value.trim() || "General",
        price: Math.max(0, parseInt($("#mpPrice").value, 10) || 0),
        stock: Math.max(0, parseInt($("#mpStock").value, 10) || 0),
        reorderAt: Math.max(0, parseInt($("#mpReorder").value, 10) || 0)
      };
      if (id) {
        Object.assign(state.products.find(x => x.id === id), vals);
        toast("Product updated");
      } else {
        const next = "PRD-" + String(Math.max(...state.products.map(p => parseInt(p.id.slice(4), 10)), 0) + 1).padStart(3, "0");
        state.products.push({ id: next, ...vals });
        toast("Product " + next + " added");
      }
      save(); closeModal(); render();
      return;
    }

    const dr = t.closest("[data-do-restock]");
    if (dr) {
      const p = state.products.find(x => x.id === dr.dataset.doRestock);
      const qty = Math.max(1, parseInt($("#mrQty").value, 10) || 1);
      if (p) { p.stock += qty; toast(p.name + " restocked (+ " + qty + ")"); }
      save(); closeModal(); render();
    }
  });

  $("#btnNewOrder").addEventListener("click", newOrderModal);
  $("#btnAddProduct").addEventListener("click", () => productModal(null));

  /* ---------- Render dispatcher ---------- */
  function render() {
    if (currentView === "overview") { renderKPIs(); renderChart(); renderPipeline(); renderLatestOrders(); renderLowStock(); }
    if (currentView === "orders") renderOrders();
    if (currentView === "inventory") renderInventory();
    if (currentView === "customers") renderCustomers();
    if (currentView === "payments") renderPayments();
    // keep nav badges fresh regardless of view
    $("#navOrdersBadge").textContent = state.orders.filter(o => o.status === "pending").length || "";
    const s = computedStats();
    $("#navStockBadge").textContent = (s.lowStock.length + s.outStock.length) || "";
  }

  window.addEventListener("resize", () => { if (currentView === "overview") renderChart(); });

  /* ---------- Boot ---------- */
  $("#todayLine").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  render();
})();
