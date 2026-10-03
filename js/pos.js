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
    "Outerwear & Jackets": Icons.svg("shirt", "ico-cat"), "Tops & Shirts": Icons.svg("shirt", "ico-cat"), "Dresses & Skirts": Icons.svg("shopping-bag", "ico-cat"),
    "Pants & Jeans": Icons.svg("ruler", "ico-cat"), "Shoes": Icons.svg("footprints", "ico-cat"), "Accessories": Icons.svg("shopping-bag", "ico-cat"), "Children Wear": Icons.svg("baby", "ico-cat")
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
  /* Cashier identity lives in the navigation drawer (me-card) — the header
     keeps only the menu trigger and the notification bell. */
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
        if (!fallback) flash("Pop-up blocked — open manually: " + siteUrl, true);
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
        <span class="tile-img">${img || (EMOJI[p.category] || Icons.svg("tag", "ico-cat"))}</span>
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
  const isCartDocked = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
  const setCartOpen = open => {
    if (!posCart || !cartToggle) return;
    posCart.classList.toggle("open", open);
    cartToggle.setAttribute("aria-expanded", open ? "true" : "false");
    // Storefront cart pattern: while the drawer is open on phones the page
    // behind the scrim is locked (html owns the single page scrollbar).
    document.documentElement.classList.toggle("pos-cart-open", open && isCartDocked());
  };
  /* Storefront cart pattern: adding an item NEVER blocks the catalog — the
     floating Sale pill pops (badge + running total) and the flash confirms.
     The cashier opens the Current Sale drawer only when ready to review it. */
  function pulseCartPill() {
    if (!cartToggle) return;
    cartToggle.classList.remove("ct-pulse");
    void cartToggle.offsetWidth;            // restart the pop animation
    cartToggle.classList.add("ct-pulse");
  }

  /* ---- dynamic "Current Sale" drawer visibility ----
     The checkout panel is hidden while the cart is empty so the catalog
     spans the full workspace. The first selected item slides it in from
     the right edge on every viewport (inline drawer ≥768px, overlay
     drawer <768px); clearing the cart, removing the last line, or
     completing a charge slides it away. */
  const getCartTotalCount = () => cart.reduce((s, l) => s + l.qty, 0);
  function syncCartVisibility() {
    const layoutContainer = document.querySelector(".pos-dashboard-layout");
    if (!layoutContainer) return;
    const cartItemsCount = getCartTotalCount();
    if (cartItemsCount > 0) {
      layoutContainer.classList.add("has-cart-items");
    } else {
      layoutContainer.classList.remove("has-cart-items");
      setCartOpen(false); // fold the phone sheet so it re-animates on the next sale
    }
  }
  if (cartToggle) {
    cartToggle.addEventListener("click", () => setCartOpen(!posCart.classList.contains("open")));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && posCart.classList.contains("open")) setCartOpen(false);
    });
    window.addEventListener("resize", () => {
      if (!isCartDocked()) setCartOpen(false);   // desktop always shows the full panel
    }, { passive: true });
  }
  const posCartScrim = $("#posCartScrim");
  if (posCartScrim) posCartScrim.addEventListener("click", () => setCartOpen(false));

  const lockQueues = new Map();
  const hasRemotePosAuth = () => {
    try { return typeof Auth !== "undefined" && typeof Auth.token === "function" && !!Auth.token(); }
    catch (e) { return false; }
  };

  function addLine(pid) {
    const prior = lockQueues.get(pid) || Promise.resolve();
    const task = prior.catch(() => false).then(async () => {
      const p = products.find(x => x.id === pid);
      if (!p || p.in_stock_count <= 0) { flash("✗ Item unavailable", false); beep(false); return false; }
      const current = cart.find(x => x.product_id === pid);
      const quantity = current ? current.qty : 0;
      if (quantity + 1 > p.in_stock_count) { flash(`✗ Only ${p.in_stock_count} in stock for "${p.name}"`, false); beep(false); return false; }

      // Selection is a UI action and must not wait on a network round trip.
      // Open-access terminals have no JWT, so their local POS database is the
      // checkout source until a cashier signs in. Authenticated terminals still
      // reserve against the shared inventory before adding the line.
      try {
        if (hasRemotePosAuth()) await DB.acquireInventoryLock(pid, lockOwner, 1);
        const line = cart.find(x => x.product_id === pid);
        if (line) line.qty++; else cart.push({ product_id: pid, qty: 1 });
        renderCart();
        // Storefront cart pattern: the catalog is never blocked while adding.
        // The floating Sale pill pops with the new count/total and the flash
        // banner confirms the hold — the drawer opens only on explicit tap.
        pulseCartPill();
        flash(`✓ Added: ${p.name} — ${DB.ugx(p.selling_price)}`, true);
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
      if (!p || p.in_stock_count <= 0) { flash(`"${p ? p.name : l.product_id}" just became unavailable`, false); return acc; }
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
      box.innerHTML = `<p class="cart-empty">Cart is empty.<br/>Scan a barcode or tap an item.</p>`;
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
            <button class="rm" data-rm="${esc(p.id)}">${Icons.svg("x", "ico-11")} remove</button>
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
    /* every cart mutation funnels through here — keep the drawer in sync */
    syncCartVisibility();
  }

  $("#cartLines").addEventListener("click", async e => {
    const dec = e.target.closest("[data-dec]"), inc = e.target.closest("[data-inc]"), rm = e.target.closest("[data-rm]");
    try {
      if (dec) {
        const l = cart.find(x => x.product_id === dec.dataset.dec);
        if (l && l.qty > 1) {
          if (hasRemotePosAuth()) await DB.releaseInventoryLock(l.product_id, lockOwner, 1);
          l.qty--;
        }
      }
      if (inc) await addLine(inc.dataset.inc);
      if (rm) {
        const l = cart.find(x => x.product_id === rm.dataset.rm);
        if (l && hasRemotePosAuth()) await DB.releaseInventoryLock(l.product_id, lockOwner, l.qty);
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
    if (hasRemotePosAuth()) {
      try { await DB.releaseInventoryLockOwner(lockOwner); } catch (error) { flash("Hold release will retry automatically", false); }
    }
    cart = [];
    renderCart();
  });

  // Extend active holds while the cart is open. The short server expiry also
  // guarantees abandoned or crashed terminals cannot block stock indefinitely.
  window.setInterval(() => {
    if (cart.length && !document.hidden && hasRemotePosAuth()) DB.heartbeatInventoryLocks(lockOwner).catch(() => {});
  }, 60000);
  window.addEventListener("pagehide", () => {
    if (cart.length && hasRemotePosAuth()) DB.releaseInventoryLockOwner(lockOwner, true).catch(() => {});
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
          <div class="rc-cust-row"><span class="rc-cust-k">Sales Channel:</span> <span class="rc-cust-v">${sale.channel === "web" ? "Web Storefront" : "In-Store POS (Walk-in)"}</span></div>
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
     INVENTORY INTAKE — REMOVED FROM THE CASHIER REGISTER
     Product intake and photo processing live exclusively in the
     Operations Console (Catalog Intake menu, admin.html?view=intake).
     The register stays focused on lookup & checkout only.
     ============================================================ */

  /* ---------- real-time: other tabs (storefront/web orders, other POS) ---------- */
  DB.on("products", () => refreshProducts());
  DB.on("sales", () => refreshProducts()); // a web order elsewhere reserved stock

  /* ---------- boot ---------- */
  refreshProducts();
  $("#barcodeInput").focus();
})();
