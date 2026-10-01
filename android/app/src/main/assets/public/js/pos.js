/* ============ Adonai POS — cashier terminal logic ============ */
(function () {
  "use strict";

  /* ---------- route guard (open access while lock is off) ---------- */
  const me = Auth.guard({ role: null });
  if (Auth.locked() && !me) return; // redirect in flight

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const EMOJI = {
    "Outerwear & Jackets": "🧥", "Tops & Shirts": "👕", "Dresses & Skirts": "👗",
    "Pants & Jeans": "👖", "Shoes": "👟", "Accessories": "👜", "Children Wear": "🧒"
  };

  /* ---------- header: cashier pill + network status ---------- */
  const cashier = me || { name: "Staff", role: Auth.locked() ? "staff" : "open access" };
  const LOCK_OWNER_KEY = "adonai-pos-lock-owner";
  let lockOwner = "";
  try {
    lockOwner = sessionStorage.getItem(LOCK_OWNER_KEY) || "";
    if (!lockOwner) {
      lockOwner = `POS-${(cashier.id || "TERMINAL")}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      sessionStorage.setItem(LOCK_OWNER_KEY, lockOwner);
    }
  } catch (e) {
    lockOwner = `POS-${(cashier.id || "TERMINAL")}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }
  $("#meName").textContent = cashier.name;
  $("#meRole").textContent = cashier.role;
  $("#meRole").className = "role";
  $(".avatar", $("#mePill")).textContent = (cashier.name || "S").charAt(0).toUpperCase();

  const posMeName = $("#posMeName");
  if (posMeName) posMeName.textContent = cashier.name;
  const posMeRole = $("#posMeRole");
  if (posMeRole) posMeRole.textContent = Auth.locked() ? ("Role: " + cashier.role.toUpperCase()) : "Open access · Staff";
  const posMeAvatar = $("#posMeAvatar");
  if (posMeAvatar) posMeAvatar.textContent = (cashier.name || "S").charAt(0).toUpperCase();

  function updatePosNavBadge() {
    const webPend = DB.listSales().filter(s => s.channel === "web" && s.status === "pending").length;
    const badge = $("#posNavWebBadge");
    if (badge) badge.textContent = webPend || "";
  }

  const openPosMenu = () => {
    document.body.classList.add("sb-open");
    updatePosNavBadge();
  };
  const closePosMenu = () => {
    document.body.classList.remove("sb-open");
  };

  const btnPosMenu = $("#btnPosMenu");
  if (btnPosMenu) btnPosMenu.addEventListener("click", openPosMenu);
  const closePosSidebar = $("#closePosSidebar");
  if (closePosSidebar) closePosSidebar.addEventListener("click", closePosMenu);
  const posSbScrim = $("#posSbScrim");
  if (posSbScrim) posSbScrim.addEventListener("click", closePosMenu);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && document.body.classList.contains("sb-open")) {
      closePosMenu();
    }
  });

  // Synchronization remains automatic in DB; repeated toolbar status pills are
  // intentionally omitted so the register stays focused on checkout.

  const doExitPos = async () => {
    try { await DB.releaseInventoryLockOwner(lockOwner); } catch (e) {}
    Auth.signOut();                       // revoke staff privileges
    location.href = "login.html";         // return to terminal login
  };
  const btnPosSbExit = $("#btnPosSbExit");
  if (btnPosSbExit) btnPosSbExit.addEventListener("click", doExitPos);

  /* ---------- Cross-Navigation: POS to Live Web Storefront (External Browser Intent) ---------- */
  // Live Render deployment of the public storefront (web + API share this service).
  const LIVE_WEB_STOREFRONT_URL = "https://adonai-store.onrender.com";

  // The POS must never send staff to the URL of the shell it is running in
  // (Android APK appassets origin, Capacitor, local dev servers) — only a real
  // hosted website is safe to hand to the external browser.
  const isShellOrigin = origin => {
    try {
      const u = new URL(origin);
      if (!/^https?:$/.test(u.protocol)) return true;
      return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|appassets\.androidplatform\.net)$/i.test(u.hostname);
    } catch (e) { return true; }
  };

  const resolveWebStorefrontUrl = () => {
    // 1. A URL explicitly saved by the owner in Store Settings always wins.
    try {
      const S = DB.getSettings();
      const custom = String(S.app_url || S.website_url || "").trim();
      if (/^https?:\/\/\S+$/i.test(custom)) return custom;
    } catch (e) {}
    // 2. If the POS itself is served from a real website (e.g. the Render
    //    deployment), that same origin is the live storefront.
    if (!isShellOrigin(window.location.origin)) return window.location.origin;
    // 3. Otherwise (Android APK shell, Capacitor, local dev) open the live
    //    Render website directly — never the shell origin or a dead domain.
    return LIVE_WEB_STOREFRONT_URL;
  };

  const openLiveWebStorefront = () => {
    const siteUrl = resolveWebStorefrontUrl();

    // 1. Native Android WebView bridge (the standalone APK shell).
    // Calling the bridge avoids window.open being swallowed by WebView versions
    // that do not support multiple windows.
    if (window.Android && typeof window.Android.openExternal === "function") {
      window.Android.openExternal(siteUrl);
      return;
    }

    // 2. Capacitor Browser Plugin (Native Android intent)
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      try {
        window.Capacitor.Plugins.Browser.open({ url: siteUrl });
        return;
      } catch (err) {}
    }

    // 3. System Browser intent (_system target launches external default browser)
    try {
      const win = window.open(siteUrl, "_system", "location=yes");
      if (!win) {
        const fallback = window.open(siteUrl, "_blank", "noopener,noreferrer");
        if (!fallback) flash("🌐 Pop-up blocked — open manually: " + siteUrl, true);
      }
    } catch (e) {
      window.open(siteUrl, "_blank", "noopener,noreferrer");
    }
  };

  const btnSbOpenWebStore = $("#btnSbOpenWebStore");
  if (btnSbOpenWebStore) btnSbOpenWebStore.addEventListener("click", openLiveWebStorefront);

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
  $("#btnLookup").addEventListener("click", () => {
    const code = $("#barcodeInput").value.trim();
    if (code) { handleScan(code); $("#barcodeInput").value = ""; }
    else $("#barcodeInput").focus();
  });
  $("#btnCamera").addEventListener("click", () => {
    openIntake();
    flash("📁 Choose an item to update its photo or add a new piece from gallery/files.", true);
    setTimeout(() => openIntakeEditor(null), 350);
  });
  let installPromptEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPromptEvt = e; });

  async function handleScan(code) {
    const p = DB.findByBarcode(code);
    if (!p) { flash(`✗ No product for barcode "${code}"`, false); beep(false); return; }
    if (p.in_stock_count <= 0) { flash(`✗ "${p.name}" is sold out`, false); beep(false); return; }
    if (!(await addLine(p.id))) return;
    flash(`✓ Held for this POS: ${p.name} — ${DB.ugx(p.selling_price)}`, true);
    beep(true);
  }

  /* ============================================================
     MANUAL LOOKUP GRID
     ============================================================ */
  let products = [];
  let activeCat = "All";
  let activeDemo = "All";
  let term = "";

  function refreshProducts() {
    products = DB.listProducts();
    renderDemos(); renderCats(); renderTiles();
    clampCart(); renderCart();
  }

  /* demographic pills — “All Departments / Men / Women / Children” */
  function renderDemos() {
    const demos = [["All", "All Departments"]].concat(DB.DEMOGRAPHICS.map(d => [d, d]));
    $("#posDemos").innerHTML = demos.map(([v, lbl]) =>
      `<button class="dtab ${v === activeDemo ? "active" : ""}" data-demo="${esc(v)}">${esc(lbl)}</button>`).join("");
  }
  $("#posDemos").addEventListener("click", e => {
    const t = e.target.closest(".dtab"); if (!t) return;
    activeDemo = t.dataset.demo; renderDemos(); renderTiles();
  });

  function renderCats() {
    const cats = [["All", "All Items"]].concat(DB.CATEGORIES.map(c => [c, c]));
    $("#posCats").innerHTML = `<span class="cat-lab">Category:</span>` + cats.map(([v, lbl]) =>
      `<button class="ctab ${v === activeCat ? "active" : ""}" data-cat="${esc(v)}">${esc(lbl)}</button>`).join("");
  }
  $("#posCats").addEventListener("click", e => {
    const t = e.target.closest(".ctab"); if (!t) return;
    activeCat = t.dataset.cat; renderCats(); renderTiles();
  });
  $("#gridSearch").addEventListener("input", e => { term = e.target.value.trim().toLowerCase(); renderTiles(); });

  function renderTiles() {
    const list = products
      .filter(p => activeDemo === "All" || p.demographic === activeDemo)
      .filter(p => activeCat === "All" || p.category === activeCat)
      .filter(p => !term || [p.name, p.brand, p.size, p.color, p.sku, p.barcode_id, p.condition].join(" ").toLowerCase().includes(term))
      .sort((a, b) => (b.in_stock_count > 0) - (a.in_stock_count > 0));
    $("#tileGrid").innerHTML = list.length ? list.map(p => {
      const out = p.in_stock_count <= 0;
      const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy" />` : "";
      return `
      <button class="tile" data-tile="${esc(p.id)}" ${out ? "disabled" : ""}>
        <span class="tile-img">${img || (EMOJI[p.category] || "🏷️")}</span>
        <span class="tile-body">
          <span class="t-name">${esc(p.name)}</span>
          <span class="t-meta">${esc(p.demographic)} · ${esc(p.category)} · Size ${esc(p.size)} · ${esc(p.condition)}</span>
          <span class="t-row">
            <span class="t-price">${DB.ugx(p.selling_price)}</span>
            <span class="stock-dot ${out ? "out" : ""}">${out ? "SOLD" : p.in_stock_count + " left"}</span>
          </span>
        </span>
      </button>`;
    }).join("") : `<p class="cart-empty">No items match.</p>`;
  }
  $("#tileGrid").addEventListener("click", async e => {
    const t = e.target.closest("[data-tile]");
    if (t) await addLine(t.dataset.tile);
  });

  /* ============================================================
     LIVE CART REGISTER
     (docks to a bottom sheet on phones — see css/pos.css)
     ============================================================ */
  let cart = []; // {product_id, qty}

  const posCart = $("#posCart");
  const cartToggle = $("#cartToggle");
  const isCartDocked = () => window.matchMedia("(max-width: 960px)").matches;
  const setCartOpen = open => {
    if (!posCart || !cartToggle) return;
    posCart.classList.toggle("open", open);
    cartToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };
  if (cartToggle) {
    cartToggle.addEventListener("click", () => setCartOpen(!posCart.classList.contains("open")));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && posCart.classList.contains("open")) setCartOpen(false);
    });
    window.addEventListener("resize", () => {
      if (!isCartDocked()) setCartOpen(false);   // desktop always shows the full panel
    }, { passive: true });
  }

  const lockQueues = new Map();
  function addLine(pid) {
    const prior = lockQueues.get(pid) || Promise.resolve();
    const task = prior.catch(() => false).then(async () => {
      const p = products.find(x => x.id === pid);
      if (!p || p.in_stock_count <= 0) { flash("✗ Item unavailable", false); beep(false); return false; }
      const current = cart.find(x => x.product_id === pid);
      const quantity = current ? current.qty : 0;
      if (quantity + 1 > p.in_stock_count) { flash(`✗ Only ${p.in_stock_count} in stock for "${p.name}"`, false); beep(false); return false; }
      try {
        await DB.acquireInventoryLock(pid, lockOwner, 1);
        const line = cart.find(x => x.product_id === pid);
        if (line) line.qty++; else cart.push({ product_id: pid, qty: 1 });
        renderCart();
        return true;
      } catch (error) {
        flash("✗ " + (error.message || "Could not reserve this item"), false);
        beep(false);
        DB.pullProducts(false);
        return false;
      }
    });
    lockQueues.set(pid, task);
    task.finally(() => { if (lockQueues.get(pid) === task) lockQueues.delete(pid); });
    return task;
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
    /* docked mini-bar (phones) mirrors the live totals */
    const itemCount = det.reduce((s, x) => s + x.l.qty, 0);
    const ctCount = $("#ctCount"), ctTotal = $("#ctTotal");
    if (ctCount) { ctCount.textContent = itemCount; ctCount.dataset.zero = itemCount ? "0" : "1"; }
    if (ctTotal) ctTotal.textContent = DB.ugx(cartTotal());
    const btn = $("#btnCharge");
    btn.disabled = !det.length;
    btn.textContent = "Charge · " + DB.ugx(cartTotal());
  }

  $("#cartLines").addEventListener("click", async e => {
    const dec = e.target.closest("[data-dec]"), inc = e.target.closest("[data-inc]"), rm = e.target.closest("[data-rm]");
    try {
      if (dec) {
        const l = cart.find(x => x.product_id === dec.dataset.dec);
        if (l && l.qty > 1) {
          await DB.releaseInventoryLock(l.product_id, lockOwner, 1);
          l.qty--;
        }
      }
      if (inc) await addLine(inc.dataset.inc);
      if (rm) {
        const l = cart.find(x => x.product_id === rm.dataset.rm);
        if (l) await DB.releaseInventoryLock(l.product_id, lockOwner, l.qty);
        cart = cart.filter(x => x.product_id !== rm.dataset.rm);
      }
      if (dec || rm) renderCart();
    } catch (error) {
      flash("✗ " + (error.message || "Could not update the POS hold"), false);
      beep(false);
    }
  });

  $("#btnClear").addEventListener("click", async () => {
    await Promise.allSettled(Array.from(lockQueues.values()));
    try { await DB.releaseInventoryLockOwner(lockOwner); } catch (error) { flash("⚠ Hold release will retry automatically", false); }
    cart = [];
    renderCart();
  });

  // Extend active holds while the cart is open. The short server expiry also
  // guarantees abandoned or crashed terminals cannot block stock indefinitely.
  window.setInterval(() => {
    if (cart.length && !document.hidden) DB.heartbeatInventoryLocks(lockOwner).catch(() => {});
  }, 60000);
  window.addEventListener("pagehide", () => {
    if (cart.length) DB.releaseInventoryLockOwner(lockOwner, true).catch(() => {});
  });

  /* ============================================================
     TENDER SETTLEMENT
     ============================================================ */
  let tenderType = "cash";

  function openTender() {
    if (!cartDetailed().length) return;
    tenderType = "cash";
    syncTenderUI();
    if ($("#posCustName")) $("#posCustName").value = "";
    if ($("#posCustPhone")) $("#posCustPhone").value = "";
    if ($("#posCustLocation")) $("#posCustLocation").value = "";
    if ($("#posCustNotes")) $("#posCustNotes").value = "";
    $("#cashTendered").value = "";
    $("#momoName").value = "";
    $("#momoPhone").value = "";
    delete $("#momoName").dataset.customized;
    delete $("#momoPhone").dataset.customized;
    $("#momoRef").value = "";
    $("#momoVerified").checked = false;
    $("#dueAmount").textContent = DB.ugx(cartTotal());
    $("#tenderBackdrop").classList.add("open");
    updateChange();
    setTimeout(() => {
      if ($("#posCustName")) $("#posCustName").focus();
      else $("#cashTendered").focus();
    }, 60);
  }
  function closeTender() { $("#tenderBackdrop").classList.remove("open"); }

  function syncTenderUI() {
    $$(".ttab").forEach(t => t.classList.toggle("active", t.dataset.tender === tenderType));
    $("#pane-cash").classList.toggle("active", tenderType === "cash");
    $("#pane-momo").classList.toggle("active", tenderType !== "cash");
    if (tenderType !== "cash") {
      if (!$("#momoName").dataset.customized && $("#posCustName")) {
        $("#momoName").value = $("#posCustName").value;
      }
      if (!$("#momoPhone").dataset.customized && $("#posCustPhone")) {
        $("#momoPhone").value = $("#posCustPhone").value;
      }
    }
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

  ["#posCustName", "#posCustPhone", "#posCustLocation", "#posCustNotes"].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input", () => {
      if (sel === "#posCustName" && tenderType !== "cash" && !$("#momoName").dataset.customized) {
        $("#momoName").value = el.value;
      }
      if (sel === "#posCustPhone" && tenderType !== "cash" && !$("#momoPhone").dataset.customized) {
        $("#momoPhone").value = el.value;
      }
      validateTender();
    });
  });

  $("#momoName").addEventListener("input", () => { $("#momoName").dataset.customized = "true"; validateTender(); });
  $("#momoPhone").addEventListener("input", () => { $("#momoPhone").dataset.customized = "true"; validateTender(); });
  $("#momoRef").addEventListener("input", validateTender);
  $("#momoVerified").addEventListener("change", validateTender);

  function validateTender() {
    const due = cartTotal();
    const custName = $("#posCustName") ? $("#posCustName").value.trim() : "";
    const custPhone = $("#posCustPhone") ? $("#posCustPhone").value.trim() : "";
    const hasCustomer = custName.length > 0 && custPhone.length > 0;
    let ok = false;
    if (due > 0 && hasCustomer) {
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
    const custName = $("#posCustName") ? $("#posCustName").value.trim() : "";
    const custPhone = $("#posCustPhone") ? $("#posCustPhone").value.trim() : "";
    const custLoc = $("#posCustLocation") ? $("#posCustLocation").value.trim() : "";
    const custNotes = $("#posCustNotes") ? $("#posCustNotes").value.trim() : "";
    const items = cartDetailed().map(({ l }) => ({ product_id: l.product_id, qty: l.qty }));
    const tender = tenderType === "cash"
      ? { type: "cash", tendered: Number($("#cashTendered").value) || 0 }
      : {
          type: tenderType,
          sender_name: $("#momoName").value.trim() || custName,
          sender_phone: $("#momoPhone").value.trim() || custPhone,
          ref: $("#momoRef").value.trim(),
          verified: $("#momoVerified").checked,
          verified_by: cashier.name
        };
    try {
      const sale = await DB.processPosSale({
        items,
        tender,
        cashier,
        customer_name: custName || "Walk-in Guest",
        customer_phone: custPhone || "",
        customer_location: custLoc,
        customer_notes: custNotes,
        lock_owner: lockOwner
      });
      lastSale = sale;
      cart = [];
      closeTender();
      setCartOpen(false);                // fold the docked cart back down (phones)
      refreshProducts();                 // stock now lower; tiles re-render
      showReceipt(sale);
      if (window.AdonaiAnalytics) {
        window.AdonaiAnalytics.trackPosSale(sale);
      }
      flash(`✓ Sale ${sale.id} completed — ${DB.ugx(sale.total)}`, true);
      setTimeout(() => window.print(), 400);  // auto thermal print
    } catch (err) {
      flash("✗ " + (err.message || "Sale failed"), false);
      beep(false);
      if (Number(err.status) === 409) {
        try { await DB.releaseInventoryLockOwner(lockOwner); } catch (e) {}
        cart = [];
        renderCart();
      }
      try { await DB.pullOperationalData(); } catch (e) {}
      refreshProducts();                 // reconcile stock (someone else may have sold it)
      closeTender();
    } finally {
      btn.disabled = false; btn.textContent = "Complete sale";
    }
  });

  /* ---------- receipt (80mm thermal + on-screen preview) ---------- */
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

  function receiptHTML(sale) {
    const S = DB.getSettings();
    const totalQty = sale.items.reduce((a, b) => a + b.qty, 0);
    const subtotal = sale.subtotal || (sale.total - (sale.delivery_fee || 0));
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
          <strong>${esc(sale.id)}</strong>
        </div>
        <div class="rc-datetime-row">
          <span>Date: ${receiptDateFormat(sale.created_at)}</span>
          <span>Time: ${receiptTimeFormat(sale.created_at)}</span>
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-cust-box">
          <div class="rc-cust-row"><span class="rc-cust-k">Customer:</span> <strong class="rc-cust-v">${esc(sale.customer_name || "Walk-in Guest")}</strong></div>
          <div class="rc-cust-row"><span class="rc-cust-k">Phone:</span> <span class="rc-cust-v">${esc(sale.customer_phone || "—")}</span></div>
          ${sale.customer_location ? `<div class="rc-cust-row"><span class="rc-cust-k">Location:</span> <span class="rc-cust-v">${esc(sale.customer_location)}</span></div>` : (sale.delivery_area && sale.delivery_area !== "In-Store POS (Walk-in)" ? `<div class="rc-cust-row"><span class="rc-cust-k">Location:</span> <span class="rc-cust-v">${esc(sale.delivery_area)}</span></div>` : "")}
          ${sale.customer_notes ? `<div class="rc-cust-row"><span class="rc-cust-k">Notes:</span> <span class="rc-cust-v">${esc(sale.customer_notes)}</span></div>` : ""}
          <div class="rc-cust-row"><span class="rc-cust-k">Sales Channel:</span> <span class="rc-cust-v">${sale.channel === "web" ? "Online WhatsApp" : "In-Store POS (Walk-in)"}</span></div>
          ${sale.cashier ? `<div class="rc-cust-row"><span class="rc-cust-k">Cashier:</span> <span class="rc-cust-v">${esc(sale.cashier.name || sale.cashier)}</span></div>` : ""}
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
            ${sale.items.map(it => `
              <tr>
                <td style="text-align:left">
                  <div class="rc-it-name">${esc(it.name)}</div>
                  <div class="rc-it-sku">${esc(it.sku || it.barcode_id || "")}</div>
                </td>
                <td style="text-align:center">${it.qty}</td>
                <td style="text-align:right">${DB.ugx(it.unit_price)}</td>
                <td style="text-align:right">${DB.ugx(it.line_total)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="rc-dashed"></div>
        <div class="rc-sum-section">
          <div class="rc-sum-row">
            <span>Item Subtotal (${totalQty} items)</span>
            <span>${DB.ugx(subtotal)}</span>
          </div>
          ${sale.delivery_fee > 0 ? `
            <div class="rc-sum-row">
              <span>Rider Delivery Fee</span>
              <span>${DB.ugx(sale.delivery_fee)}</span>
            </div>
          ` : ""}
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-grand-row">
          <strong>TOTAL PAID (UGX)</strong>
          <strong class="rc-grand-total">${DB.ugx(sale.total)}</strong>
        </div>
        <div class="rc-pay-method">
          PAYMENT METHOD: ${(sale.tender && sale.tender.paid && sale.tender.type === "cash") ? "CASH · COMPLETED" : (sale.tender && sale.tender.paid && sale.tender.type === "mtn") ? "MTN MOMO · VERIFIED" : (sale.tender && sale.tender.paid && sale.tender.type === "airtel") ? "AIRTEL MONEY · VERIFIED" : (sale.tender && sale.tender.paid) ? `${sale.tender.type.toUpperCase()} · PAID` : "UNPAID · UNPAID"}
        </div>
        <div class="rc-dashed"></div>
        <div class="rc-notice">
          Notice: Returns or exchanges are strictly accepted within 2 days of purchase upon presentation of a valid receipt.
        </div>
        <div class="rc-barcode-area">
          <div class="rc-barcode-render">${DB.barcodeSVG(sale.id, 44)}</div>
          <div class="rc-barcode-code">* ${esc(sale.id)} *</div>
        </div>
      </div>
    `;
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

  /* ============================================================
     INVENTORY INTAKE — add/edit items & real photos from the counter.
     Everything saved here is broadcast live to the storefront,
     this terminal and the OPS dashboard.
     ============================================================ */
  const intakeBackdrop = $("#intakeBackdrop");
  const intakeBox = $("#intakeBox");
  let intakeTerm = "";
  let intakeImageState = { image_url: "" };
  let availableStockLots = [];

  const openIntake = () => { intakeTerm = ""; openIntakeList(); };
  const closeIntake = () => intakeBackdrop.classList.remove("open");
  $("#btnIntake").addEventListener("click", openIntake);
  intakeBackdrop.addEventListener("click", e => { if (e.target === intakeBackdrop) closeIntake(); });

  function openIntakeList() {
    const list = DB.listProducts()
      .filter(p => !intakeTerm || (p.name + " " + p.category + " " + p.barcode_id).toLowerCase().includes(intakeTerm))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    intakeBox.innerHTML = `
      <div class="intake-head"><h3>Inventory intake</h3><button class="btn sm ghost" data-intake-close>✕</button></div>
      <p class="intake-ed-note">Edit an item to replace its web photo with the real piece — changes go live on the storefront instantly.</p>
      <input class="in" id="inSearch" type="search" placeholder="Search stock…" value="${esc(intakeTerm)}" />
      <div class="intake-list">${list.map(p => `
        <div class="in-row">
          <span class="in-thumb">${EMOJI[p.category] || "🏷️"}${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : ""}</span>
          <div class="grow">
            <div class="in-name">${esc(p.name)}</div>
            <div class="in-meta">${esc(p.barcode_id)} · ${DB.ugx(p.selling_price)} · ${p.in_stock_count} in stock</div>
          </div>
          <button class="btn sm" data-intake-edit="${esc(p.id)}">Edit · photo</button>
        </div>`).join("") || `<p class="cart-empty">Nothing matches.</p>`}</div>
      <div class="tender-actions"><span></span><button class="btn primary" data-intake-new>＋ New item</button></div>`;
    intakeBackdrop.classList.add("open");
    const s = $("#inSearch");
    s.addEventListener("input", e => {
      intakeTerm = e.target.value.trim().toLowerCase();
      const pos = e.target.selectionStart;
      openIntakeList();
      const el = $("#inSearch"); el.focus(); el.setSelectionRange(pos, pos);
    });
  }

  async function openIntakeEditor(id) {
    const p = id ? DB.getProduct(id) : null;
    if (!p) {
      try {
        const data = await DB.financeRequest("stock-lots", { method: "GET" });
        availableStockLots = (data.stock_lots || []).filter(lot => lot.remaining_count > 0);
      } catch (e) {
        availableStockLots = [];
      }
    }
    intakeImageState = { image_url: p ? (p.image_url || "") : "" };
    intakeBox.innerHTML = `
      <div class="intake-head"><h3>${p ? "Edit item" : "New item"}</h3><button class="btn sm ghost" data-intake-close>✕</button></div>
      ${p ? `<p class="intake-ed-note">Barcode <code>${esc(p.barcode_id)}</code> — print &amp; stick it on the tag if it's missing.</p>`
          : `<p class="intake-ed-note">A barcode is generated automatically on save — print &amp; stick it, and the scanner finds this item.</p>`}
      ${Intake.imageFieldHTML(intakeImageState.image_url)}
      <div class="form2">
        <div><label class="fld-label">Name</label><input class="in" data-f-name value="${p ? esc(p.name) : ""}" placeholder="e.g. Indigo Type III Trucker Jacket" /></div>
        <div><label class="fld-label">Brand / label</label><input class="in" data-f-brand value="${p ? esc(p.brand || "") : ""}" placeholder="Levi's, Hand-made…" /></div>
        <div><label class="fld-label">Colour</label><input class="in" data-f-color value="${p ? esc(p.color || "") : ""}" placeholder="Indigo, Olive…" /></div>
        <div><label class="fld-label">Category</label><select class="in" data-f-cat>${DB.CATEGORIES.map(c => `<option ${p && p.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div><label class="fld-label">Demographic</label><select class="in" data-f-demo>${DB.DEMOGRAPHICS.map(d => `<option ${p && p.demographic === d ? "selected" : ""}>${d}</option>`).join("")}</select></div>
        <div><label class="fld-label">Size</label><input class="in" data-f-size value="${p ? esc(p.size) : ""}" placeholder="M / 42 / -" /></div>
        <div><label class="fld-label">Condition / grade</label><select class="in" data-f-cond>${DB.CONDITIONS.map(c => `<option ${p && p.condition === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        ${p ? "" : `<div><label class="fld-label">Stock lot / bale allocation</label><select class="in" data-f-lot><option value="">No registered lot</option>${availableStockLots.map(lot => `<option value="${esc(lot.id)}" data-unit-cost="${lot.unit_cost}">${esc(lot.lot_code)} · ${esc(lot.supplier)} · ${lot.remaining_count} left · ${DB.ugx(lot.unit_cost)}/item</option>`).join("")}</select></div>`}
        <div><label class="fld-label">Cost (UGX)</label><input class="in" type="number" min="0" data-f-cost value="${p ? p.cost_price : ""}" /></div>
        <div><label class="fld-label">Selling (UGX)</label><input class="in" type="number" min="0" data-f-sell value="${p ? p.selling_price : ""}" /></div>
        <div><label class="fld-label">Compare-at (UGX)</label><input class="in" type="number" min="0" data-f-compare value="${p ? p.compare_price : ""}" /></div>
        <div><label class="fld-label">Stock count</label><input class="in" type="number" min="0" data-f-stock value="${p ? p.in_stock_count : 1}" /></div>
        <div style="grid-column:1/-1"><label class="fld-label">Description (storefront card)</label><textarea class="in" data-f-desc rows="2" style="resize:vertical">${p ? esc(p.desc || "") : ""}</textarea></div>
      </div>
      <div class="tender-actions">
        <button class="btn ghost" data-intake-back>${p ? "← Back to list" : "Cancel"}</button>
        <button class="btn primary" data-intake-save="${p ? esc(p.id) : ""}">${p ? "Save changes" : "Add item to stock"}</button>
      </div>`;
    Intake.bindImageEditor(intakeBox, intakeImageState);
    const lotSelect = intakeBox.querySelector("[data-f-lot]");
    if (lotSelect) lotSelect.addEventListener("change", () => {
      const option = lotSelect.options[lotSelect.selectedIndex];
      const cost = intakeBox.querySelector("[data-f-cost]");
      if (option && option.dataset.unitCost && cost) cost.value = option.dataset.unitCost;
    });
  }

  intakeBox.addEventListener("click", async e => {
    const t = e.target;
    if (t.closest("[data-intake-close]")) return closeIntake();
    if (t.closest("[data-intake-new]")) return openIntakeEditor(null);
    if (t.closest("[data-intake-back]")) return openIntakeList();
    const ed = t.closest("[data-intake-edit]"); if (ed) return openIntakeEditor(ed.dataset.intakeEdit);
    const sv = t.closest("[data-intake-save]");
    if (sv) {
      const v = Intake.readProductForm(intakeBox);
      if (!v.name) return flash("✗ Item name is required", false);
      v.image_url = intakeImageState.image_url;
      try {
        if (sv.dataset.intakeSave) {
          await DB.updateProduct(sv.dataset.intakeSave, v);
          flash("✓ Item and photo updated — live across POS and storefront now", true);
        } else {
          const np = await DB.addProduct(v);
          flash(`✓ ${np.name} added with photo · barcode ${np.barcode_id}`, true);
        }
        beep(true);
        closeIntake();
        refreshProducts();
      } catch (err) { flash("✗ " + err.message, false); beep(false); }
    }
  });

  /* ---------- real-time: other tabs (storefront/web orders, other POS) ---------- */
  DB.on("products", () => refreshProducts());
  DB.on("sales", () => refreshProducts()); // a web order elsewhere reserved stock

  /* ---------- boot ---------- */
  refreshProducts();
  $("#barcodeInput").focus();
})();
