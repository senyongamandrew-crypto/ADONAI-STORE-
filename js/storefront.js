/* ============ Adonai Thrift Store — public storefront logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const CART_KEY = "adonai-cart-v1";
  const CONSENT_KEY = "adonai-consent-v1";

  /* ---------- stroke icon set ---------- */
  const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    "Outerwear & Jackets": svg(`<path d="M6 4l3-2c0 1.7 1.3 3 3 3s3-1.3 3-3l3 2 1.7 4.6c.2.7-.2 1.3-.9 1.4L17 10.4V20a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9.6l-1.8-.4a1 1 0 0 1-.9-1.4L6 4Z"/><path d="M12 6.5V22"/>`),
    "Tops & Shirts": svg(`<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23Z"/>`),
    "Dresses & Skirts": svg(`<path d="M9 2c0 1.4 1.3 2.5 3 2.5S15 3.4 15 2l1.5 4-1.2 3 3.7 10.6a1 1 0 0 1-1 1.4H6a1 1 0 0 1-1-1.4L8.7 9l-1.2-3L9 2Z"/><path d="M8.7 9h6.6"/>`),
    "Pants & Jeans": svg(`<path d="M6.5 2h11l1.2 19.2a.8.8 0 0 1-.8.8h-4.6l-1.3-11-1.3 11H6.1a.8.8 0 0 1-.8-.9L6.5 2Z"/><path d="M6.5 6h11"/>`),
    Shoes: svg(`<path d="M2 16.2V9.4c0-.8.6-1.4 1.4-1.4h1.9c.6 0 1.1.2 1.5.7l2.4 2.9c.5.6 1.2.9 1.9 1l8.9 1.4c1 .2 1.7 1 1.7 2v.8c0 .6-.4 1-1 1H2.9c-.5 0-.9-.3-.9-.6Z"/><path d="M6.8 8.3l1.8 1.9M4.7 8.2l1.5 1.7"/>`),
    Accessories: svg(`<path d="M4 8h16l-1.2 12.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 8Z"/><path d="M8.5 10.5V6.5a3.5 3.5 0 0 1 7 0v4"/>`),
    "Children Wear": svg(`<path d="M12 3a2.5 2.5 0 1 1 2.5 2.5A2.5 2.5 0 0 1 12 3Zm-6 7.6c0-2.5 2.2-4.1 6-4.1s6 1.6 6 4.1V14a2 2 0 0 1-2 2h-.6l.5 5.2a.9.9 0 0 1-.9.8h-6a.9.9 0 0 1-.9-.8l.5-5.2H8a2 2 0 0 1-2-2Z"/>`),
    tag: svg(`<path d="M12.6 2.6 21 11a1.4 1.4 0 0 1 0 2l-8 8a1.4 1.4 0 0 1-2 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6Z"/><circle cx="7" cy="7" r="1.4"/>`),
    message: svg(`<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 1 1 21 11.5Z"/>`)
  };
  const catIcon = c => ICONS[c] || ICONS.tag;

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- store profile & footer (from the shared DB settings) ---------- */
  const S = DB.getSettings();
  $("#footTagline").textContent = S.tagline;
  $("#footLoc").textContent = S.address.split(",")[0]; // "Plot 14 Kampala Road / Mercer Hub"
  $("#footContactList").innerHTML = `
    <li><span class="k">WhatsApp:</span> <a class="rust" href="https://wa.me/${esc(S.whatsapp)}" target="_blank" rel="noopener">+${esc(S.whatsapp)}</a></li>
    <li><span class="k">Hotline:</span> <a href="tel:${esc(S.hotline.replace(/\s/g, ""))}">${esc(S.hotline)}</a></li>
    <li><span class="k">Email:</span> <a href="mailto:${esc(S.email)}">${esc(S.email)}</a></li>
    <li><span class="k">Location:</span> ${esc(S.address)}</li>
    <li><span class="k">Hours:</span> ${esc(S.hours)}</li>`;
  $("#footSocial").innerHTML = `
    <li><span class="k">TikTok:</span> <a class="rust" href="https://tiktok.com/${esc(S.tiktok.replace("@", "@"))}" target="_blank" rel="noopener">${esc(S.tiktok)}</a></li>
    <li><span class="k">Instagram:</span> <a class="rust" href="https://instagram.com/${esc(S.instagram.replace("@", ""))}" target="_blank" rel="noopener">${esc(S.instagram)}</a></li>`;
  const staffHref = (!Auth.locked() || Auth.me()) ? "pos.html" : "login.html";
  $("#staffLink").href = staffHref;
  $("#staffLinkFoot").href = staffHref;
  $("#installBtn").addEventListener("click", () => toast("Tip: use your browser's \"Add to Home Screen\" to install Adonai as an app"));
  $$("[data-policy]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); toast("Full store policies publish with the live site"); }));

  /* ---------- consent banner ---------- */
  if (!localStorage.getItem(CONSENT_KEY)) $("#consent").hidden = false;
  $$("[data-consent]").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset.consent;
    if (v === "custom") return toast("Essential session data is always on — everything else stays off unless you accept");
    localStorage.setItem(CONSENT_KEY, v);
    $("#consent").hidden = true;
    toast(v === "all" ? "Preferences saved" : "Using essential data only");
  }));

  /* ---------- cart ---------- */
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
  const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(cart));
  let orderResult = null;

  /* ---------- filter state ---------- */
  let products = [];
  let fDemo = "All", fCat = "All", fSize = "All", fCond = "All", fMax = 200000, term = "";

  function refreshProducts() {
    products = DB.listProducts();
    let changed = false;
    cart = cart.reduce((acc, l) => {
      const p = products.find(x => x.id === l.product_id);
      if (!p || p.in_stock_count <= 0) { changed = true; if (p) toast(`"${p.name}" was just claimed in the shop`); return acc; }
      if (l.qty > p.in_stock_count) { l.qty = p.in_stock_count; changed = true; }
      acc.push(l); return acc;
    }, []);
    if (changed) { saveCart(); renderCart(); }
    populateFilterOptions();
    renderChips(); renderGrid();
  }

  function populateFilterOptions() {
    const avail = products.filter(p => p.in_stock_count > 0);
    const sizes = [...new Set(avail.map(p => p.size))].sort();
    const sizeSel = $("#sizeSel");
    sizeSel.innerHTML = `<option value="All">All Sizes</option>` + sizes.map(s => `<option ${fSize === s ? "selected" : ""} value="${esc(s)}">${esc(s)}</option>`).join("");
    const condSel = $("#condSel");
    condSel.innerHTML = `<option value="All">All Grades</option>` + DB.CONDITIONS.map(c => `<option ${fCond === c ? "selected" : ""} value="${esc(c)}">${esc(c)}</option>`).join("");
    const maxPrice = Math.max(50000, ...products.map(p => p.selling_price));
    const range = $("#priceRange");
    range.max = Math.ceil(maxPrice / 10000) * 10000;
  }

  function renderChips() {
    const demoOpts = ["All Garments"].concat(DB.DEMOGRAPHICS);
    $("#demoChips").innerHTML = demoOpts.map(d => {
      const v = d === "All Garments" ? "All" : d;
      return `<button class="fchip ${fDemo === v ? "active" : ""}" data-demo="${esc(v)}">${esc(d)}</button>`;
    }).join("");
    const catOpts = ["All Types"].concat(DB.CATEGORIES);
    $("#catChips").innerHTML = catOpts.map(c => {
      const v = c === "All Types" ? "All" : c;
      return `<button class="fchip rust-target ${fCat === v ? "active rust" : ""}" data-catv="${esc(v)}">${esc(c)}</button>`;
    }).join("");
  }

  $("#demoChips").addEventListener("click", e => { const b = e.target.closest("[data-demo]"); if (!b) return; fDemo = b.dataset.demo; renderChips(); renderGrid(); });
  $("#catChips").addEventListener("click", e => { const b = e.target.closest("[data-catv]"); if (!b) return; fCat = b.dataset.catv; renderChips(); renderGrid(); });
  $("#sizeSel").addEventListener("change", e => { fSize = e.target.value; renderGrid(); });
  $("#condSel").addEventListener("change", e => { fCond = e.target.value; renderGrid(); });
  $("#shopSearch").addEventListener("input", e => { term = e.target.value.trim().toLowerCase(); renderGrid(); });
  $("#priceRange").addEventListener("input", e => {
    fMax = Number(e.target.value);
    $("#priceVal").textContent = DB.ugx(fMax);
    renderGrid();
  });

  /* ---------- product card (screenshot-matched) ---------- */
  function mediaHTML(p) {
    const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove()" />` : "";
    const dots = Array(4).fill(0).map((_, i) =>
      `<i>${i === 0 && p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : ""}</i>`).join("");
    return `
      <div class="pmedia">
        <span class="media-icon">${catIcon(p.category)}</span>
        ${img}
        <span class="grade-pill">${esc(p.condition)}</span>
        ${p.in_stock_count === 1 ? `<span class="singular-pill">1-of-1 Piece</span>` : ""}
        <div class="media-dots">${dots}</div>
      </div>`;
  }

  function cardHTML(p) {
    const sold = p.in_stock_count <= 0;
    const disc = p.compare_price > p.selling_price ? Math.round((1 - p.selling_price / p.compare_price) * 100) : 0;
    return `
    <article class="pcard ${sold ? "sold" : ""}" data-card="${esc(p.id)}">
      ${mediaHTML(p)}
      <div class="pbody">
        <div class="phead-row">
          <span class="pdem">${esc(p.demographic || p.category)}</span>
          <span class="psku">${esc(p.sku || p.id)}</span>
        </div>
        <h3 class="pname">${esc(p.name)}</h3>
        <p class="pmeta">${esc([p.brand, p.size !== "-" ? "Size: " + p.size : "", p.color ? "Color: " + p.color : ""].filter(Boolean).join(" · "))}</p>
        ${p.desc ? `<p class="pdesc">${esc(p.desc)}</p>` : ""}
        <div class="price-row">
          <span class="pprice">${DB.ugx(p.selling_price)}</span>
          ${p.compare_price > p.selling_price ? `<span class="pcompare">${DB.ugx(p.compare_price)}</span><span class="pdisc">-${disc}%</span>` : ""}
          ${p.in_stock_count === 1 ? `<span class="psingular">Singular item</span>` : ""}
        </div>
        <button class="claim-btn" data-add="${esc(p.id)}" ${sold ? "disabled" : ""}>
          ${sold ? "Sold" : `${ICONS.message.replace("<svg ", "<svg width='16' height='16' ")} Claim Piece on WhatsApp`}
        </button>
      </div>
    </article>`;
  }

  function renderGrid() {
    const grid = $("#productGrid");
    const list = products
      .filter(p => fDemo === "All" || p.demographic === fDemo)
      .filter(p => fCat === "All" || p.category === fCat)
      .filter(p => fSize === "All" || p.size === fSize)
      .filter(p => fCond === "All" || p.condition === fCond)
      .filter(p => p.selling_price <= fMax)
      .filter(p => !term || [p.name, p.brand, p.color, p.category, p.sku, p.barcode_id, p.desc].join(" ").toLowerCase().includes(term))
      .sort((a, b) => (b.in_stock_count > 0) - (a.in_stock_count > 0));
    $("#gridEmpty").hidden = list.length > 0;
    grid.innerHTML = list.map(cardHTML).join("");
  }

  $("#productGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-add]"); if (!b) return;
    addToCart(b.dataset.add);
  });

  function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p || p.in_stock_count <= 0) return toast("That piece has already been claimed");
    const line = cart.find(l => l.product_id === id);
    if ((line ? line.qty : 0) + 1 > p.in_stock_count) return toast(`Only ${p.in_stock_count} in stock`);
    if (line) line.qty++; else cart.push({ product_id: id, qty: 1 });
    saveCart(); renderCart();
    toast(`${p.name} added to your bag`);
    openCart();
  }

  /* ---------- cart drawer ---------- */
  function openCart() { document.body.classList.add("cart-open"); }
  function closeCart() { document.body.classList.remove("cart-open"); }
  $("#cartBtn").addEventListener("click", openCart);
  $("#closeCart").addEventListener("click", closeCart);
  $("#drawerBackdrop").addEventListener("click", closeCart);

  function cartLines() {
    return cart.map(l => {
      const p = products.find(x => x.id === l.product_id);
      return p ? { line: l, p, sub: p.selling_price * l.qty } : null;
    }).filter(Boolean);
  }

  function renderCart() {
    const lines = cartLines();
    const total = lines.reduce((s, x) => s + x.sub, 0);
    $("#cartCount").textContent = lines.reduce((s, x) => s + x.line.qty, 0);

    if (orderResult) {
      $("#cartBody").innerHTML = `
        <div class="order-done">
          <svg class="done-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>
          <h4>Your pieces are reserved</h4>
          <p><strong>${esc(orderResult.id)}</strong> · ${DB.ugx(orderResult.total)}</p>
          <p class="note">We've set these aside for 24 hours. Send the WhatsApp message to confirm — MoMo, Airtel or cash all work.</p>
        </div>`;
      $("#cartFoot").innerHTML = `
        <button class="claim-btn" id="openWa">${ICONS.message.replace("<svg ", "<svg width='16' height='16' ")} Open WhatsApp</button>
        <button class="fchip keep-shopping" id="keepShopping">Keep browsing</button>`;
      $("#openWa").addEventListener("click", () => window.open(orderResult.waUrl, "_blank"));
      $("#keepShopping").addEventListener("click", () => { orderResult = null; renderCart(); });
      return;
    }

    if (!lines.length) {
      $("#cartBody").innerHTML = `<p class="empty">Your bag is empty.<br/>Have a look at today's rail.</p>`;
      $("#cartFoot").innerHTML = "";
      return;
    }

    $("#cartBody").innerHTML = lines.map(({ line, p, sub }) => `
      <div class="cart-line">
        <span class="line-thumb">${catIcon(p.category)}${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : ""}</span>
        <div class="grow">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${DB.ugx(p.selling_price)} · ${esc(p.brand)} · Size ${esc(p.size)}</div>
          <div class="line-foot">
            <span class="qty">
              <button data-dec="${esc(p.id)}" ${line.qty <= 1 ? "disabled" : ""}>−</button>
              <span>${line.qty}</span>
              <button data-inc="${esc(p.id)}" ${line.qty >= p.in_stock_count ? "disabled" : ""}>+</button>
            </span>
            <span class="amt">${DB.ugx(sub)}</span>
          </div>
          <button class="rmlink" data-rm="${esc(p.id)}">Remove</button>
        </div>
      </div>`).join("");

    $("#cartFoot").innerHTML = `
      <div class="tot-row"><span class="lbl">Total</span><span class="val">${DB.ugx(total)}</span></div>
      <div class="check-form">
        <input id="coName" placeholder="Your name" autocomplete="name" />
        <input id="coPhone" placeholder="Phone number (07XX 000 000)" autocomplete="tel" />
        <button class="claim-btn" id="waCheckout">${ICONS.message.replace("<svg ", "<svg width='16' height='16' ")} Reserve on WhatsApp</button>
        <p class="note">Reserving sets the pieces aside instantly, then WhatsApp opens to confirm payment and delivery.</p>
      </div>`;
    $("#waCheckout").addEventListener("click", checkout);
  }

  $("#cartBody").addEventListener("click", e => {
    const dec = e.target.closest("[data-dec]"), inc = e.target.closest("[data-inc]"), rm = e.target.closest("[data-rm]");
    if (dec) { const l = cart.find(x => x.product_id === dec.dataset.dec); if (l) l.qty = Math.max(1, l.qty - 1); }
    if (inc) { const l = cart.find(x => x.product_id === inc.dataset.inc); const p = products.find(x => x.id === inc.dataset.inc); if (l && p) l.qty = Math.min(p.in_stock_count, l.qty + 1); }
    if (rm)  { cart = cart.filter(x => x.product_id !== rm.dataset.rm); }
    if (dec || inc || rm) { saveCart(); renderCart(); }
  });

  /* ---------- WhatsApp checkout ---------- */
  async function checkout() {
    const btn = $("#waCheckout");
    const name = $("#coName").value.trim();
    const phone = $("#coPhone").value.trim();
    if (!name) return toast("Please tell us your name first");
    if (cart.length === 0) return;
    btn.disabled = true; btn.textContent = "Reserving your pieces…";
    try {
      const order = await DB.createWebOrder({
        customer_name: name, customer_phone: phone,
        items: cart.map(l => ({ product_id: l.product_id, qty: l.qty }))
      });
      const lines = order.items.map(l => `- ${l.qty}x ${l.name} (${DB.ugx(l.line_total)})`).join("\n");
      const msg = `Hello Adonai Thrift Store. I'd like to claim:\n${lines}\n\nTotal: ${DB.ugx(order.total)}\nOrder: ${order.id}\nName: ${order.customer_name}\nPhone: ${order.customer_phone}`;
      const waUrl = `https://wa.me/${DB.getSettings().whatsapp}?text=${encodeURIComponent(msg)}`;
      orderResult = { id: order.id, total: order.total, waUrl };
      cart = []; saveCart();
      renderCart(); refreshProducts();
      window.open(waUrl, "_blank");
    } catch (err) {
      toast(err.message || "Something went wrong — please try again");
      refreshProducts();
    } finally {
      const b = $("#waCheckout"); if (b) { b.disabled = false; b.innerHTML = `${ICONS.message.replace("<svg ", "<svg width='16' height='16' ")} Reserve on WhatsApp`; }
    }
  }

  /* ---------- real-time stock sync ---------- */
  DB.on("products", () => {
    const before = new Map(products.map(p => [p.id, p.in_stock_count]));
    refreshProducts();
    for (const p of products) {
      const was = before.get(p.id);
      if (was !== undefined && was > 0 && p.in_stock_count === 0) {
        const card = document.querySelector(`[data-card="${p.id}"]`);
        if (card) { card.classList.add("flip"); setTimeout(() => card.classList.remove("flip"), 900); }
        toast(`"${p.name}" just sold in the shop — pieces move fast`);
      }
    }
  });

  /* ---------- boot ---------- */
  refreshProducts();
  renderCart();
})();
