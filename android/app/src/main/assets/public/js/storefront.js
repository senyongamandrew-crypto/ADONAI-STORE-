/* ============ Adonai Thrift Store — public storefront logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const CART_KEY = "adonai-cart-v1";
  // Shared presentation kit (grades, measurements, permalinks, WhatsApp,
  // responsive WebP markup) — identical logic on the rail and the PDP.
  const PK = window.AdonaiPDP;
  const displayPrice = p => Number(p && (p.final_selling_price != null ? p.final_selling_price : p.selling_price)) || 0;
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

  /* ---------- store profile & footer (from live System Parameters) ---------- */
  let S = DB.getSettings();

  function renderStoreProfile() {
    S = DB.getSettings();
    const storeName = S.store_name || "Adonai Thrift Store";
    const address = S.address || "Kampala, Uganda";
    const whatsapp = String(S.whatsapp || "256758873398").replace(/\D/g, "");
    const whatsappDisplay = S.whatsapp_display || (whatsapp ? "+" + whatsapp : "");
    const hotline = S.hotline || S.phone || "";
    const email = S.email || "";
    const tiktok = S.tiktok || "";
    const instagram = S.instagram || "";

    $("#footTagline").textContent = S.tagline || "Curated pre-loved vintage";
    $("#footLoc").textContent = address.split(",")[0];
    $("#footContactList").innerHTML = `
      <li><span class="k">WhatsApp:</span> <a class="rust" href="https://wa.me/${esc(whatsapp)}" target="_blank" rel="noopener">${esc(whatsappDisplay)}</a></li>
      <li><span class="k">Hotline:</span> <a href="tel:${esc(hotline.replace(/\s/g, ""))}">${esc(hotline)}</a></li>
      <li><span class="k">Email:</span> <a href="mailto:${esc(email)}">${esc(email)}</a></li>
      <li><span class="k">Location:</span> ${esc(address)}</li>
      <li><span class="k">Hours:</span> ${esc(S.hours || "")}</li>`;
    $("#footSocial").innerHTML = `
      <li><span class="k">TikTok:</span> <a class="rust" href="https://tiktok.com/${esc(tiktok)}" target="_blank" rel="noopener">${esc(tiktok)}</a></li>
      <li><span class="k">Instagram:</span> <a class="rust" href="https://instagram.com/${esc(instagram.replace("@", ""))}" target="_blank" rel="noopener">${esc(instagram)}</a></li>`;

    const trackLink = $("#trackOrderLink");
    if (trackLink) trackLink.href = `https://wa.me/${whatsapp}?text=${encodeURIComponent(`Hello ${storeName}, I would like to track my order`)}`;
    const scope = $("#deliveryScopeText");
    if (scope) scope.textContent = S.delivery_scope || "Delivery available across Uganda";
    const pickupAddress = $("#storePickupAddress");
    if (pickupAddress) pickupAddress.textContent = address;
    const copyright = $("#footCopyright");
    if (copyright) copyright.textContent = `© 2026 ${storeName} · All prices in Ugandan Shillings (UGX)`;
    document.title = `${storeName} | Quality Apparel & Thrift Fashion in Kampala`;
  }

  renderStoreProfile();
  $("#installBtn").addEventListener("click", () => toast("Tip: use your browser's \"Add to Home Screen\" to install Adonai Store app"));
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

  // Deep links from the PDP breadcrumb (/?demo=Women&cat=Dresses%20%26%20Skirts)
  // preselect the rail filters so "Home › Women › Dresses" behaves like a
  // real category page.
  (function applyUrlFilters() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo")) fDemo = params.get("demo");
    if (params.get("cat")) fCat = params.get("cat");
    if (params.get("q")) term = params.get("q").trim().toLowerCase();
  })();

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
  }

  function populateFilterOptions() {
    const avail = products.filter(p => p.in_stock_count > 0);
    const sizes = [...new Set(avail.map(p => p.size))].sort();
    const sizeSel = $("#sizeSel");
    sizeSel.innerHTML = `<option value="All">All Sizes</option>` + sizes.map(s => `<option ${fSize === s ? "selected" : ""} value="${esc(s)}">${esc(s)}</option>`).join("");
    const condSel = $("#condSel");
    condSel.innerHTML = `<option value="All">All Grades</option>` + DB.CONDITIONS.map(c => `<option ${fCond === c ? "selected" : ""} value="${esc(c)}">${esc(c)}</option>`).join("");
    const maxPrice = Math.max(50000, ...products.map(p => displayPrice(p)));
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

  function updateDynamicSEO() {
    const storeName = S.store_name || "Adonai Thrift Store";
    let title = `${storeName} | Quality Apparel & Thrift Fashion in Kampala`;
    if (fCat !== "All" && fDemo !== "All") {
      title = `${fDemo}'s ${fCat} | Curated Vintage | ${storeName} Kampala`;
    } else if (fCat !== "All") {
      title = `Curated Vintage ${fCat} | ${storeName} Kampala`;
    } else if (fDemo !== "All") {
      title = `${fDemo}'s Vintage Fashion | ${storeName} Kampala`;
    }
    document.title = title;
  }

  function matchesSearch(p, query) {
    if (!query) return true;
    const tokens = query.split(/\s+/).filter(Boolean);
    const searchable = [
      p.name, p.brand, p.color, p.category, p.demographic,
      p.sku, p.barcode_id, p.size, p.condition, p.desc
    ].join(" ").toLowerCase();

    return tokens.every(token => {
      if (searchable.includes(token)) return true;
      if (token.length >= 4) {
        const words = searchable.split(/\s+/);
        return words.some(w => levenshteinDist(w.slice(0, token.length + 1), token) <= 1);
      }
      return false;
    });
  }

  function levenshteinDist(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = [];
    for (let i = 0; i <= b.length; i++) m[i] = [i];
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        m[i][j] = b[i - 1] === a[j - 1] ? m[i - 1][j - 1] : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
      }
    }
    return m[b.length][a.length];
  }

  $("#demoChips").addEventListener("click", e => {
    const b = e.target.closest("[data-demo]");
    if (!b) return;
    fDemo = b.dataset.demo;
    renderChips();
    renderGrid();
    updateDynamicSEO();
  });

  $("#catChips").addEventListener("click", e => {
    const b = e.target.closest("[data-catv]");
    if (!b) return;
    fCat = b.dataset.catv;
    renderChips();
    renderGrid();
    updateDynamicSEO();
  });

  $("#sizeSel").addEventListener("change", e => { fSize = e.target.value; renderGrid(); });
  $("#condSel").addEventListener("change", e => { fCond = e.target.value; renderGrid(); });

  let searchDebounceTimer = null;
  $("#shopSearch").addEventListener("input", e => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      term = e.target.value.trim().toLowerCase();
      renderGrid();
      if (window.AdonaiAnalytics && term) {
        const visibleCount = $("#productGrid").children.length;
        window.AdonaiAnalytics.trackSearch(term, visibleCount);
      }
    }, 300);
  });

  $("#priceRange").addEventListener("input", e => {
    fMax = Number(e.target.value);
    $("#priceVal").textContent = DB.ugx(fMax);
    renderGrid();
  });

  /* ---------- verified social proof only ---------- */
  function ratingHTML(p) {
    const reviews = Math.max(0, Number(p.review_count || 0));
    const rating = Number(p.average_rating);
    const sold = Math.max(0, Number(p.sales_count || 0));
    if (reviews > 0 && Number.isFinite(rating) && rating >= 0 && rating <= 5) {
      const filled = Math.round(rating);
      return `
        <div class="star-rating" aria-label="Rated ${rating.toFixed(1)} out of 5 from ${reviews} verified reviews">
          <span class="stars" aria-hidden="true">${"★".repeat(filled)}${"☆".repeat(5 - filled)}</span>
          <span class="rating-num">${rating.toFixed(1)}</span>
          <span class="review-count">(${reviews.toLocaleString()} verified)</span>
        </div>`;
    }
    return sold > 0
      ? `<div class="star-rating" aria-label="${sold} completed sales"><span class="review-count">${sold.toLocaleString()} sold</span></div>`
      : `<div class="star-rating" aria-label="No customer reviews yet"><span class="review-count">New arrival · No reviews yet</span></div>`;
  }

  const discountPercent = p => {
    const original = Number(p.compare_price || 0);
    const selling = Number(displayPrice(p) || 0);
    return original > 0 && selling >= 0 && selling < original
      ? Math.round(((original - selling) / original) * 100)
      : 0;
  };

  /* ---------- product card with multi-angle preview ---------- */
  function mediaHTML(p, photos, disc) {
    const mainImg = photos[0] || p.image_url;
    const img = mainImg
      ? PK.pictureHTML(mainImg, {
          alt: p.name,
          sizes: "(min-width: 1024px) 280px, (min-width: 640px) 45vw, 90vw",
          width: 400,
          height: 500
        })
      : "";
    const dots = photos.length > 1
      ? `<div class="media-dots" title="Open the full photo set">${photos.map((src, i) =>
          `<i class="${i === 0 ? "active" : ""}" data-angle="${i}"><img src="${esc(PK.resolveSrc(src))}" alt="Angle ${i + 1}" width="40" height="40" loading="lazy" decoding="async" /></i>`).join("")}</div>`
      : "";
    const grade = PK.gradeFor(p);
    return `
      <div class="pmedia">
        <span class="grade-badge" style="--grade:${grade.color}">${esc(grade.short)}</span>
        ${disc > 0 ? `<span class="discount-badge">${disc}% OFF</span>` : ""}
        ${img || `<span class="media-icon">${catIcon(p.category)}</span>`}
        ${dots}
      </div>`;
  }

  function cardHTML(p) {
    const sold = p.in_stock_count <= 0;
    const disc = discountPercent(p);
    const photos = getProductImages(p);
    const href = esc(PK.productPath(p));
    return `
    <article class="pcard ${sold ? "sold" : ""}" data-card="${esc(p.id)}">
      <a class="pcard-link" href="${href}" aria-label="View full details, measurements and photos for ${esc(p.name)}">
        ${mediaHTML(p, photos, disc)}
        <div class="pbody">
          <div class="phead-row">
            <span class="pdem">${esc(p.demographic || p.category)}</span>
            <span class="psku">${esc(p.sku || p.id)}</span>
          </div>
          <h3 class="pname">${esc(p.name)}</h3>
          <p class="pmeta">${esc([p.brand, p.size !== "-" ? "Size: " + p.size : "", p.color ? "Color: " + p.color : "", p.condition].filter(Boolean).join(" · "))}</p>
          ${ratingHTML(p)}
          ${PK.hasMeasurements(p) ? `<p class="pmeasure">📏 Exact flat-lay measurements listed</p>` : ""}
          <div class="price-row">
            <span class="pprice">${DB.ugx(displayPrice(p))}</span>
            ${p.compare_price > displayPrice(p) ? `<span class="pcompare">${DB.ugx(p.compare_price)}</span>` : ""}
          </div>
        </div>
      </a>
      <div class="pcard-actions">
        <button class="add-cart-btn" data-add="${esc(p.id)}" ${sold ? "disabled" : ""} type="button" aria-label="Add ${esc(p.name)} to cart">
          ${sold ? "● Sold Out" : `
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
            Add to Cart
          `}
        </button>
        <a class="view-detail-btn" href="${href}">Details &amp; measurements</a>
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
      .filter(p => displayPrice(p) <= fMax)
      .filter(p => matchesSearch(p, term))
      .sort((a, b) => (b.in_stock_count > 0) - (a.in_stock_count > 0));
    $("#gridEmpty").hidden = list.length > 0;
    grid.innerHTML = list.map(cardHTML).join("");
    if (window.AdonaiAnalytics && list.length > 0) {
      window.AdonaiAnalytics.trackViewItemList(list, fCat !== "All" ? fCat : (fDemo !== "All" ? fDemo : "All"));
    }
  }

  $("#productGrid").addEventListener("click", e => {
    const addBtn = e.target.closest("[data-add]");
    if (addBtn) {
      e.stopPropagation();
      return addToCart(addBtn.dataset.add);
    }
    const angleDot = e.target.closest("[data-angle]");
    if (angleDot) {
      e.preventDefault();
      e.stopPropagation();
      const card = e.target.closest("[data-card]");
      if (card) return openProductPage(card.dataset.card, Number(angleDot.dataset.angle));
    }
    // Cards are real <a> links to /product/<slug>: let the browser navigate
    // (so middle-click, long-press and "open in new tab" all keep working)
    // and only record the analytics event here.
    const card = e.target.closest("[data-card]");
    if (card && window.AdonaiAnalytics) {
      const p = products.find(x => x.id === card.dataset.card);
      if (p) window.AdonaiAnalytics.trackViewItem(p);
    }
  });

  /* ============================================================
     PRODUCT DETAIL PAGE NAVIGATION
     The full specification experience (flat-lay measurements, flaw
     disclosure, delivery estimator, WhatsApp ordering) lives on the
     dedicated, shareable PDP at /product/<slug>, so a rail card deep
     links straight into it instead of opening a partial quick-view.
     ============================================================ */
  function openProductPage(id, photoIndex) {
    const p = products.find(x => x.id === id) || DB.getProduct(id);
    if (!p) return;
    if (window.AdonaiAnalytics) window.AdonaiAnalytics.trackViewItem(p);
    const suffix = Number(photoIndex) > 0 ? `?photo=${Number(photoIndex)}` : "";
    window.location.href = PK.productPath(p) + suffix;
  }

  function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p || p.in_stock_count <= 0) return toast("That piece has already been claimed");
    const line = cart.find(l => l.product_id === id);
    if ((line ? line.qty : 0) + 1 > p.in_stock_count) return toast(`Only ${p.in_stock_count} in stock`);
    if (line) line.qty++; else cart.push({ product_id: id, qty: 1 });
    saveCart(); renderCart();
    toast(`${p.name} added to your cart`);
    if (window.AdonaiAnalytics) {
      window.AdonaiAnalytics.trackAddToCart(p, 1);
    }
    openCart();
  }

  /* ---------- cart drawer ---------- */
  function buildDeliveryAreas() {
    const base = Math.max(0, Number(S.base_delivery_fee != null ? S.base_delivery_fee : S.boda_base_fee) || 7000);
    return [
      { name: "Kampala Central / Nakasero", fee: base, lat: 0.3476, lng: 32.5825, radiusKm: 7 },
      { name: "Kololo / Kamwokya / Bukoto", fee: base, lat: 0.3500, lng: 32.5950, radiusKm: 6 },
      { name: "Ntinda / Naguru / Kiwatule", fee: base, lat: 0.3650, lng: 32.6160, radiusKm: 8 },
      { name: "Bugolobi / Mbuya / Mutungo", fee: base, lat: 0.3180, lng: 32.6280, radiusKm: 8 },
      { name: "Muyenga / Kansanga / Ggaba", fee: base, lat: 0.2740, lng: 32.6160, radiusKm: 11 },
      { name: "Kibuli / Nsambya / Makindye", fee: base, lat: 0.3000, lng: 32.5880, radiusKm: 9 },
      { name: "Rubaga / Mengo / Namirembe", fee: base, lat: 0.3070, lng: 32.5520, radiusKm: 9 },
      { name: "Bwaise / Kawempe / Kisaasi", fee: base, lat: 0.3890, lng: 32.5750, radiusKm: 11 },
      { name: "Entebbe Road & Corridor", fee: base + 5000, lat: 0.1400, lng: 32.5000, radiusKm: 25 },
      { name: "Mukono / Seeta Corridor", fee: base + 5000, lat: 0.3530, lng: 32.7550, radiusKm: 22 },
      { name: "Upcountry Express Parcel (Jinja, Mbarara, Mbale)", fee: base + 8000 }
    ];
  }

  let DELIVERY_AREAS = buildDeliveryAreas();

  let deliveryType = "boda"; // 'boda' | 'pickup'
  let selectedAreaIndex = 0;
  let formState = {
    name: "",
    phone: "",
    address: "",
    dropoff: "",
    notes: "",
    detectedLocation: null,
    locationPricingReviewed: false,
    locationStatus: "Location will be detected when you confirm the order."
  };

  function distanceKm(lat1, lng1, lat2, lng2) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function allocateDetectedArea(latitude, longitude, accuracy) {
    DELIVERY_AREAS = DELIVERY_AREAS.filter(area => !area.detected);
    let nearest = null;
    DELIVERY_AREAS.forEach((area, index) => {
      if (!Number.isFinite(area.lat) || !Number.isFinite(area.lng)) return;
      const distance = distanceKm(latitude, longitude, area.lat, area.lng);
      if (!nearest || distance < nearest.distance) nearest = { area, index, distance };
    });
    const matched = nearest && nearest.distance <= nearest.area.radiusKm;
    if (matched) {
      selectedAreaIndex = nearest.index;
    } else {
      const fallbackFee = DELIVERY_AREAS[DELIVERY_AREAS.length - 1].fee;
      DELIVERY_AREAS.push({
        name: `Detected current location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`,
        fee: fallbackFee,
        detected: true
      });
      selectedAreaIndex = DELIVERY_AREAS.length - 1;
    }
    const allocatedArea = DELIVERY_AREAS[selectedAreaIndex];
    formState.detectedLocation = {
      latitude, longitude, accuracy: Math.round(Number(accuracy) || 0),
      area: allocatedArea.name,
      map_url: `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`
    };
    formState.locationStatus = `Current location allocated to ${allocatedArea.name}${matched ? "" : " (outside listed Kampala zones)"}.`;
  }

  function detectCurrentLocation() {
    if (deliveryType !== "boda") return Promise.resolve(null);
    if (formState.detectedLocation) return Promise.resolve(formState.detectedLocation);
    if (!navigator.geolocation) {
      formState.locationStatus = "Automatic location is unavailable in this browser; your selected area will be used.";
      return Promise.resolve(null);
    }
    formState.locationStatus = "Detecting your current location…";
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(position => {
        allocateDetectedArea(position.coords.latitude, position.coords.longitude, position.coords.accuracy);
        resolve(formState.detectedLocation);
      }, error => {
        formState.detectedLocation = null;
        formState.locationStatus = error && error.code === 1
          ? "Location permission was not granted; your selected destination area will be used."
          : "Current location could not be detected; your selected destination area will be used.";
        resolve(null);
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }

  /* ---- cart drawer state ----
     ONE source of truth, shared with js/cartController.js (which binds the
     same buttons for the scroll-lock contract). Every open/close path —
     addToCart, the header Cart button, ✕ Close, backdrop tap, Escape and
     the post-order "Continue Browsing" button — must toggle the SAME class
     set, otherwise the body scroll lock (cart-drawer-open) gets stuck and
     the page can no longer scroll or be navigated. */
  function openCart() {
    document.body.classList.add("cart-open");
    document.body.classList.remove("cart-drawer-closed");
    document.body.classList.add("cart-drawer-open");        // lock page scroll behind the drawer
    const drawer = document.getElementById("cartDrawer");
    if (drawer) drawer.classList.add("is-active");
    const backdrop = document.getElementById("cartBackdrop");
    if (backdrop) backdrop.classList.add("is-active");
    if (window.AdonaiAnalytics && cart.length > 0) {
      const lines = cartLines();
      const total = lines.reduce((s, x) => s + x.sub, 0);
      window.AdonaiAnalytics.trackBeginCheckout(lines.map(x => x.p), total);
    }
  }
  function closeCart() {
    document.body.classList.remove("cart-open", "cart-drawer-open");
    document.body.classList.add("cart-drawer-closed");      // explicit unlock (touch-action)
    const drawer = document.getElementById("cartDrawer");
    if (drawer) drawer.classList.remove("is-active");
    const backdrop = document.getElementById("cartBackdrop");
    if (backdrop) backdrop.classList.remove("is-active");
  }
  $("#cartBtn").addEventListener("click", openCart);
  $("#closeCart").addEventListener("click", closeCart);
  $("#cartBackdrop").addEventListener("click", closeCart);

  function cartLines() {
    return cart.map(l => {
      const p = products.find(x => x.id === l.product_id);
      const price = displayPrice(p);
      return p ? { line: l, p, price, sub: price * l.qty } : null;
    }).filter(Boolean);
  }

  function cartCheckoutTransport(lines) {
    return lines.reduce((sum, x) => sum + (Number(x.p.checkout_transport_portion) || 0) * x.line.qty, 0);
  }

  function renderCart() {
    const lines = cartLines();
    const itemCount = lines.reduce((s, x) => s + x.line.qty, 0);
    const subtotal = lines.reduce((s, x) => s + x.sub, 0);
    const currentDeliveryFee = deliveryType === "pickup" ? 0 : cartCheckoutTransport(lines);
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

          <p class="wa-instruct"><strong>Status: Unfulfilled</strong><br />Your order has synced directly to our POS fulfillment dashboard. Our team will contact the phone number you supplied with confirmation and status updates.</p>
        </div>`;
      $("#cartFoot").innerHTML = `
        <button class="claim-confirm-btn" id="keepShopping">Continue Browsing Catalog</button>`;
      $("#keepShopping").addEventListener("click", () => { orderResult = null; renderCart(); closeCart(); });
      return;
    }

    if (!lines.length) {
      $("#cartBody").innerHTML = `<p class="empty">Your cart is empty.<br/>Have a look at today's rail.</p>`;
      $("#cartFoot").innerHTML = "";
      return;
    }

    $("#cartBody").innerHTML = `
      ${lines.map(({ line, p, price, sub }) => `
        <div class="cart-line-card">
          <span class="line-thumb">${catIcon(p.category)}${p.image_url ? `<img src="${esc(p.image_url)}" alt="" width="48" height="48" onerror="this.remove()" />` : ""}</span>
          <div class="line-details">
            <div class="line-title">${esc(p.name)}</div>
            <div class="line-sku">${esc(p.sku || p.barcode_id || p.id)}</div>
            <div class="line-price-meta">Size: ${esc(p.size && p.size !== "-" ? p.size : "Standard")} · ${DB.ugx(price)}</div>
          </div>
          <button class="line-remove-btn" data-rm="${esc(p.id)}" aria-label="Remove item">✕</button>
        </div>`).join("")}

      <div class="claim-form">
        <!-- Anti-Spam Bot Trap (Honeypot) -->
        <div style="display:none !important; position:absolute; left:-9999px;">
          <input type="text" id="hp_company" name="hp_company" tabindex="-1" autocomplete="off" />
          <input type="text" id="hp_website" name="hp_website" tabindex="-1" autocomplete="off" />
        </div>

        <input class="claim-input" id="coName" placeholder="Your Full Name *" autocomplete="name" value="${esc(formState.name)}" required />
        <input class="claim-input" id="coPhone" placeholder="Phone Number (e.g. 0758873398) *" autocomplete="tel" value="${esc(formState.phone)}" required />

        <div class="delivery-toggle-row">
          <button type="button" class="deliv-toggle-btn ${deliveryType === 'boda' ? 'active' : ''}" id="btnDelivBoda">Boda Delivery</button>
          <button type="button" class="deliv-toggle-btn ${deliveryType === 'pickup' ? 'active' : ''}" id="btnDelivPickup">Store Pickup (Free)</button>
        </div>

        <div id="bodaDeliveryBox" ${deliveryType === 'pickup' ? 'style="display:none"' : ''}>
          <label class="claim-field-label">Destination Area:</label>
          <select class="claim-select" id="coArea">
            ${DELIVERY_AREAS.map((a, idx) => `<option value="${idx}" ${idx === selectedAreaIndex ? 'selected' : ''}>${esc(a.name)}</option>`).join("")}
          </select>
          <p class="location-allocation-status" id="locationAllocationStatus" aria-live="polite">📍 ${esc(formState.locationStatus)}</p>
          <input class="claim-input" id="coAddress" placeholder="Street, Building, Flat or Landmark Details *" value="${esc(formState.address)}" />
          <label class="claim-field-label" for="coDropoff">Exact drop-off override (optional):</label>
          <input class="claim-input" id="coDropoff" placeholder="Put the exact dropoff point if you are not there at the present moment" value="${esc(formState.dropoff)}" />
        </div>

        <textarea class="claim-textarea" id="coNotes" placeholder="Delivery notes or sizing question (optional)..." rows="2">${esc(formState.notes)}</textarea>
      </div>
    `;

    $("#cartFoot").innerHTML = `
      <div class="claim-summary-box">
        <div class="sum-line"><span>Items (${itemCount}):</span><span>${DB.ugx(subtotal)}</span></div>
        <div class="sum-line"><span>Allocated delivery (50% transport):</span><span>${currentDeliveryFee > 0 ? DB.ugx(currentDeliveryFee) : "Free"}</span></div>
        <div class="sum-line total"><strong>Total:</strong><strong class="rust">${DB.ugx(grandTotal)}</strong></div>
      </div>
      <button class="claim-confirm-btn" id="confirmOrder">Confirm order (${DB.ugx(grandTotal)})</button>
      <p class="claim-notice-sub">Returns or exchanges honored within 2 days with valid receipt.</p>
    `;

    // Bind form inputs
    const elName = $("#coName"), elPhone = $("#coPhone"), elAddr = $("#coAddress"), elDropoff = $("#coDropoff"), elNotes = $("#coNotes"), elArea = $("#coArea");
    if (elName) elName.addEventListener("input", e => { formState.name = e.target.value; });
    if (elPhone) elPhone.addEventListener("input", e => { formState.phone = e.target.value; });
    if (elAddr) elAddr.addEventListener("input", e => { formState.address = e.target.value; });
    if (elDropoff) elDropoff.addEventListener("input", e => { formState.dropoff = e.target.value; });
    if (elNotes) elNotes.addEventListener("input", e => { formState.notes = e.target.value; });
    if (elArea) elArea.addEventListener("change", e => {
      selectedAreaIndex = Number(e.target.value);
      formState.detectedLocation = null;
      formState.locationPricingReviewed = false;
      formState.locationStatus = "Selected destination saved. Your current location will be allocated when you confirm.";
      renderCart();
    });

    const btnBoda = $("#btnDelivBoda"), btnPickup = $("#btnDelivPickup");
    if (btnBoda) btnBoda.addEventListener("click", () => { deliveryType = "boda"; renderCart(); });
    if (btnPickup) btnPickup.addEventListener("click", () => { deliveryType = "pickup"; renderCart(); });

    const confirmButton = $("#confirmOrder");
    if (confirmButton) confirmButton.addEventListener("click", checkout);
  }

  $("#cartBody").addEventListener("click", e => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      const p = products.find(x => x.id === rm.dataset.rm);
      cart = cart.filter(x => x.product_id !== rm.dataset.rm);
      saveCart();
      renderCart();
      if (p && window.AdonaiAnalytics) {
        window.AdonaiAnalytics.trackRemoveFromCart(p);
      }
    }
  });

  /* ---------- direct storefront checkout ---------- */
  async function checkout() {
    const btn = $("#confirmOrder");
    const hpCompany = $("#hp_company") ? $("#hp_company").value.trim() : "";
    const hpWebsite = $("#hp_website") ? $("#hp_website").value.trim() : "";
    if (hpCompany || hpWebsite) {
      console.warn("[AntiSpam] Bot submission trapped");
      return;
    }

    const name = formState.name.trim();
    const phone = formState.phone.trim();
    const address = formState.address.trim();
    const dropoff = formState.dropoff.trim();
    const notes = formState.notes.trim();

    if (!name || name.length < 2) {
      toast("Please enter your full name");
      const el = $("#coName"); if (el) el.focus();
      return;
    }
    if (!phone || phone.length < 7) {
      toast("Please enter your phone number");
      const el = $("#coPhone"); if (el) el.focus();
      return;
    }
    if (deliveryType === "boda" && !address && !dropoff) {
      toast("Please enter your landmark or exact drop-off point");
      const el = $("#coAddress"); if (el) el.focus();
      return;
    }
    if (cart.length === 0) return;

    btn.disabled = true;
    btn.textContent = deliveryType === "boda" ? "Detecting your location…" : "Confirming your order…";

    try {
      // Geolocation is requested only after the customer actively confirms.
      // Permission denial never blocks checkout; the selected area remains the fallback.
      const previousAreaIndex = selectedAreaIndex;
      const previousArea = DELIVERY_AREAS[previousAreaIndex] || DELIVERY_AREAS[0];
      await detectCurrentLocation();
      const areaObj = DELIVERY_AREAS[selectedAreaIndex] || DELIVERY_AREAS[0];
      if (formState.detectedLocation && !formState.locationPricingReviewed &&
          (previousAreaIndex !== selectedAreaIndex || previousArea.fee !== areaObj.fee)) {
        formState.locationPricingReviewed = true;
        renderCart();
        toast("Location allocated. Please review the updated delivery total and confirm again.");
        return;
      }
      const deliveryFee = deliveryType === "pickup" ? 0 : cartCheckoutTransport(cartLines());
      const pickupAddress = S.address || "Kampala, Uganda";
      const areaName = deliveryType === "pickup" ? `Store Pickup (${pickupAddress})` : areaObj.name;
      const deliveryAddress = dropoff || address;
      const locationAudit = formState.detectedLocation
        ? `Ordering GPS: ${formState.detectedLocation.latitude.toFixed(6)}, ${formState.detectedLocation.longitude.toFixed(6)} (±${formState.detectedLocation.accuracy}m) · ${formState.detectedLocation.map_url}`
        : "";
      const overrideAudit = dropoff
        ? [address ? `Customer-entered location: ${address}` : "", `Exact drop-off override: ${dropoff}`].filter(Boolean).join(" · ")
        : "";
      const deliveryNotes = [notes, overrideAudit, locationAudit].filter(Boolean).join(" | ");
      btn.textContent = "Reserving your pieces…";

      const order = await DB.createWebOrder({
        customer_name: name,
        customer_phone: phone,
        delivery_type: deliveryType,
        delivery_area: areaName,
        delivery_address: deliveryAddress,
        delivery_fee: deliveryFee,
        delivery_notes: deliveryNotes,
        items: cart.map(l => ({ product_id: l.product_id, qty: l.qty }))
      });

      if (window.AdonaiAnalytics) {
        window.AdonaiAnalytics.trackWebPurchase(order);
      }

      orderResult = {
        id: order.id,
        total: order.total,
        status: order.dispatch_status || "Unfulfilled"
      };

      cart = [];
      saveCart();
      renderCart();
      refreshProducts();
    } catch (err) {
      toast(err.message || "Something went wrong — please try again");
      refreshProducts();
      renderCart();
    }
  }

  /* ---------- real-time stock & System Parameters sync ---------- */
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

  DB.on("settings", () => {
    renderStoreProfile();
    DELIVERY_AREAS = buildDeliveryAreas();
    if (selectedAreaIndex >= DELIVERY_AREAS.length) selectedAreaIndex = 0;
    renderCart();
    renderGrid();
    updateDynamicSEO();
  });

  /* ---------- boot ---------- */
  refreshProducts();
  renderCart();

  // "Checkout now" from a Product Detail Page lands on /?cart=1 — open the
  // bag drawer straight away so the shopper keeps their momentum.
  (function openCartFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("cart") === "1" || window.location.hash === "#cart") {
      openCart();
      history.replaceState(null, "", window.location.pathname);
    }
  })();
})();
