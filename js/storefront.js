/* ============ Adonai Thrift Store — public storefront logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

  /* ---------- consent banner (disappears immediately upon choice) ---------- */
  function hideConsent(choice) {
    localStorage.setItem(CONSENT_KEY, choice || "essential");
    const el = $("#consent");
    if (el) {
      el.hidden = true;
      el.style.display = "none";
    }
  }

  if (!localStorage.getItem(CONSENT_KEY)) {
    $("#consent").hidden = false;
  } else {
    $("#consent").hidden = true;
    $("#consent").style.display = "none";
  }

  $$("[data-consent]").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset.consent;
    hideConsent(v);
    toast(v === "all" ? "Cookie preferences saved" : "Essential preferences active");
  }));

  const closeConsentBtn = $("#closeConsent");
  if (closeConsentBtn) {
    closeConsentBtn.addEventListener("click", () => {
      hideConsent("dismissed");
    });
  }

  /* ---------- cart ---------- */
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
  const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(cart));
  let orderResult = null;

  /* ---------- filter state ---------- */
  let products = [];
  let fDemo = "All", fCat = "All", fSize = "All", fCond = "All", fMax = 200000, term = "";

  function getProductImages(p) {
    if (!p) return [];
    const list = [];
    if (Array.isArray(p.images) && p.images.length) {
      p.images.forEach(img => {
        if (img && typeof img === "string" && !list.includes(img)) list.push(img);
      });
    }
    if (p.image_url && !list.includes(p.image_url)) {
      list.unshift(p.image_url);
    }
    return list;
  }

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

    // If modal is currently open, refresh its data
    if (activeModalProductId) {
      const p = products.find(x => x.id === activeModalProductId);
      if (p) renderProductModal(p);
    }
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

  /* ---------- product card with multi-angle preview ---------- */
  function mediaHTML(p, photos) {
    const mainImg = photos[0] || p.image_url;
    const img = mainImg ? `<img src="${esc(mainImg)}" alt="${esc(p.name)}" loading="lazy" />` : "";
    const dots = photos.length > 1
      ? `<div class="media-dots" title="Click to view all photo angles">${photos.map((src, i) => `<i class="${i === 0 ? "active" : ""}" data-angle="${i}"><img src="${esc(src)}" alt="Angle ${i + 1}" /></i>`).join("")}</div>`
      : "";
    return `
      <div class="pmedia">
        ${img || `<span class="media-icon">${catIcon(p.category)}</span>`}
        ${dots}
      </div>`;
  }

  function cardHTML(p) {
    const sold = p.in_stock_count <= 0;
    const disc = p.compare_price > p.selling_price ? Math.round((1 - p.selling_price / p.compare_price) * 100) : 0;
    const photos = getProductImages(p);
    return `
    <article class="pcard ${sold ? "sold" : ""}" data-card="${esc(p.id)}" tabindex="0" role="button" aria-label="View details and photo views for ${esc(p.name)}">
      ${mediaHTML(p, photos)}
      <div class="pbody">
        <div class="phead-row">
          <span class="pdem">${esc(p.demographic || p.category)}</span>
          <span class="psku">${esc(p.sku || p.id)}</span>
        </div>
        <h3 class="pname">${esc(p.name)}</h3>
        <p class="pmeta">${esc([p.brand, p.size !== "-" ? "Size: " + p.size : "", p.color ? "Color: " + p.color : "", p.condition].filter(Boolean).join(" · "))}</p>
        ${p.desc ? `<p class="pdesc">${esc(p.desc)}</p>` : ""}
        <div class="price-row">
          <span class="pprice">${DB.ugx(p.selling_price)}</span>
          ${p.compare_price > p.selling_price ? `<span class="pcompare">${DB.ugx(p.compare_price)}</span><span class="pdisc">-${disc}%</span>` : ""}
          ${p.in_stock_count === 1 ? `<span class="psingular">Singular item</span>` : ""}
        </div>
        <div class="pcard-actions">
          <button class="detail-btn" data-detail="${esc(p.id)}" type="button">🔍 View Photos &amp; Specs</button>
          <button class="claim-btn" data-add="${esc(p.id)}" ${sold ? "disabled" : ""} type="button">
            ${sold ? "Sold" : `${ICONS.message.replace("<svg ", "<svg width='15' height='15' ")} Claim on WhatsApp`}
          </button>
        </div>
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
    const addBtn = e.target.closest("[data-add]");
    if (addBtn) {
      e.stopPropagation();
      return addToCart(addBtn.dataset.add);
    }
    const angleDot = e.target.closest("[data-angle]");
    if (angleDot) {
      e.stopPropagation();
      const card = e.target.closest("[data-card]");
      if (card) {
        return openProductModal(card.dataset.card, Number(angleDot.dataset.angle));
      }
    }
    const card = e.target.closest("[data-card]");
    if (card) {
      openProductModal(card.dataset.card, 0);
    }
  });

  $("#productGrid").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      const card = e.target.closest("[data-card]");
      if (card && !e.target.closest("button")) {
        e.preventDefault();
        openProductModal(card.dataset.card, 0);
      }
    }
  });

  /* ============================================================
     PRODUCT DETAIL MODAL & MULTI-ANGLE VIEWER
     ============================================================ */
  let activeModalProductId = null;
  let activeModalPhotoIdx = 0;

  function openProductModal(id, initialPhotoIdx = 0) {
    const p = products.find(x => x.id === id) || DB.getProduct(id);
    if (!p) return;
    activeModalProductId = id;
    activeModalPhotoIdx = Math.max(0, initialPhotoIdx);
    renderProductModal(p);
    $("#prodBackdrop").classList.add("open");
    document.body.classList.add("modal-open");
  }

  function closeProductModal() {
    $("#prodBackdrop").classList.remove("open");
    document.body.classList.remove("modal-open");
    activeModalProductId = null;
  }

  function renderProductModal(p) {
    const photos = getProductImages(p);
    const sold = p.in_stock_count <= 0;
    const disc = p.compare_price > p.selling_price ? Math.round((1 - p.selling_price / p.compare_price) * 100) : 0;
    const totalPhotos = photos.length;
    if (activeModalPhotoIdx >= totalPhotos) activeModalPhotoIdx = Math.max(0, totalPhotos - 1);
    const activePhoto = photos[activeModalPhotoIdx] || "";

    const ANGLE_NAMES = ["1. Front View", "2. Back View", "3. Fabric / Texture", "4. Tag & Authenticity"];
    const angleLabel = totalPhotos > 0
      ? (ANGLE_NAMES[activeModalPhotoIdx] || `Angle ${activeModalPhotoIdx + 1}`)
      : "Curated piece";

    const modalBox = $("#prodModal");
    modalBox.innerHTML = `
      <button class="pmodal-close" id="closeProdModal" aria-label="Close product view">✕</button>

      <!-- Left column: Multi-angle photo gallery -->
      <div class="pmodal-gallery">
        <div class="pmodal-stage">
          ${activePhoto
            ? `<img id="pmodalMainImg" src="${esc(activePhoto)}" alt="${esc(p.name)} - ${esc(angleLabel)}" />`
            : `<span class="media-icon">${catIcon(p.category)}</span>`}
          ${totalPhotos > 1 ? `
            <button class="pmodal-nav prev" id="pmodalPrev" aria-label="Previous angle">‹</button>
            <button class="pmodal-nav next" id="pmodalNext" aria-label="Next angle">›</button>
            <span class="pmodal-badge" id="pmodalBadge">${activeModalPhotoIdx + 1} / ${totalPhotos} · ${esc(angleLabel)}</span>
          ` : ""}
        </div>

        ${totalPhotos > 1 ? `
          <div class="pmodal-thumbs" id="pmodalThumbs">
            ${photos.map((src, idx) => `
              <div class="pmodal-thumb ${idx === activeModalPhotoIdx ? "active" : ""}" data-pthumb="${idx}" title="${ANGLE_NAMES[idx] || `Angle ${idx + 1}`}">
                <img src="${esc(src)}" alt="Angle ${idx + 1}" onerror="this.remove()" />
                <span class="pmodal-thumb-hint">${idx === 0 ? "Front" : idx === 1 ? "Back" : idx === 2 ? "Fabric" : "Tag"}</span>
              </div>`).join("")}
          </div>
        ` : `
          <p class="pmodal-thumb-hint" style="text-align:center;margin-top:2px">📷 Genuine one-of-one item photo · Laundered &amp; inspected in Kampala</p>
        `}
      </div>

      <!-- Right column: Item details & checkout -->
      <div class="pmodal-info">
        <div class="pmodal-kicker">
          <span>${esc(p.demographic || "Vintage")}</span> · <span>${esc(p.category)}</span>
          <code>${esc(p.sku || p.barcode_id || p.id)}</code>
        </div>
        <h2 class="pmodal-title" id="pmodalTitle">${esc(p.name)}</h2>

        <div class="pmodal-price-box">
          <span class="pmodal-price">${DB.ugx(p.selling_price)}</span>
          ${p.compare_price > p.selling_price ? `<span class="pmodal-compare">${DB.ugx(p.compare_price)}</span><span class="pmodal-disc">-${disc}% OFF</span>` : ""}
          <span class="pmodal-stock ${sold ? "out" : "in"}">
            ${sold ? "● SOLD OUT" : (p.in_stock_count === 1 ? "✓ 1-of-1 Piece on Rail" : `✓ ${p.in_stock_count} in stock`)}
          </span>
        </div>

        <div class="pmodal-specs">
          <div class="pmodal-spec-row"><span class="pmodal-spec-k">Brand / Label</span><span class="pmodal-spec-v">${esc(p.brand || "Vintage / Unbranded")}</span></div>
          <div class="pmodal-spec-row"><span class="pmodal-spec-k">Size &amp; Fit</span><span class="pmodal-spec-v">${esc(p.size && p.size !== "-" ? p.size : "Standard")}</span></div>
          <div class="pmodal-spec-row"><span class="pmodal-spec-k">Condition Grade</span><span class="pmodal-spec-v">${esc(p.condition || "Grade A — Excellent")}</span></div>
          <div class="pmodal-spec-row"><span class="pmodal-spec-k">Colour / Wash</span><span class="pmodal-spec-v">${esc(p.color || "Standard")}</span></div>
        </div>

        ${p.desc ? `<p class="pmodal-story">${esc(p.desc)}</p>` : ""}
        ${p.staff_notes ? `<div class="pmodal-store-notes"><strong>Store note:</strong> ${esc(p.staff_notes)}</div>` : ""}

        <div class="pmodal-assurance">
          📍 Plot 14 Kampala Road / Mercer Hub · 🛵 Same-Day Kampala Boda Delivery · 📱 MTN MoMo / Airtel Money / Cash
        </div>

        <div class="pmodal-actions">
          <button class="pmodal-claim-btn" id="pmodalClaimBtn" data-modal-claim="${esc(p.id)}" ${sold ? "disabled" : ""}>
            ${sold ? "Sold" : `${ICONS.message.replace("<svg ", "<svg width='18' height='18' ")} Claim Piece &amp; Add to Bag`}
          </button>
          <a class="pmodal-wa-btn" href="https://wa.me/${esc(S.whatsapp)}?text=${encodeURIComponent(`Hello Adonai Thrift Store, I would like to ask about: ${p.name} (${p.sku || p.barcode_id}, ${DB.ugx(p.selling_price)}, Size: ${p.size}). Is it still on the shelf?`)}" target="_blank" rel="noopener">
            ${ICONS.message.replace("<svg ", "<svg width='16' height='16' ")} Inquire on WhatsApp directly
          </a>
        </div>
      </div>
    `;

    $("#closeProdModal").addEventListener("click", closeProductModal);

    const prevBtn = $("#pmodalPrev");
    const nextBtn = $("#pmodalNext");
    if (prevBtn) {
      prevBtn.addEventListener("click", e => {
        e.stopPropagation();
        activeModalPhotoIdx = (activeModalPhotoIdx - 1 + totalPhotos) % totalPhotos;
        renderProductModal(p);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", e => {
        e.stopPropagation();
        activeModalPhotoIdx = (activeModalPhotoIdx + 1) % totalPhotos;
        renderProductModal(p);
      });
    }

    const thumbsBox = $("#pmodalThumbs");
    if (thumbsBox) {
      thumbsBox.addEventListener("click", e => {
        const t = e.target.closest("[data-pthumb]");
        if (t) {
          activeModalPhotoIdx = Number(t.dataset.pthumb);
          renderProductModal(p);
        }
      });
    }

    const claimBtn = $("#pmodalClaimBtn");
    if (claimBtn) {
      claimBtn.addEventListener("click", () => {
        addToCart(p.id);
        closeProductModal();
      });
    }
  }

  $("#prodBackdrop").addEventListener("click", e => {
    if (e.target === $("#prodBackdrop")) closeProductModal();
  });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && activeModalProductId) {
      closeProductModal();
    }
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
  const DELIVERY_AREAS = [
    { name: "Kampala Central / Nakasero", fee: 7000 },
    { name: "Kololo / Kamwokya / Bukoto", fee: 7000 },
    { name: "Ntinda / Naguru / Kiwatule", fee: 7000 },
    { name: "Bugolobi / Mbuya / Mutungo", fee: 7000 },
    { name: "Muyenga / Kansanga / Ggaba", fee: 7000 },
    { name: "Kibuli / Nsambya / Makindye", fee: 7000 },
    { name: "Rubaga / Mengo / Namirembe", fee: 7000 },
    { name: "Bwaise / Kawempe / Kisaasi", fee: 7000 },
    { name: "Entebbe Road & Corridor", fee: 12000 },
    { name: "Mukono / Seeta Corridor", fee: 12000 },
    { name: "Upcountry Express Parcel (Jinja, Mbarara, Mbale)", fee: 15000 }
  ];

  let deliveryType = "boda"; // 'boda' | 'pickup'
  let selectedAreaIndex = 0;
  let formState = {
    name: "",
    phone: "",
    address: "",
    notes: ""
  };

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
    const itemCount = lines.reduce((s, x) => s + x.line.qty, 0);
    const subtotal = lines.reduce((s, x) => s + x.sub, 0);
    const currentDeliveryFee = deliveryType === "pickup" ? 0 : (DELIVERY_AREAS[selectedAreaIndex] ? DELIVERY_AREAS[selectedAreaIndex].fee : 7000);
    const grandTotal = subtotal + currentDeliveryFee;
    $("#cartCount").textContent = itemCount;

    if (orderResult) {
      $("#cartBody").innerHTML = `
        <div class="order-confirmed-view">
          <div class="order-held-pill">
            Held as <strong>${esc(orderResult.id)}</strong>. Your pieces are reserved off the rails.
          </div>

          <div class="total-due-card">
            <span class="due-lbl">TOTAL AMOUNT DUE</span>
            <span class="due-val">${DB.ugx(orderResult.total)}</span>
          </div>

          <p class="wa-instruct">WhatsApp should have opened with your order summary. If not, tap below to message our Kampala desk:</p>

          <a class="open-wa-btn" id="openWaMsg" href="${esc(orderResult.waUrl)}" target="_blank" rel="noopener">
            Open WhatsApp Order Message →
          </a>

          <div class="wa-msg-preview-box">
            <pre>${esc(orderResult.rawMessage)}</pre>
          </div>
        </div>`;
      $("#cartFoot").innerHTML = `
        <button class="claim-confirm-btn" id="keepShopping">Continue Browsing Catalog</button>`;
      $("#keepShopping").addEventListener("click", () => { orderResult = null; renderCart(); closeCart(); });
      return;
    }

    if (!lines.length) {
      $("#cartBody").innerHTML = `<p class="empty">Your bag is empty.<br/>Have a look at today's rail.</p>`;
      $("#cartFoot").innerHTML = "";
      return;
    }

    $("#cartBody").innerHTML = `
      ${lines.map(({ line, p, sub }) => `
        <div class="cart-line-card">
          <span class="line-thumb">${catIcon(p.category)}${p.image_url ? `<img src="${esc(p.image_url)}" alt="" onerror="this.remove()" />` : ""}</span>
          <div class="line-details">
            <div class="line-title">${esc(p.name)}</div>
            <div class="line-sku">${esc(p.sku || p.barcode_id || p.id)}</div>
            <div class="line-price-meta">Size: ${esc(p.size && p.size !== "-" ? p.size : "Standard")} · ${DB.ugx(p.selling_price)}</div>
          </div>
          <button class="line-remove-btn" data-rm="${esc(p.id)}" aria-label="Remove item">✕</button>
        </div>`).join("")}

      <div class="claim-form">
        <input class="claim-input" id="coName" placeholder="Your Full Name *" autocomplete="name" value="${esc(formState.name)}" required />
        <input class="claim-input" id="coPhone" placeholder="WhatsApp Phone Number (e.g. 0758873398) *" autocomplete="tel" value="${esc(formState.phone)}" required />

        <div class="delivery-toggle-row">
          <button type="button" class="deliv-toggle-btn ${deliveryType === 'boda' ? 'active' : ''}" id="btnDelivBoda">Boda Delivery</button>
          <button type="button" class="deliv-toggle-btn ${deliveryType === 'pickup' ? 'active' : ''}" id="btnDelivPickup">Store Pickup (Free)</button>
        </div>

        <div id="bodaDeliveryBox" ${deliveryType === 'pickup' ? 'style="display:none"' : ''}>
          <label class="claim-field-label">Destination Area:</label>
          <select class="claim-select" id="coArea">
            ${DELIVERY_AREAS.map((a, idx) => `<option value="${idx}" ${idx === selectedAreaIndex ? 'selected' : ''}>${esc(a.name)} (${DB.ugx(a.fee)})</option>`).join("")}
          </select>
          <input class="claim-input" id="coAddress" placeholder="Street, Building, Flat or Landmark Details *" value="${esc(formState.address)}" />
        </div>

        <textarea class="claim-textarea" id="coNotes" placeholder="Delivery notes or sizing question (optional)..." rows="2">${esc(formState.notes)}</textarea>
      </div>
    `;

    $("#cartFoot").innerHTML = `
      <div class="claim-summary-box">
        <div class="sum-line"><span>Items (${itemCount}):</span><span>${DB.ugx(subtotal)}</span></div>
        <div class="sum-line"><span>Rider Delivery:</span><span>${currentDeliveryFee > 0 ? DB.ugx(currentDeliveryFee) : "Free"}</span></div>
        <div class="sum-line total"><strong>Total:</strong><strong class="rust">${DB.ugx(grandTotal)}</strong></div>
      </div>
      <button class="claim-confirm-btn" id="waCheckout">Confirm Claim on WhatsApp (${DB.ugx(grandTotal)})</button>
      <p class="claim-notice-sub">Returns or exchanges honored within 2 days with valid receipt.</p>
    `;

    // Bind form inputs
    const elName = $("#coName"), elPhone = $("#coPhone"), elAddr = $("#coAddress"), elNotes = $("#coNotes"), elArea = $("#coArea");
    if (elName) elName.addEventListener("input", e => { formState.name = e.target.value; });
    if (elPhone) elPhone.addEventListener("input", e => { formState.phone = e.target.value; });
    if (elAddr) elAddr.addEventListener("input", e => { formState.address = e.target.value; });
    if (elNotes) elNotes.addEventListener("input", e => { formState.notes = e.target.value; });
    if (elArea) elArea.addEventListener("change", e => {
      selectedAreaIndex = Number(e.target.value);
      renderCart();
    });

    const btnBoda = $("#btnDelivBoda"), btnPickup = $("#btnDelivPickup");
    if (btnBoda) btnBoda.addEventListener("click", () => { deliveryType = "boda"; renderCart(); });
    if (btnPickup) btnPickup.addEventListener("click", () => { deliveryType = "pickup"; renderCart(); });

    const btnWa = $("#waCheckout");
    if (btnWa) btnWa.addEventListener("click", checkout);
  }

  $("#cartBody").addEventListener("click", e => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      cart = cart.filter(x => x.product_id !== rm.dataset.rm);
      saveCart();
      renderCart();
    }
  });

  /* ---------- WhatsApp checkout ---------- */
  async function checkout() {
    const btn = $("#waCheckout");
    const name = formState.name.trim();
    const phone = formState.phone.trim();
    const address = formState.address.trim();
    const notes = formState.notes.trim();

    if (!name) {
      toast("Please enter your name");
      const el = $("#coName"); if (el) el.focus();
      return;
    }
    if (!phone) {
      toast("Please enter your WhatsApp phone number");
      const el = $("#coPhone"); if (el) el.focus();
      return;
    }
    if (deliveryType === "boda" && !address) {
      toast("Please enter your landmark or street details");
      const el = $("#coAddress"); if (el) el.focus();
      return;
    }
    if (cart.length === 0) return;

    const areaObj = DELIVERY_AREAS[selectedAreaIndex] || DELIVERY_AREAS[0];
    const deliveryFee = deliveryType === "pickup" ? 0 : areaObj.fee;
    const areaName = deliveryType === "pickup" ? "Store Pickup (Mercer Hub / Plot 45 Salama Road)" : areaObj.name;

    btn.disabled = true;
    btn.textContent = "Reserving your pieces…";

    try {
      const order = await DB.createWebOrder({
        customer_name: name,
        customer_phone: phone,
        delivery_type: deliveryType,
        delivery_area: areaName,
        delivery_address: address,
        delivery_fee: deliveryFee,
        delivery_notes: notes,
        items: cart.map(l => ({ product_id: l.product_id, qty: l.qty }))
      });

      const totalItems = order.items.reduce((a, b) => a + b.qty, 0);
      const deliveryLocStr = deliveryType === "pickup"
        ? "Store Pickup (Mercer Hub / Plot 45 Salama Road)"
        : (address ? `${areaName} - ${address}` : areaName);

      const msgLines = [
        "👕 *ADONAI THRIFT STORE (UGANDA)*",
        `*Order Ref:* ${order.id}`,
        "-----------------------------------",
        ...order.items.map(i => `• ${i.name} — ${DB.ugx(i.line_total)}`),
        "-----------------------------------",
        `*Subtotal (${totalItems} items):* ${DB.ugx(order.subtotal)}`,
        `*Rider Delivery:* ${deliveryFee > 0 ? DB.ugx(deliveryFee) : "Free (Store Pickup)"}`,
        `*TOTAL DUE:* ${DB.ugx(order.total)}`,
        "-----------------------------------",
        `*Delivery Address:* ${deliveryLocStr}`,
        notes ? `*Notes:* ${notes}` : "",
        `*Customer:* ${order.customer_name} (${order.customer_phone})`
      ].filter(Boolean);

      const fullMsg = msgLines.join("\n");
      const waNumber = (DB.getSettings().whatsapp || "256758893398").replace(/[^0-9]/g, "");
      const waUrl = `https://wa.me/${waNumber}?text=${encodeURIComponent(fullMsg)}`;

      orderResult = {
        id: order.id,
        total: order.total,
        waUrl,
        rawMessage: fullMsg
      };

      cart = [];
      saveCart();
      renderCart();
      refreshProducts();
      window.open(waUrl, "_blank");
    } catch (err) {
      toast(err.message || "Something went wrong — please try again");
      refreshProducts();
      renderCart();
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
