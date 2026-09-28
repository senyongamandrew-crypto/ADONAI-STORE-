/* ============ Adonai POS — cashier terminal logic ============ */
(function () {
  "use strict";

  /* ---------- route guard (open access while lock is off) ---------- */
  const me = Auth.guard({ role: null });
  if (Auth.locked() && !me) return; // redirect in flight

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const EMOJI = { Jackets: "🧥", Shirts: "👕", Shoes: "👟", Dresses: "👗", Trousers: "👖", Accessories: "👜" };

  /* ---------- header: cashier pill + network status ---------- */
  const cashier = me || { name: "Staff", role: Auth.locked() ? "staff" : "open access" };
  $("#meName").textContent = cashier.name;
  $("#meRole").textContent = cashier.role;
  $("#meRole").className = "role";
  $(".avatar", $("#mePill")).textContent = (cashier.name || "S").charAt(0).toUpperCase();

  function setNet() {
    const online = navigator.onLine;
    const pill = $("#netPill");
    pill.classList.toggle("offline", !online);
    pill.innerHTML = `<span class="dot"></span>${online ? "Online" : "Offline"}`;
  }
  window.addEventListener("online", setNet);
  window.addEventListener("offline", setNet);
  setNet();

  $("#btnExit").addEventListener("click", () => {
    Auth.signOut();                       // revoke staff privileges
    location.href = "index.html";         // back to public storefront
  });

  /* ---------- sound feedback ---------- */
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 920 : 210;
      o.type = ok ? "sine" : "square";
      g.gain.setValueAtTime(0.08, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (ok ? 0.09 : 0.22));
      o.connect(g).connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (ok ? 0.1 : 0.24));
    } catch (e) {}
  }

  /* ---------- scan feedback banner ---------- */
  let flashT;
  function flash(msg, ok) {
    const f = $("#scanFlash");
    f.textContent = msg;
    f.className = "scan-flash show " + (ok ? "ok" : "err");
    clearTimeout(flashT);
    flashT = setTimeout(() => { f.className = "scan-flash"; }, 1800);
  }

  /* ============================================================
     GLOBAL HARDWARE SCANNER LISTENER
     USB/Bluetooth scanners type characters in a rapid burst and
     finish with Enter. We buffer rapid keystrokes globally —
     no need to focus an input field.
     ============================================================ */
  let scanBuf = "", scanLast = 0;
  const SCAN_GAP_MS = 120, MIN_CODE_LEN = 4;

  window.addEventListener("keydown", e => {
    const el = e.target;
    const editable = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

    if (e.key === "Escape") { closeTender(); $("#receiptBackdrop").classList.remove("open"); return; }

    if (editable) { scanBuf = ""; return; } // manual typing handled by the input itself
    const now = Date.now();
    if (now - scanLast > SCAN_GAP_MS) scanBuf = "";
    scanLast = now;

    if (e.key === "Enter") {
      if (scanBuf.length >= MIN_CODE_LEN) {
        const code = scanBuf; scanBuf = "";
        e.preventDefault();
        handleScan(code);
      }
      scanBuf = "";
      return;
    }
    if (e.key.length === 1) scanBuf += e.key;
  }, true);

  $("#barcodeInput").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const code = e.target.value.trim();
      if (code) handleScan(code);
      e.target.value = "";
    }
  });

  function handleScan(code) {
    const p = DB.findByBarcode(code);
    if (!p) { flash(`✗ No product for barcode "${code}"`, false); beep(false); return; }
    if (p.in_stock_count <= 0) { flash(`✗ "${p.name}" is sold out`, false); beep(false); return; }
    if (!addLine(p.id)) return;
    flash(`✓ Added: ${p.name} — ${DB.ugx(p.selling_price)}`, true);
    beep(true);
  }

  /* ============================================================
     MANUAL LOOKUP GRID
     ============================================================ */
  let products = [];
  let activeCat = "All";
  let term = "";

  function refreshProducts() {
    products = DB.listProducts();
    renderCats(); renderTiles();
    clampCart(); renderCart();
  }

  function renderCats() {
    const cats = ["All"].concat(DB.CATEGORIES);
    $("#posCats").innerHTML = cats.map(c => {
      const n = c === "All" ? products.filter(p => p.in_stock_count > 0).length
                            : products.filter(p => p.in_stock_count > 0 && p.category === c).length;
      return `<button class="ctab ${c === activeCat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)} (${n})</button>`;
    }).join("");
  }
  $("#posCats").addEventListener("click", e => {
    const t = e.target.closest(".ctab"); if (!t) return;
    activeCat = t.dataset.cat; renderCats(); renderTiles();
  });
  $("#gridSearch").addEventListener("input", e => { term = e.target.value.trim().toLowerCase(); renderTiles(); });

  function renderTiles() {
    const list = products
      .filter(p => activeCat === "All" || p.category === activeCat)
      .filter(p => !term || [p.name, p.size, p.barcode_id].join(" ").toLowerCase().includes(term))
      .sort((a, b) => (b.in_stock_count > 0) - (a.in_stock_count > 0));
    $("#tileGrid").innerHTML = list.length ? list.map(p => {
      const out = p.in_stock_count <= 0;
      return `
      <button class="tile" data-tile="${esc(p.id)}" ${out ? "disabled" : ""}>
        <span class="t-name">${EMOJI[p.category] || "🏷️"} ${esc(p.name)}</span>
        <span class="t-meta">Size ${esc(p.size)} · ${esc(p.condition)} · ${esc(p.barcode_id)}</span>
        <span class="t-row">
          <span class="t-price">${DB.ugx(p.selling_price)}</span>
          <span class="stock-dot ${out ? "out" : ""}">${out ? "SOLD" : p.in_stock_count + " left"}</span>
        </span>
      </button>`;
    }).join("") : `<p class="cart-empty">No items match.</p>`;
  }
  $("#tileGrid").addEventListener("click", e => {
    const t = e.target.closest("[data-tile]");
    if (t) addLine(t.dataset.tile);
  });

  /* ============================================================
     LIVE CART REGISTER
     ============================================================ */
  let cart = []; // {product_id, qty}

  function addLine(pid) {
    const p = products.find(x => x.id === pid);
    if (!p || p.in_stock_count <= 0) { flash("✗ Item unavailable", false); beep(false); return false; }
    const l = cart.find(x => x.product_id === pid);
    const cur = l ? l.qty : 0;
    if (cur + 1 > p.in_stock_count) { flash(`✗ Only ${p.in_stock_count} in stock for "${p.name}"`, false); beep(false); return false; }
    if (l) l.qty++; else cart.push({ product_id: pid, qty: 1 });
    renderCart();
    return true;
  }

  function clampCart() {
    cart = cart.reduce((acc, l) => {
      const p = products.find(x => x.id === l.product_id);
      if (!p || p.in_stock_count <= 0) { flash(`⚠ "${p ? p.name : l.product_id}" just became unavailable`, false); return acc; }
      l.qty = Math.min(l.qty, p.in_stock_count);
      acc.push(l); return acc;
    }, []);
  }

  function cartDetailed() {
    return cart.map(l => {
      const p = products.find(x => x.id === l.product_id);
      return p ? { l, p, amt: p.selling_price * l.qty } : null;
    }).filter(Boolean);
  }
  const cartTotal = () => cartDetailed().reduce((s, x) => s + x.amt, 0);

  function renderCart() {
    const det = cartDetailed();
    const box = $("#cartLines");
    if (!det.length) {
      box.innerHTML = `<p class="cart-empty">Cart is empty.<br/>Scan a barcode or tap an item. 🧾</p>`;
    } else {
      box.innerHTML = det.map(({ l, p, amt }) => `
        <div class="cline">
          <span class="c-name">${esc(p.name)}</span>
          <span class="c-amt">${DB.ugx(amt)}</span>
          <span class="c-unit">${DB.ugx(p.selling_price)} each · ${esc(p.barcode_id)}</span>
          <span class="c-controls">
            <span class="qty">
              <button data-dec="${esc(p.id)}" ${l.qty <= 1 ? "disabled" : ""}>−</button>
              <span>${l.qty}</span>
              <button data-inc="${esc(p.id)}" ${l.qty >= p.in_stock_count ? "disabled" : ""}>+</button>
            </span>
            <button class="rm" data-rm="${esc(p.id)}">✕ remove</button>
          </span>
        </div>`).join("");
    }
    $("#sumItems").textContent = det.reduce((s, x) => s + x.l.qty, 0);
    $("#sumTotal").textContent = DB.ugx(cartTotal());
    const btn = $("#btnCharge");
    btn.disabled = !det.length;
    btn.textContent = "Charge · " + DB.ugx(cartTotal());
  }

  $("#cartLines").addEventListener("click", e => {
    const dec = e.target.closest("[data-dec]"), inc = e.target.closest("[data-inc]"), rm = e.target.closest("[data-rm]");
    if (dec) { const l = cart.find(x => x.product_id === dec.dataset.dec); if (l) l.qty = Math.max(1, l.qty - 1); }
    if (inc) {
      const l = cart.find(x => x.product_id === inc.dataset.inc);
      const p = products.find(x => x.id === inc.dataset.inc);
      if (l && p) {
        if (l.qty + 1 > p.in_stock_count) { flash(`✗ Only ${p.in_stock_count} in stock`, false); beep(false); return; }
        l.qty++;
      }
    }
    if (rm) cart = cart.filter(x => x.product_id !== rm.dataset.rm);
    if (dec || inc || rm) renderCart();
  });

  $("#btnClear").addEventListener("click", () => { cart = []; renderCart(); });

  /* ============================================================
     TENDER SETTLEMENT
     ============================================================ */
  let tenderType = "cash";

  function openTender() {
    if (!cartDetailed().length) return;
    tenderType = "cash";
    syncTenderUI();
    $("#cashTendered").value = "";
    $("#momoName").value = ""; $("#momoPhone").value = ""; $("#momoRef").value = ""; $("#momoVerified").checked = false;
    $("#dueAmount").textContent = DB.ugx(cartTotal());
    $("#tenderBackdrop").classList.add("open");
    updateChange();
    setTimeout(() => $("#cashTendered").focus(), 60);
  }
  function closeTender() { $("#tenderBackdrop").classList.remove("open"); }

  function syncTenderUI() {
    $$(".ttab").forEach(t => t.classList.toggle("active", t.dataset.tender === tenderType));
    $("#pane-cash").classList.toggle("active", tenderType === "cash");
    $("#pane-momo").classList.toggle("active", tenderType !== "cash");
    validateTender();
  }
  $(".tender-tabs").addEventListener("click", e => {
    const t = e.target.closest(".ttab"); if (!t) return;
    tenderType = t.dataset.tender; syncTenderUI();
  });

  function updateChange() {
    const due = cartTotal();
    const tendered = Math.max(0, Number($("#cashTendered").value) || 0);
    const change = tendered - due;
    $("#changeDue").textContent = DB.ugx(Math.max(0, change));
    $("#changeDue").style.color = change < 0 ? "var(--red)" : "var(--green)";
  }
  $("#cashTendered").addEventListener("input", () => { updateChange(); validateTender(); });

  $(".quick").addEventListener("click", e => {
    const q = e.target.closest(".qchip"); if (!q) return;
    const input = $("#cashTendered");
    if (q.dataset.q === "exact") input.value = cartTotal();
    else input.value = (Number(input.value) || 0) + Number(q.dataset.q);
    updateChange(); validateTender();
  });

  ["#momoName", "#momoPhone", "#momoRef"].forEach(s => $(s).addEventListener("input", validateTender));
  $("#momoVerified").addEventListener("change", validateTender);

  function validateTender() {
    const due = cartTotal();
    let ok = false;
    if (due > 0) {
      if (tenderType === "cash") ok = (Number($("#cashTendered").value) || 0) >= due;
      else ok = $("#momoRef").value.trim().length >= 4 && $("#momoVerified").checked;
    }
    $("#tenderConfirm").disabled = !ok;
  }

  $("#tenderCancel").addEventListener("click", closeTender);
  $("#btnCharge").addEventListener("click", openTender);
  $("#tenderBackdrop").addEventListener("click", e => { if (e.target === $("#tenderBackdrop")) closeTender(); });

  /* ============================================================
     COMPLETE SALE → ATOMIC DB TRANSACTION → RECEIPT
     ============================================================ */
  let lastSale = null;

  $("#tenderConfirm").addEventListener("click", async () => {
    const btn = $("#tenderConfirm");
    btn.disabled = true; btn.textContent = "Processing…";
    const items = cartDetailed().map(({ l }) => ({ product_id: l.product_id, qty: l.qty }));
    const tender = tenderType === "cash"
      ? { type: "cash", tendered: Number($("#cashTendered").value) || 0 }
      : {
          type: tenderType,
          sender_name: $("#momoName").value.trim(),
          sender_phone: $("#momoPhone").value.trim(),
          ref: $("#momoRef").value.trim(),
          verified: $("#momoVerified").checked,
          verified_by: cashier.name
        };
    try {
      const sale = await DB.processPosSale({ items, tender, cashier });
      lastSale = sale;
      cart = [];
      closeTender();
      refreshProducts();                 // stock now lower; tiles re-render
      showReceipt(sale);
      flash(`✓ Sale ${sale.id} completed — ${DB.ugx(sale.total)}`, true);
      setTimeout(() => window.print(), 400);  // auto thermal print
    } catch (err) {
      flash("✗ " + (err.message || "Sale failed"), false);
      beep(false);
      refreshProducts();                 // reconcile stock (someone else may have sold it)
      closeTender();
    } finally {
      btn.disabled = false; btn.textContent = "Complete sale";
    }
  });

  /* ---------- receipt (80mm thermal + on-screen preview) ---------- */
  function receiptHTML(sale) {
    const s = DB.getSettings();
    const when = new Date(sale.created_at);
    const dt = when.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " +
               when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    let tenderBlock = "";
    if (sale.tender.type === "cash") {
      tenderBlock = `<tr><td>CASH</td><td class="r">${DB.ugx(sale.tender.tendered)}</td></tr>
                     <tr><td>CHANGE</td><td class="r">${DB.ugx(sale.tender.change || 0)}</td></tr>`;
    } else if (sale.tender.type === "mtn" || sale.tender.type === "airtel") {
      const label = sale.tender.type === "mtn" ? "MTN MoMo" : "Airtel Money";
      tenderBlock = `<tr><td>${label.toUpperCase()}</td><td class="r">${DB.ugx(sale.total)}</td></tr>
                     <tr><td colspan="2">Ref: ${esc(sale.tender.ref || "-")}${sale.tender.sender_name ? " · " + esc(sale.tender.sender_name) : ""}</td></tr>`;
    }
    const rows = sale.items.map(l => `
      <tr><td>${esc(l.name)}<br/><small>${l.qty} × ${DB.ugx(l.unit_price)}</small></td><td class="r">${DB.ugx(l.line_total)}</td></tr>`).join("");
    return `
      <div class="rc">
        <div class="store">${esc(s.store_name).toUpperCase()}</div>
        <div class="meta">${esc(s.tagline)}<br/>${esc(s.address)} · WhatsApp +${esc(s.whatsapp)}</div>
        <hr/>
        <div class="meta">${dt}<br/>Served by: ${esc(sale.cashier ? sale.cashier.name : "Staff")}</div>
        <hr/>
        <table>${rows}
          <tr class="tot"><td>TOTAL</td><td class="r">${DB.ugx(sale.total)}</td></tr>
          ${tenderBlock}
        </table>
        <hr/>
        <div class="order-id">${esc(sale.id)}</div>
        <div class="foot">Items sold are unique thrift pieces.<br/>Thank you for shopping at ${esc(s.store_name)}! 🙏</div>
      </div>`;
  }

  function showReceipt(sale) {
    $("#receiptSheet").innerHTML = receiptHTML(sale);
    $("#receiptPreview").innerHTML = receiptHTML(sale);
    $("#receiptBackdrop").classList.add("open");
    setTimeout(() => $("#btnNewSale").focus(), 100);
  }

  $("#btnNewSale").addEventListener("click", () => {
    $("#receiptBackdrop").classList.remove("open");
    $("#barcodeInput").focus();
  });
  $("#btnReceiptPrint").addEventListener("click", () => window.print());
  $("#btnReprint").addEventListener("click", () => {
    if (lastSale) { showReceipt(lastSale); }
    else flash("No receipt yet this session", false);
  });

  /* ---------- real-time: other tabs (storefront/web orders, other POS) ---------- */
  DB.on("products", () => refreshProducts());
  DB.on("sales", () => refreshProducts()); // a web order elsewhere reserved stock

  /* ---------- boot ---------- */
  refreshProducts();
  $("#barcodeInput").focus();
})();
