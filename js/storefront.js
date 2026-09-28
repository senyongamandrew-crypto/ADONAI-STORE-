/* ============ Adonai Thrift Store — public storefront logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const CART_KEY = "adonai-cart-v1";

  /* ---------- stroke icon set (24×24, 1.5px — Lucide style) ---------- */
  const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    Jackets: svg(`<path d="M6 4l3-2c0 1.7 1.3 3 3 3s3-1.3 3-3l3 2 1.7 4.6c.2.7-.2 1.3-.9 1.4L17 10.4V20a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9.6l-1.8-.4a1 1 0 0 1-.9-1.4L6 4Z"/><path d="M12 6.5V22"/>`),
    Shirts: svg(`<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23Z"/>`),
    Shoes: svg(`<path d="M2 16.2V9.4c0-.8.6-1.4 1.4-1.4h1.9c.6 0 1.1.2 1.5.7l2.4 2.9c.5.6 1.2.9 1.9 1l8.9 1.4c1 .2 1.7 1 1.7 2v.8c0 .6-.4 1-1 1H2.9c-.5 0-.9-.3-.9-.6Z"/><path d="M6.8 8.3l1.8 1.9M4.7 8.2l1.5 1.7"/>`),
    Dresses: svg(`<path d="M9 2c0 1.4 1.3 2.5 3 2.5S15 3.4 15 2l1.5 4-1.2 3 3.7 10.6a1 1 0 0 1-1 1.4H6a1 1 0 0 1-1-1.4L8.7 9l-1.2-3L9 2Z"/><path d="M8.7 9h6.6"/>`),
    Trousers: svg(`<path d="M6.5 2h11l1.2 19.2a.8.8 0 0 1-.8.8h-4.6l-1.3-11-1.3 11H6.1a.8.8 0 0 1-.8-.9L6.5 2Z"/><path d="M6.5 6h11"/>`),
    Accessories: svg(`<path d="M4 8h16l-1.2 12.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 8Z"/><path d="M8.5 10.5V6.5a3.5 3.5 0 0 1 7 0v4"/>`),
    tag: svg(`<path d="M12.6 2.6 21 11a1.4 1.4 0 0 1 0 2l-8 8a1.4 1.4 0 0 1-2 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6Z"/><circle cx="7" cy="7" r="1.4"/>`),
    check: svg(`<path d="M20 6 9 17l-5-5"/>`),
    message: svg(`<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 1 1 21 11.5Z"/>`)
  };
  const catIcon = c => ICONS[c] || ICONS.tag;

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- settings / staff gateway ---------- */
  const settings = DB.getSettings();
  $("#footContact").innerHTML = `
    <a class="foot-link" href="https://wa.me/${esc(settings.whatsapp)}" target="_blank" rel="noopener">
      ${ICONS.message.replace("<svg ", "<svg width='16' height='16' ")} WhatsApp +${esc(settings.whatsapp)}
    </a>`;
  const staffHref = (!Auth.locked() || Auth.me()) ? "pos.html" : "login.html"; // open access → straight to POS
  $("#staffLink").href = staffHref;
  $("#staffLinkFoot").href = staffHref;

  /* ---------- cart (local to this browser) ---------- */
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
  const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(cart));
  let orderResult = null;

  /* ---------- shop state ---------- */
  let products = [];
  let activeCat = "All";
  let term = "";

  function refreshProducts() {
    products = DB.listProducts();
    let changed = false;
    cart = cart.reduce((acc, l) => {
      const p = products.find(x => x.id === l.product_id);
      if (!p || p.in_stock_count <= 0) { changed = true; if (p) toast(`"${p.name}" was just sold in the shop`); return acc; }
      if (l.qty > p.in_stock_count) { l.qty = p.in_stock_count; changed = true; }
      acc.push(l); return acc;
    }, []);
    if (changed) { saveCart(); renderCart(); }
    renderTabs(); renderGrid();
  }

  /* ---------- category tabs ---------- */
  function renderTabs() {
    const cats = ["All"].concat(DB.CATEGORIES);
    $("#catTabs").innerHTML = cats.map(c => {
      const n = c === "All" ? products.filter(p => p.in_stock_count > 0).length
                            : products.filter(p => p.category === c && p.in_stock_count > 0).length;
      return `<button class="tab ${c === activeCat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)} <span style="opacity:.55">${n}</span></button>`;
    }).join("");
  }
  $("#catTabs").addEventListener("click", e => {
    const t = e.target.closest(".tab"); if (!t) return;
    activeCat = t.dataset.cat; renderTabs(); renderGrid();
  });
  $("#shopSearch").addEventListener("input", e => { term = e.target.value.trim().toLowerCase(); renderGrid(); });

  /* ---------- product grid ---------- */
  const pill = p => p.in_stock_count > 0
    ? `<span class="pill"><span class="dot"></span>In stock</span>`
    : `<span class="pill sold"><span class="dot"></span>Sold</span>`;

  function thumbHTML(p, iconSize) {
    const img = p.image_url
      ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove()" />`
      : "";
    return `<div class="thumb"><span class="thumb-icon">${catIcon(p.category)}</span>${img}${pill(p)}</div>`;
  }

  function renderGrid() {
    const grid = $("#productGrid");
    const list = products
      .filter(p => activeCat === "All" || p.category === activeCat)
      .filter(p => !term || [p.name, p.category, p.size, p.condition].join(" ").toLowerCase().includes(term))
      .sort((a, b) => (b.in_stock_count > 0) - (a.in_stock_count > 0)); // available first

    $("#gridEmpty").hidden = list.length > 0;
    grid.innerHTML = list.map(p => {
      const sold = p.in_stock_count <= 0;
      return `
      <article class="card ${sold ? "sold" : ""}" data-card="${esc(p.id)}">
        ${thumbHTML(p)}
        <div class="card-body">
          <p class="micro">${esc(p.category)}</p>
          <h3 class="card-name">${esc(p.name)}</h3>
          <p class="card-meta">Size ${esc(p.size)} · ${esc(p.condition)}</p>
          <div class="card-foot">
            <span class="price">${DB.ugx(p.selling_price)}</span>
            <button class="add-btn" data-add="${esc(p.id)}" ${sold ? "disabled" : ""}>${sold ? "Sold" : "Add to bag"}</button>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  $("#productGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-add]"); if (!b) return;
    addToCart(b.dataset.add);
  });

  function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p || p.in_stock_count <= 0) return toast("That piece has already sold");
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

  function lineThumb(p) {
    const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : "";
    return `<span class="line-thumb">${catIcon(p.category)}${img}</span>`;
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
          <p class="note">We've set these aside for 24 hours. Send the WhatsApp message to confirm payment — MoMo, Airtel or cash all work.</p>
        </div>`;
      $("#cartFoot").innerHTML = `
        <button class="wa-btn" id="openWa">${ICONS.message} Open WhatsApp</button>
        <button class="btn ghost keep-shopping" id="keepShopping">Keep browsing</button>`;
      $("#openWa").addEventListener("click", () => window.open(orderResult.waUrl, "_blank"));
      $("#keepShopping").addEventListener("click", () => { orderResult = null; renderCart(); });
      return;
    }

    if (!lines.length) {
      $("#cartBody").innerHTML = `<p class="empty">Your bag is empty.<br/>Have a look at what's on the rail today.</p>`;
      $("#cartFoot").innerHTML = "";
      return;
    }

    $("#cartBody").innerHTML = lines.map(({ line, p, sub }) => `
      <div class="cart-line">
        ${lineThumb(p)}
        <div class="grow">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${DB.ugx(p.selling_price)} · Size ${esc(p.size)}</div>
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
        <button class="wa-btn" id="waCheckout">${ICONS.message} Reserve on WhatsApp</button>
        <p class="note">Reserving sets the pieces aside instantly, then WhatsApp opens so we can confirm payment and delivery.</p>
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

  /* ---------- WhatsApp checkout → unified sales DB ---------- */
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
      const msg = `Hello Adonai Thrift Store. I'd like to reserve:\n${lines}\n\nTotal: ${DB.ugx(order.total)}\nOrder: ${order.id}\nName: ${order.customer_name}\nPhone: ${order.customer_phone}`;
      const waUrl = `https://wa.me/${DB.getSettings().whatsapp}?text=${encodeURIComponent(msg)}`;
      orderResult = { id: order.id, total: order.total, waUrl };
      cart = []; saveCart();
      renderCart(); refreshProducts();
      window.open(waUrl, "_blank");
    } catch (err) {
      toast(err.message || "Something went wrong — please try again");
      refreshProducts();
    } finally {
      const b = $("#waCheckout"); if (b) { b.disabled = false; b.innerHTML = `${ICONS.message} Reserve on WhatsApp`; }
    }
  }

  /* ---------- real-time: POS sales flip badges live ---------- */
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
