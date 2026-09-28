/* ============ Adonai Thrift Store — public storefront logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const EMOJI = { Jackets: "🧥", Shirts: "👕", Shoes: "👟", Dresses: "👗", Trousers: "👖", Accessories: "👜" };
  const HUES = { Jackets: "#5b7f9e", Shirts: "#7d9e5b", Shoes: "#9e7c5b", Dresses: "#a05b9e", Trousers: "#5b8e9e", Accessories: "#9e5b6b" };
  const CART_KEY = "adonai-cart-v1";

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- settings / staff gateway ---------- */
  const settings = DB.getSettings();
  $("#footContact").innerHTML = `WhatsApp <a href="https://wa.me/${esc(settings.whatsapp)}" target="_blank" rel="noopener">+${esc(settings.whatsapp)}</a>`;
  const staffHref = (!Auth.locked() || Auth.me()) ? "pos.html" : "login.html"; // open access → straight to POS
  $("#staffLink").href = staffHref;
  $("#staffLinkFoot").href = staffHref;

  /* ---------- cart (local to this browser) ---------- */
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
  const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(cart));
  let orderResult = null; // shown instead of cart after successful checkout

  /* ---------- shop state ---------- */
  let products = [];
  let activeCat = "All";
  let term = "";

  function refreshProducts() {
    products = DB.listProducts();
    // clamp cart against latest stock (real-time safety)
    let changed = false;
    cart = cart.reduce((acc, l) => {
      const p = products.find(x => x.id === l.product_id);
      if (!p || p.in_stock_count <= 0) { changed = true; if (p) toast(`"${p.name}" was just sold in store`); return acc; }
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
      return `<button class="tab ${c === activeCat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)} <span style="opacity:.6">(${n})</span></button>`;
    }).join("");
  }
  $("#catTabs").addEventListener("click", e => {
    const t = e.target.closest(".tab"); if (!t) return;
    activeCat = t.dataset.cat; renderTabs(); renderGrid();
  });
  $("#shopSearch").addEventListener("input", e => { term = e.target.value.trim().toLowerCase(); renderGrid(); });

  /* ---------- product grid ---------- */
  function stockBadge(p) {
    return p.in_stock_count > 0
      ? `<span class="stock-badge">In stock${p.in_stock_count > 1 ? " ×" + p.in_stock_count : ""}</span>`
      : `<span class="stock-badge sold">Sold</span>`;
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
      const hue = HUES[p.category] || "#7a7466";
      return `
      <article class="card ${sold ? "sold" : ""}" data-card="${esc(p.id)}">
        <div class="thumb" style="background:linear-gradient(150deg, ${hue}22, ${hue}4d)">
          ${stockBadge(p)}
          <span>${EMOJI[p.category] || "🏷️"}</span>
          ${sold ? `<div class="sold-overlay">SOLD</div>` : ""}
        </div>
        <div class="card-body">
          <div class="card-title">${esc(p.name)}</div>
          <div class="chips">
            <span class="chiplet">${esc(p.category)}</span>
            <span class="chiplet">Size ${esc(p.size)}</span>
            <span class="chiplet">${esc(p.condition)}</span>
          </div>
          <div class="card-foot">
            <span class="price">${DB.ugx(p.selling_price)}</span>
            <button class="add-btn" data-add="${esc(p.id)}" ${sold ? "disabled" : ""}>${sold ? "Sold" : "Add to cart"}</button>
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
    if (!p || p.in_stock_count <= 0) return toast("Sorry — that piece is sold");
    const line = cart.find(l => l.product_id === id);
    const inCart = line ? line.qty : 0;
    if (inCart + 1 > p.in_stock_count) return toast(`Only ${p.in_stock_count} in stock`);
    if (line) line.qty++; else cart.push({ product_id: id, qty: 1 });
    saveCart(); renderCart();
    toast(`${p.name} added to cart`);
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
          <div class="big">🎉</div>
          <h3>Order reserved!</h3>
          <p><strong>${esc(orderResult.id)}</strong> · ${DB.ugx(orderResult.total)}</p>
          <p class="note">We've set your items aside. Complete payment on WhatsApp to confirm — items are held for 24 hours.</p>
        </div>`;
      $("#cartFoot").innerHTML = `
        <button class="wa-btn" id="openWa">💬 Open WhatsApp chat</button>
        <p class="note">Order id <strong>${esc(orderResult.id)}</strong> is included in the message.</p>
        <button class="tab" id="keepShopping" style="width:100%;margin-top:10px">Keep shopping</button>`;
      $("#openWa").addEventListener("click", () => window.open(orderResult.waUrl, "_blank"));
      $("#keepShopping").addEventListener("click", () => { orderResult = null; renderCart(); });
      return;
    }

    if (!lines.length) {
      $("#cartBody").innerHTML = `<p class="empty">Your cart is empty.<br/>Beautiful pieces are waiting 🛍️</p>`;
      $("#cartFoot").innerHTML = "";
      return;
    }

    $("#cartBody").innerHTML = lines.map(({ line, p, sub }) => `
      <div class="cart-line">
        <span class="emoji">${EMOJI[p.category] || "🏷️"}</span>
        <div class="grow">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${DB.ugx(p.selling_price)} · Size ${esc(p.size)} · ${esc(p.condition)}</div>
        </div>
        <div class="qty">
          <button data-dec="${esc(p.id)}" ${line.qty <= 1 ? "disabled" : ""}>−</button>
          <span>${line.qty}</span>
          <button data-inc="${esc(p.id)}" ${line.qty >= p.in_stock_count ? "disabled" : ""}>+</button>
        </div>
        <strong>${DB.ugx(sub)}</strong>
        <button class="rm" data-rm="${esc(p.id)}" title="Remove">✕</button>
      </div>`).join("");

    $("#cartFoot").innerHTML = `
      <div class="tot-row"><span>Total</span><span>${DB.ugx(total)}</span></div>
      <div class="check-form">
        <input id="coName" placeholder="Your name" autocomplete="name" />
        <input id="coPhone" placeholder="Phone (e.g. 0772 000 000)" autocomplete="tel" />
        <button class="wa-btn" id="waCheckout">💬 Place order via WhatsApp</button>
        <p class="note">Reserves your items instantly, then opens WhatsApp to confirm payment (MTN MoMo / Airtel / cash on pickup).</p>
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
    if (!name) return toast("Please enter your name");
    if (cart.length === 0) return;
    btn.disabled = true; btn.textContent = "Reserving your items…";
    try {
      const order = await DB.createWebOrder({
        customer_name: name, customer_phone: phone,
        items: cart.map(l => ({ product_id: l.product_id, qty: l.qty }))
      });
      // build the WhatsApp payload (staff sees this verbatim)
      const lines = order.items.map(l => `• ${l.qty}× ${l.name} — ${DB.ugx(l.line_total)}`).join("\n");
      const msg = `Hello Adonai Thrift Store! 🛍️\nI would like to order:\n${lines}\n\nTotal: ${DB.ugx(order.total)}\nOrder: ${order.id}\nName: ${order.customer_name}\nPhone: ${order.customer_phone}`;
      const waUrl = `https://wa.me/${DB.getSettings().whatsapp}?text=${encodeURIComponent(msg)}`;
      orderResult = { id: order.id, total: order.total, waUrl };
      cart = []; saveCart();
      renderCart(); refreshProducts();          // items now show Sold live
      window.open(waUrl, "_blank");
    } catch (err) {
      toast(err.message || "Could not place the order — please try again");
      refreshProducts();                        // pull truthful stock, fix cart
    } finally {
      const b = $("#waCheckout"); if (b) { b.disabled = false; b.textContent = "💬 Place order via WhatsApp"; }
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
        toast(`"${p.name}" was just sold in store — going fast!`);
      }
    }
  });

  /* ---------- boot ---------- */
  refreshProducts();
  renderCart();
})();
