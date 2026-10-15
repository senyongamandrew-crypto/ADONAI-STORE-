  /* ============ Adonai Store — unified storefront logic ============ */
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
  ICONS["Boots"] = ICONS.Shoes;
  ICONS["Sandals"] = ICONS.Shoes;
  ICONS["Activewear & Sportswear"] = ICONS["Tops & Shirts"];
  ICONS["Suits & Formalwear"] = ICONS["Outerwear & Jackets"];
  ICONS["Underwear & Sleepwear"] = ICONS["Tops & Shirts"];
  ICONS["Bags & Handbags"] = ICONS.Accessories;
  ICONS["Necklaces & Chains"] = svg(`<path d="M4 4c1 7 4 12 8 16 4-4 7-9 8-16"/><circle cx="12" cy="17" r="2"/>`);
  ICONS["Bracelets & Bangles"] = svg(`<ellipse cx="12" cy="12" rx="8" ry="10"/><ellipse cx="12" cy="12" rx="5.5" ry="8"/>`);
  ICONS["Rings & Earrings"] = svg(`<circle cx="9" cy="13" r="5"/><circle cx="17" cy="8" r="2.5"/><path d="M17 10.5v4"/>`);
  ICONS["Watches"] = svg(`<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 2h6M9 22h6M12 9v3l2 1"/>`);
  ICONS["Eyewear & Sunglasses"] = svg(`<path d="M3 7h2l2 9h3l2-6 2 6h3l2-9h2"/><path d="M7 8h4m2 0h4"/>`);
  ICONS["Hats, Scarves & Belts"] = ICONS.Accessories;
  ICONS["Traditional & Occasionwear"] = ICONS["Dresses & Skirts"];
  ICONS["Swimwear & Beachwear"] = ICONS["Tops & Shirts"];
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
    const storeName = S.store_name || "Adonai Store";
    const address = S.address || "Kampala, Uganda";
    const whatsapp = String(S.whatsapp || "256758873398").replace(/\D/g, "");
    const whatsappDisplay = S.whatsapp_display || (whatsapp ? "+" + whatsapp : "");
    const hotline = S.hotline || S.phone || "";
    const email = PK.storeEmail(S);
    const tiktok = S.tiktok || "";
    const instagram = S.instagram || "";

    $("#footTagline").textContent = S.tagline || "Brand-new apparel + curated vintage pieces";
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
    if (scope) scope.textContent = S.delivery_scope || "Adonai-managed delivery available across Uganda — from order confirmation to customer handoff.";
    const pickupAddress = $("#storePickupAddress");
    if (pickupAddress) pickupAddress.textContent = address;
    const copyright = $("#footCopyright");
    if (copyright) copyright.textContent = `© 2026 ${storeName} · All prices in Ugandan Shillings (UGX)`;
    document.title = `${storeName} — Brand-New & Curated Vintage Fashion`;
  }

  renderStoreProfile();
  $("#installBtn").addEventListener("click", () => toast("Tip: use your browser's \"Add to Home Screen\" to install Adonai Store app"));

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
  const WEB_LOCK_KEY = "adonai-web-reservation-owner-v1";
  let webLockOwner = "";
  try {
    webLockOwner = localStorage.getItem(WEB_LOCK_KEY) || "";
    if (!/^WEB-[A-Z0-9-]{8,}$/i.test(webLockOwner)) {
      webLockOwner = `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      localStorage.setItem(WEB_LOCK_KEY, webLockOwner);
    }
  } catch (e) {
    webLockOwner = `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  }
  window.__ADONAI_WEB_LOCK_OWNER__ = webLockOwner;
  const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(cart));
  let orderResult = null;

  /* ---------- payment state ----------
     paymentMethod is the channel the shopper picked:
       'cod'      — pay the rider / at the counter on handoff (no prepayment)
       'card'     — Flutterwave popup, settled by the gateway
       'momo'     — approve the prompt on the paying phone (gateway), or send
                    mobile money to the store merchant line and then submit
                    the transaction id; staff confirm and the order clears
       'bank'     — pay into the store bank account, submit the reference
       'merchant' — the system issues a merchant PAY CODE that the shopper (or
                    whoever is paying for them) settles at a merchant point
     Every non-cash channel reserves the pieces for the window the server
     announces, so a one-of-one piece cannot be double-sold. */
  const PENDING_PAYMENT_KEY = "adonai-pending-payment-v1";
  let paymentConfig = {
    enabled: false, provider: "flutterwave", currency: "UGX",
    payment_window_minutes: 30, offline_window_minutes: 180,
    channels: [], methods: ["cod"], pay_to: {}
  };
  let paymentMethod = "cod";
  let paymentBusy = false;
  let payerAccount = "";            // number/account the shopper will pay from
  let paymentDrafts = { reference: "", account: "" };
  let paymentFlash = "";            // short inline message inside the pay step

  function channelInfo(id) {
    return (paymentConfig.channels || []).find(c => c.id === id) || null;
  }
  function channelAvailable(id) {
    const info = channelInfo(id);
    return !!info && info.available !== false;
  }
  /* Only ever allow a channel the server currently offers, so a stale cached
     page cannot park an order on a payment route the store cannot honour. */
  function setPaymentMethod(method) {
    const next = String(method || "").trim();
    paymentMethod = channelAvailable(next) ? next : "cod";
    paymentFlash = "";
    renderCart();
  }

  /* ---------- filter state ---------- */
  let products = [];
  let fDemo = "All", fCat = "All", fSize = "All", fCond = "All", fInventory = "All", fMax = 200000, term = "";
  /* Compact catalog (<1100px) keeps the filter panel behind one button.
     Must stay in sync with the @media (max-width: 1100px) block in
     css/storefront.css (v3.12). */
  const FILTER_PANEL_MAX = 1100;
  let filtersOpen = false;

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

  /* ---------- live promotional rail ----------
     Offers and featured pieces are drawn from the real available catalog.
     If the catalog is intentionally empty, the strip falls back to Adonai's
     existing brand image and live store tagline — never a fake deal/product. */
  const PROMO_MAX_PRODUCTS = 12;
  let promoResizeTimer = 0;

  function availablePromotionItems(list) {
    return (Array.isArray(list) ? list : []).map(product => {
      const current = displayPrice(product);
      const compare = Number(product && product.compare_price) || 0;
      const stock = Math.max(0, Number(product && product.in_stock_count) || 0);
      if (!product || stock <= 0 || current <= 0) return null;
      const discounted = compare > current;
      return {
        product,
        current,
        compare: discounted ? compare : 0,
        percent: discounted ? Math.round(((compare - current) / compare) * 100) : 0,
        image: getProductImages(product)[0] || ""
      };
    }).filter(Boolean).slice(0, PROMO_MAX_PRODUCTS);
  }

  function promotionalOffers(list) {
    return availablePromotionItems(list).filter(item => item.percent > 0)
      .sort((a, b) => b.percent - a.percent || String(a.product.name || "").localeCompare(String(b.product.name || ""), "en"));
  }

  function featuredPromotions(list) {
    return availablePromotionItems(list);
  }

  function promotionalSelection() {
    const raw = String(S.storefront_promo_ids || "auto").trim();
    if (!raw || raw.toLowerCase() === "auto") return { mode: "auto", ids: [], items: [] };
    if (raw.toLowerCase() === "none") return { mode: "none", ids: [], items: [] };
    try {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) {
        return { mode: "selected", ids: [...new Set(saved.filter(id => typeof id === "string").map(id => id.trim()).filter(Boolean))].slice(0, 8), items: [] };
      }
      if (saved && saved.mode === "custom" && Array.isArray(saved.items)) {
        const items = saved.items.filter(item => item && /^[a-f0-9]{32}$/i.test(String(item.media_id || "")))
          .slice(0, 8).map(item => {
            const type = item.type === "html" ? "html" : "image";
            return {
              media_id: String(item.media_id).toLowerCase(),
              type,
              width: type === "html" ? Math.max(1, Math.min(2000, Number(item.width) || 728)) : 0,
              height: type === "html" ? Math.max(1, Math.min(1200, Number(item.height) || 90)) : 0,
              alt_text: String(item.alt_text || "").slice(0, 120)
            };
          });
        if (items.length) return { mode: "custom", ids: [], items };
      }
    } catch (error) { /* Invalid saved config safely falls back to automatic mode. */ }
    return { mode: "auto", ids: [], items: [] };
  }

  function promotionalCardHTML(offer, decorativeCopy) {
    const p = offer.product;
    const isDiscount = offer.percent > 0;
    const copyAccessibility = decorativeCopy ? ' aria-hidden="true" inert tabindex="-1"' : "";
    const image = offer.image
      ? PK.pictureHTML(offer.image, {
          alt: "",
          className: "promo-card-img",
          sizes: "(min-width: 640px) 280px, 78vw",
          width: 560,
          height: 180
        })
      : `<span class="promo-image-fallback" aria-hidden="true">${catIcon(p.category)}</span>`;
    const current = DB.ugx(offer.current);
    const compare = DB.ugx(offer.compare);
    const label = isDiscount
      ? `Shop ${esc(p.name)}: ${offer.percent}% off, now ${esc(current)}`
      : `Shop ${esc(p.name)}, currently available for ${esc(current)}`;
    return `
      <a class="promo-card" href="${esc(PK.productPath(p))}"${copyAccessibility}
         aria-label="${label}">
        <span class="promo-card-media">
          ${image}
          ${isDiscount ? `<span class="promo-card-discount">${offer.percent}% OFF</span>` : ""}
          <span class="promo-card-prices">${isDiscount ? `<s>${esc(compare)}</s>` : ""}<b>${esc(current)}</b></span>
        </span>
      </a>`;
  }

  /* Brand fallback — used when no live offer qualifies (an empty rail, or
     saved promo picks that have since sold). Per the storefront promotion
     contract this strip carries no invented copy: it is the store's own
     artwork and nothing else. It does have to LOOK deliberate, so
     css/storefront.css (v3.12) frames each tile and steps the crop across
     the frame — the same photo cropped dead-centre into four identical
     280x74 bands is what read as four broken images on a phone. */
  function brandPromotionCardHTML(decorativeCopy) {
    const copyAccessibility = decorativeCopy ? ' aria-hidden="true" inert tabindex="-1"' : "";
    const image = PK.pictureHTML("assets/storefront-editorial-bg.jpg", {
      alt: "",
      className: "promo-card-img",
      sizes: "(min-width: 640px) 280px, 78vw",
      width: 560,
      height: 180
    });
    return `<a class="promo-card promo-card--brand" href="#catalogDashboardRegion"${copyAccessibility} aria-label="Adonai Store editorial image"><span class="promo-card-media">${image}</span></a>`;
  }

  function customPromotionCardHTML(item, decorativeCopy) {
    const copyAccessibility = decorativeCopy ? ' aria-hidden="true" inert tabindex="-1"' : "";
    const mediaId = String(item && item.media_id || "");
    const creativeType = item && item.type === "html" ? "html" : "image";
    const endpoint = creativeType === "html" ? "/api/promo-media/" : "/api/media/";
    const src = typeof DB.apiUrl === "function" ? DB.apiUrl(`${endpoint}${mediaId}`) : `${endpoint}${mediaId}`;
    const alt = String(item && item.alt_text || "").trim().slice(0, 120);
    const label = alt ? `Storefront artwork: ${alt}` : "View the Adonai Store collection";
    if (creativeType === "html") {
      const width = Math.max(1, Math.min(2000, Number(item.width) || 728));
      const height = Math.max(1, Math.min(1200, Number(item.height) || 90));
      const maxWidth = Math.min(728, Math.max(180, (Number(window.innerWidth) || 320) - 70));
      const scale = Math.min(1, maxWidth / width, 90 / height);
      const displayWidth = Math.max(1, Math.round(width * scale));
      const displayHeight = Math.max(1, Math.round(height * scale));
      const sizeStyle = `--promo-html-frame-width:${width}px;--promo-html-frame-height:${height}px;--promo-html-scale:${scale};--promo-html-display-width:${displayWidth}px;--promo-html-display-height:${displayHeight}px`;
      const frame = `<span class="promo-html-viewport"><iframe src="${esc(src)}" title="" width="${width}" height="${height}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" tabindex="-1" aria-hidden="true"></iframe></span>`;
      return `<a class="promo-card promo-card--custom promo-card--html" href="#catalogDashboardRegion" style="${sizeStyle}"${copyAccessibility} aria-label="${esc(label)}"><span class="promo-card-media">${frame}</span></a>`;
    }
    return `<a class="promo-card promo-card--custom" href="#catalogDashboardRegion"${copyAccessibility} aria-label="${esc(label)}"><span class="promo-card-media"><img src="${esc(src)}" alt="${esc(alt)}" class="promo-card-img" loading="lazy" decoding="async" width="560" height="180"></span></a>`;
  }

  function renderPromotionalRail() {
    const rail = $("#promoRail"), track = $("#promoTrack");
    if (!rail || !track) return;

    const selection = promotionalSelection();
    if (selection.mode === "none") {
      rail.hidden = true;
      track.innerHTML = "";
      track.classList.remove("is-static");
      return;
    }

    let offers = [], featured = [], brandFallback = false;
    const customMode = selection.mode === "custom";
    const customItems = customMode ? selection.items : [];
    if (customMode) {
      if (!customItems.length) {
        rail.hidden = true;
        track.innerHTML = "";
        track.classList.remove("is-static");
        return;
      }
    } else if (selection.mode === "selected") {
      const selectedProducts = selection.ids.map(id => products.find(product => String(product.id) === id)).filter(Boolean);
      featured = availablePromotionItems(selectedProducts);
      if (!featured.length) {
        // Preserve the visible strip on an empty catalog or when every saved
        // pick is temporarily unavailable; never substitute a dummy product.
        brandFallback = true;
      } else {
        offers = featured.filter(item => item.percent > 0);
      }
    } else {
      offers = promotionalOffers(products);
      featured = offers.length ? offers : featuredPromotions(products);
      brandFallback = featured.length === 0;
    }

    const oneHtmlCreative = customMode && customItems.length === 1 && customItems[0].type === "html";
    const oneCard = (!customMode && !brandFallback && featured.length === 1) || oneHtmlCreative;
    const hasHtmlCreative = customMode && customItems.some(item => item.type === "html");
    rail.hidden = false;

    const viewportWidth = Math.max(320, Number(window.innerWidth) || 1024);
    const cardEstimate = viewportWidth < 640 ? 300 : 406;
    const targetWidth = viewportWidth + cardEstimate;
    const widthPerCard = cardEstimate + 14;
    const cardCount = brandFallback ? 1 : customMode ? customItems.length : featured.length;
    // Repeating HTML frames would execute third-party scripts and inflate
    // impressions. Keep one item sequence per rich-creative marquee pass; a
    // single HTML creative stays static, while image-only strips retain their
    // fully repeated seamless loop.
    const repeatCount = oneCard ? 1 : hasHtmlCreative ? 1 : Math.min(8, Math.max(1,
      Math.ceil(targetWidth / (cardCount * widthPerCard))));
    const repeatedItems = brandFallback
      ? Array.from({ length: repeatCount }, (_, index) => index)
      : customMode
        ? Array.from({ length: customItems.length * repeatCount }, (_, index) => customItems[index % customItems.length])
        : Array.from({ length: featured.length * repeatCount }, (_, index) => featured[index % featured.length]);
    const cards = brandFallback
      ? repeatedItems.map((_, index) => brandPromotionCardHTML(index > 0)).join("")
      : customMode
        ? repeatedItems.map((item, index) => customPromotionCardHTML(item, index >= customItems.length)).join("")
        : repeatedItems.map((offer, index) => promotionalCardHTML(offer, index >= featured.length)).join("");

    track.classList.toggle("is-static", oneCard);
    track.innerHTML = `<div class="promo-set">${cards}</div>` + (oneCard ? "" :
      `<div class="promo-set promo-set--clone" aria-hidden="true" inert>${cards}</div>`);

    /* Uploaded artwork whose bytes are gone must not render as an empty grey
       tile — a shopper reads that as a broken shop. It degrades to the same
       icon placeholder the product tiles use for a missing photo: no
       invented copy, still one tap away from the rail. */
    Array.from(track.querySelectorAll(".promo-card--custom img")).forEach(img => {
      const degrade = () => {
        const media = img.closest(".promo-card-media");
        if (!media || media.dataset.degraded === "1") return;
        media.dataset.degraded = "1";
        img.remove();
        const placeholder = document.createElement("span");
        placeholder.className = "promo-image-fallback";
        placeholder.setAttribute("aria-hidden", "true");
        placeholder.innerHTML = catIcon("tag");
        media.appendChild(placeholder);
      };
      if (img.complete && img.naturalWidth === 0) degrade();
      else img.addEventListener("error", degrade, { once: true });
    });

    if (!oneCard) {
      const setDuration = () => {
        const firstSet = track.querySelector(".promo-set");
        if (!firstSet || !track.isConnected) return;
        const seconds = Math.max(24, Math.min(100, firstSet.scrollWidth / 46));
        track.style.setProperty("--promo-duration", `${seconds.toFixed(1)}s`);
      };
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(setDuration);
      else setTimeout(setDuration, 0);
    }
  }

  window.addEventListener("resize", () => {
    clearTimeout(promoResizeTimer);
    promoResizeTimer = setTimeout(renderPromotionalRail, 160);
  }, { passive: true });

  function refreshProducts() {
    products = DB.listProducts();
    renderPromotionalRail();
    let changed = false;
    cart = cart.reduce((acc, l) => {
      const p = products.find(x => x.id === l.product_id);
      if (!p || p.in_stock_count <= 0) {
        changed = true;
        DB.releaseInventoryLock(l.product_id, webLockOwner, l.qty).catch(() => {});
        if (p) toast(`"${p.name}" was just claimed in the shop`);
        return acc;
      }
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
    const inventoryOpts = [["All", "All Items"], ["BRAND_NEW", "Brand New"], ["PRE_LOVED", "Vintage / Pre-Loved"]];
    $("#conditionChips").innerHTML = inventoryOpts.map(([value, label]) =>
      `<button class="fchip ${fInventory === value ? "active rust" : ""}" data-inventory="${value}">${label}</button>`
    ).join("");
  }

  function updateDynamicSEO() {
    const storeName = S.store_name || "Adonai Store";
    let title = `${storeName} — Brand-New & Curated Vintage Fashion`;
    if (fInventory === "BRAND_NEW") title = `Brand-New Apparel | ${storeName} Kampala`;
    if (fInventory === "PRE_LOVED") title = `Curated Vintage / Pre-Loved | ${storeName} Kampala`;
    if (fCat !== "All" && fDemo !== "All") {
      title = `${fDemo}'s ${fCat} | ${storeName} Kampala`;
    } else if (fCat !== "All") {
      title = `${fCat} | ${storeName} Kampala`;
    } else if (fDemo !== "All") {
      title = `${fDemo}'s Fashion | ${storeName} Kampala`;
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

  $("#conditionChips").addEventListener("click", e => {
    const b = e.target.closest("[data-inventory]");
    if (!b) return;
    fInventory = b.dataset.inventory;
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

  /* ============================================================
     COMPACT CATALOG CHROME
     Two things the rail was missing on phones and tablets: an honest
     count ("12 of 18 pieces match") and a way to put the filter panel
     away. Both are driven from renderGrid(), so every filter path —
     chips, selects, search, price, and live stock updates — keeps them
     accurate without any extra bookkeeping.
     ============================================================ */
  function activeFilterCount() {
    const range = $("#priceRange");
    const priceCapped = !!range && Number(range.value) < Number(range.max);
    return (fDemo !== "All" ? 1 : 0) + (fCat !== "All" ? 1 : 0) +
           (fInventory !== "All" ? 1 : 0) + (fSize !== "All" ? 1 : 0) +
           (fCond !== "All" ? 1 : 0) + (term ? 1 : 0) + (priceCapped ? 1 : 0);
  }

  let railMatched = 0, railTotal = 0;

  function applyFilterPanelState() {
    const toggle = $("#filterToggle"), card = $("#filterCard");
    if (!toggle || !card) return;
    const compact = window.innerWidth <= FILTER_PANEL_MAX;
    const open = !compact || filtersOpen;
    card.classList.toggle("is-collapsed", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.hidden = !compact;

    /* While the panel is open its own button doubles as the live result
       read-out, so a tap on a chip answers itself without scrolling. */
    const title = toggle.querySelector(".filter-toggle-title");
    if (title) title.textContent = open ? `Showing ${railMatched} of ${railTotal}` : "Refine the rail";

    const active = activeFilterCount();
    const badge = $("#filterBadge");
    if (badge) {
      badge.textContent = active ? `${active} active` : "";
      badge.hidden = !active;
    }
    const clear = $("#filterClear");
    if (clear) clear.dataset.visible = active ? "1" : "0";
  }

  function updateRailMeta(matched, total) {
    const count = $("#railCount");
    if (count) {
      const pieces = matched === 1 ? "piece" : "pieces";
      count.innerHTML = matched === total
        ? `<b>${total}</b> ${pieces} on the rail right now · prices in UGX`
        : `<b>${matched}</b> of ${total} ${pieces} match your filters`;
    }
    applyFilterPanelState();
  }

  const filterToggleBtn = $("#filterToggle");
  if (filterToggleBtn) {
    filterToggleBtn.addEventListener("click", () => {
      filtersOpen = !filtersOpen;
      applyFilterPanelState();
    });
  }

  const filterClearBtn = $("#filterClear");
  if (filterClearBtn) {
    filterClearBtn.addEventListener("click", () => {
      fDemo = fCat = fInventory = fSize = fCond = "All";
      term = "";
      const search = $("#shopSearch");
      if (search) search.value = "";
      const range = $("#priceRange");
      if (range) {
        range.value = range.max;
        fMax = Number(range.max);
        const readout = $("#priceVal");
        if (readout) readout.textContent = DB.ugx(fMax);
      }
      renderChips();
      renderGrid();
      updateDynamicSEO();
    });
  }

  /* Re-evaluate only when the viewport actually crosses the breakpoint —
     mobile browsers fire resize constantly as the URL bar slides away. */
  let filterLayoutCompact = null;
  window.addEventListener("resize", () => {
    const compact = window.innerWidth <= FILTER_PANEL_MAX;
    if (compact === filterLayoutCompact) return;
    filterLayoutCompact = compact;
    if (!compact) filtersOpen = false;   // desktop shows the panel outright
    applyFilterPanelState();
  }, { passive: true });

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
      ? `<div class="media-dots" title="Open the full photo set">${photos.slice(0, 4).map((src, i) =>
          `<i class="${i === 0 ? "active" : ""}" data-angle="${i}"><img src="${esc(PK.resolveSrc(src))}" alt="Angle ${i + 1}" width="40" height="40" loading="lazy" decoding="async" /></i>`).join("")}</div>`
      : "";
    const grade = PK.gradeFor(p);
    return `
      <div class="pmedia">
        <span class="grade-badge" style="--grade:${grade.color}">${esc(grade.short)}</span>
        ${disc > 0 ? `<span class="discount-badge">${disc}% OFF</span>` : ""}
        <span class="inventory-badge ${p.item_condition === "BRAND_NEW" ? "new" : "vintage"}">${p.is_consignment ? "PARTNER · VINTAGE" : (p.item_condition === "BRAND_NEW" ? "NEW" : "VINTAGE")}</span>
        ${img || `<span class="media-icon">${catIcon(p.category)}</span>`}
        ${dots}
        ${p.video && p.video.url ? '<span class="media-video-badge"><svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10" aria-hidden="true"><path d="M8 5v14l12-7z"/></svg>Video</span>' : ""}
        ${photos.length > 4 ? `<span class="media-extra-photos">+${photos.length - 4} photos</span>` : ""}
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
      .filter(p => fInventory === "All" || (p.item_condition || "PRE_LOVED") === fInventory)
      .filter(p => fSize === "All" || p.size === fSize)
      .filter(p => fCond === "All" || p.condition === fCond)
      .filter(p => displayPrice(p) <= fMax)
      .filter(p => matchesSearch(p, term))
      .sort((a, b) => (b.in_stock_count > 0) - (a.in_stock_count > 0));
    $("#gridEmpty").hidden = list.length > 0;
    grid.innerHTML = list.map(cardHTML).join("");
    updateRailMeta(list.length, products.length);
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
     disclosure, delivery estimator, one cart-based order path) lives on the
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

  async function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p || p.in_stock_count <= 0) return toast("That item is currently unavailable");
    const line = cart.find(l => l.product_id === id);
    if ((line ? line.qty : 0) + 1 > p.in_stock_count) return toast(`Only ${p.in_stock_count} in stock`);
    try {
      // A web reservation is short-lived (five minutes server-side) and is
      // subtracted from public availability. It prevents the same 1-of-1
      // piece from being checked out simultaneously by POS or another buyer.
      await DB.acquireInventoryLock(id, webLockOwner, 1);
      if (line) line.qty++; else cart.push({ product_id: id, qty: 1 });
      saveCart(); renderCart();
      toast(`${p.name} added to your cart`);
      if (window.AdonaiAnalytics) {
        window.AdonaiAnalytics.trackAddToCart(p, 1);
      }
      openCart();
    } catch (error) {
      toast(error.message || "That item was just reserved elsewhere");
      await DB.pullProducts(true);
    }
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
     same buttons). Every open/close path — addToCart, the header Cart
     button, ✕ Close, backdrop tap, Escape and the post-order "Continue
     Browsing" button — funnels through these two functions, and the page
     scroll lock itself is owned by window.AdonaiScrollLock so it cannot be
     left half-applied. Both controllers are idempotent, so the duplicate
     binding is harmless. */
  const scrollLock = () => window.AdonaiScrollLock || null;

  function openCart() {
    document.body.classList.add("cart-open");
    document.body.classList.remove("cart-drawer-closed");
    document.body.classList.add("cart-drawer-open");        // state hook (inert styling)
    const drawer = document.getElementById("cartDrawer");
    if (drawer) drawer.classList.add("is-active");
    const backdrop = document.getElementById("cartBackdrop");
    if (backdrop) backdrop.classList.add("is-active");
    const lock = scrollLock();
    if (lock) lock.lock("cart-drawer");                     // lock page scroll behind the drawer
    if (window.AdonaiAnalytics && cart.length > 0) {
      const lines = cartLines();
      const total = lines.reduce((s, x) => s + x.sub, 0);
      window.AdonaiAnalytics.trackBeginCheckout(lines.map(x => x.p), total);
    }
  }
  function closeCart() {
    document.body.classList.remove("cart-open", "cart-drawer-open");
    document.body.classList.add("cart-drawer-closed");      // state hook (inert styling)
    const drawer = document.getElementById("cartDrawer");
    if (drawer) drawer.classList.remove("is-active");
    const backdrop = document.getElementById("cartBackdrop");
    if (backdrop) backdrop.classList.remove("is-active");
    const lock = scrollLock();
    if (lock) { lock.unlock("cart-drawer"); lock.selfHeal(); }
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

  // Shoppers pay one flat delivery charge. The internal base-price/transport
  // allocation that produces it is never surfaced on the storefront.
  function cartDeliveryFee(lines) {
    return lines.reduce((sum, x) => {
      const fee = x.p.delivery_fee != null ? x.p.delivery_fee : x.p.checkout_transport_portion;
      return sum + (Number(fee) || 0) * x.line.qty;
    }, 0);
  }

  function renderCart() {
    const lines = cartLines();
    const itemCount = lines.reduce((s, x) => s + x.line.qty, 0);
    const subtotal = lines.reduce((s, x) => s + x.sub, 0);
    const currentDeliveryFee = deliveryType === "pickup" ? 0 : cartDeliveryFee(lines);
    const grandTotal = subtotal + currentDeliveryFee;
    $("#cartCount").textContent = itemCount;

    if (orderResult) {
      const paymentState = orderResult.paymentStatus || "unpaid";
      const settled = paymentState === "paid" || orderResult.method === "cod";
      const heading = settled && paymentState === "paid"
        ? `Payment received — order <strong>${esc(orderResult.id)}</strong> is confirmed.`
        : paymentState === "claimed"
          ? `Order <strong>${esc(orderResult.id)}</strong> — payment submitted, confirming it now.`
          : paymentState === "failed"
            ? `Payment for <strong>${esc(orderResult.id)}</strong> was not completed.`
            : settled
              ? `Held as <strong>${esc(orderResult.id)}</strong>. Your pieces are reserved off the rails.`
              : `Order <strong>${esc(orderResult.id)}</strong> is held for you — complete payment to confirm it.`;
      const statusLine = paymentState === "paid"
        ? `<p class="wa-instruct"><strong>Status: Paid ✔</strong><br />Thank you! Your payment has been verified and your order has synced directly to our POS fulfillment dashboard. Our team will contact the phone number you supplied with confirmation and delivery updates.</p>`
        : paymentState === "claimed"
          ? `<p class="wa-instruct"><strong>Status: Payment submitted</strong><br />We have your reference. Our team confirms it against the bank / merchant statement and your order updates automatically.</p>`
          : paymentState === "failed"
            ? `<p class="wa-instruct"><strong>Status: Payment not completed</strong><br />The payment window closed and the pieces went back on the rail. Place the order again to retry.</p>`
            : `<p class="wa-instruct"><strong>Status: Unfulfilled</strong><br />Your order has synced directly to our POS fulfillment dashboard. Our team will contact the phone number you supplied with confirmation and status updates.</p>`;

      if (!settled && paymentState !== "failed") {
        // Step 2: the shopper confirmed the order and now has to actually pay.
        $("#cartBody").innerHTML = `<div class="order-confirmed-view pay-step">${pendingPaymentBodyHTML()}</div>`;
        $("#cartFoot").innerHTML = pendingPaymentActionsHTML();
      } else {
        $("#cartBody").innerHTML = `
        <div class="order-confirmed-view">
          <div class="order-held-pill">
            ${heading}
          </div>

          <div class="total-due-card">
            <span class="due-lbl">${paymentState === "paid" ? "TOTAL PAID" : "TOTAL AMOUNT DUE"}</span>
            <span class="due-val">${DB.ugx(orderResult.total)}</span>
          </div>

          ${statusLine}
        </div>`;

        const footButtons = [];
        if (paymentState === "pending" && orderResult.method === "card") {
          footButtons.push(`<button class="claim-confirm-btn" id="payNowBtn" ${paymentBusy ? "disabled" : ""}>${paymentBusy ? "Opening secure payment…" : `Pay ${DB.ugx(orderResult.total)} now by card`}</button>`);
        }
        footButtons.push(`<button class="claim-confirm-btn" id="keepShopping">Continue Browsing Catalog</button>`);
        $("#cartFoot").innerHTML = footButtons.join("");
        const payNowBtn = $("#payNowBtn");
        if (payNowBtn) payNowBtn.addEventListener("click", () => { startFlutterwavePayment(); });
      }
      const keepShoppingBtn = $("#keepShopping");
      if (keepShoppingBtn) keepShoppingBtn.addEventListener("click", () => { orderResult = null; renderCart(); closeCart(); });
      const keepAfterPay = $("#keepShoppingAfterPay");
      if (keepAfterPay) keepAfterPay.addEventListener("click", () => { closeCart(); });
      const checkStatusBtn = $("#checkPaymentStatus");
      if (checkStatusBtn) checkStatusBtn.addEventListener("click", () => { refreshPendingPayment(true); });
      bindPayStepActions();
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
            ${p.is_consignment ? '<div class="line-source-tag">Partner consignment · one-of-one</div>' : ""}
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
          <button type="button" class="deliv-toggle-btn ${deliveryType === 'boda' ? 'active' : ''}" id="btnDelivBoda">Adonai Delivery</button>
          <button type="button" class="deliv-toggle-btn ${deliveryType === 'pickup' ? 'active' : ''}" id="btnDelivPickup">Store Pickup (Free)</button>
        </div>

        <div class="pay-method-block">
          <span class="claim-field-label">How would you like to pay?</span>
          <div class="pay-method-grid">
            ${(paymentConfig.channels || []).filter(c => c.available !== false).map(c => `
              <button type="button" class="pay-method-btn ${paymentMethod === c.id ? 'active' : ''}" data-pay-method="${esc(c.id)}">
                <strong>${esc(c.short || c.label)}</strong>
                <span>${esc(c.id === 'cod' ? `Pay on ${deliveryType === 'pickup' ? 'pickup' : 'delivery'}` : c.blurb)}</span>
              </button>`).join("")}
          </div>
          ${paymentMethod !== "cod" ? `<p class="delivery-service-note">${esc((channelInfo(paymentMethod) || {}).blurb || "")} ${
            paymentMethod === "card"
              ? `Your pieces stay reserved for ${esc(String(paymentConfig.payment_window_minutes || 30))} minutes while you pay.`
              : `You will get the exact payment details and reference on the next step. Your pieces stay reserved for about ${esc(String(Math.round((paymentConfig.offline_window_minutes || 180) / 60)))} hour${Math.round((paymentConfig.offline_window_minutes || 180) / 60) === 1 ? "" : "s"}.`
          }</p>` : ""}
          ${paymentMethod === "cod" || paymentMethod === "card" ? "" : `
            <label class="claim-field-label" for="coPayerAccount">${
              paymentMethod === "merchant"
                ? "Paying number (optional — for whoever is paying)"
                : paymentMethod === "bank"
                  ? "Account name or number you will pay from (optional — helps us match the transfer)"
                  : "Number you will pay from"}</label>
            <input class="claim-input" id="coPayerAccount" ${paymentMethod === "bank" ? "" : 'inputmode="tel" autocomplete="tel"'}
              placeholder="${paymentMethod === "bank" ? "e.g. Adonai Traders · 9030…" : "e.g. 0758873398"}" value="${esc(paymentDrafts.account || payerAccount)}" />`}
        </div>

        <div id="bodaDeliveryBox" ${deliveryType === 'pickup' ? 'style="display:none"' : ''}>
          <p class="delivery-service-note">Adonai Store manages confirmation, careful packaging, route coordination, customer updates, and the final handoff. A boda or courier partner is simply one part of the delivery journey.</p>
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
        <div class="sum-line"><span>Delivery fee:</span><span>${currentDeliveryFee > 0 ? DB.ugx(currentDeliveryFee) : "Free"}</span></div>
        <div class="sum-line total"><strong>Total:</strong><strong class="rust">${DB.ugx(grandTotal)}</strong></div>
      </div>
      <button class="claim-confirm-btn" id="confirmOrder">${
        paymentMethod === "cod"
          ? `Confirm order (${DB.ugx(grandTotal)})`
          : paymentMethod === "card"
            ? `Pay ${DB.ugx(grandTotal)} — Card`
            : `Confirm order & pay ${DB.ugx(grandTotal)}`
      }</button>
      <p class="checkout-policy-note">
        <strong>Returns:</strong> request within 48 hours of receipt for defective or incorrectly graded items.
        Review the <a href="/return-policy">return policy</a>,
        <a href="/terms-and-conditions">Terms &amp; Conditions</a>, and
        <a href="/privacy-policy">Privacy Policy</a> before confirming.
      </p>
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

    $$("[data-pay-method]").forEach(btn => {
      btn.addEventListener("click", () => setPaymentMethod(btn.dataset.payMethod));
    });
    const payerInput = $("#coPayerAccount");
    if (payerInput) payerInput.addEventListener("input", e => {
      // Held in a draft so a re-render of the drawer cannot wipe what was typed.
      paymentDrafts.account = e.target.value;
      payerAccount = e.target.value.trim();
    });

    const confirmButton = $("#confirmOrder");
    if (confirmButton) confirmButton.addEventListener("click", checkout);
  }

  $("#cartBody").addEventListener("click", e => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      const p = products.find(x => x.id === rm.dataset.rm);
      const line = cart.find(x => x.product_id === rm.dataset.rm);
      cart = cart.filter(x => x.product_id !== rm.dataset.rm);
      saveCart();
      renderCart();
      if (line) DB.releaseInventoryLock(rm.dataset.rm, webLockOwner, line.qty).catch(() => {});
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
      const deliveryFee = deliveryType === "pickup" ? 0 : cartDeliveryFee(cartLines());
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

      // The paying number the shopper typed for the channel they picked. It
      // travels with the order so staff can match the incoming mobile money
      // message to this order instead of guessing.
      const payingNumber = (paymentMethod === "cod" ? "" : String(paymentDrafts.account || payerAccount || phone).trim());

      const order = await DB.createWebOrder({
        customer_name: name,
        customer_phone: phone,
        delivery_type: deliveryType,
        delivery_area: areaName,
        delivery_address: deliveryAddress,
        delivery_fee: deliveryFee,
        delivery_notes: deliveryNotes,
        lock_owner: webLockOwner,
        payment_method: paymentMethod === "cod" ? undefined : paymentMethod,
        payer_account: payingNumber,
        items: cart.map(l => ({ product_id: l.product_id, qty: l.qty }))
      });

      if (window.AdonaiAnalytics) {
        window.AdonaiAnalytics.trackWebPurchase(order);
      }

      // Only a real payment intent carries a per-order token. `payment` exists
      // on every order (pay-on-delivery orders report "unpaid"), so branching
      // on its presence alone would park a paid-on-delivery order in a payment
      // step that has nothing to pay.
      const paymentInfo = order.payment && order.payment.token ? order.payment : null;
      orderResult = {
        id: order.id,
        total: order.total,
        status: order.dispatch_status || "Unfulfilled",
        method: paymentInfo ? (paymentInfo.channel || "card") : "cod",
        paymentStatus: (paymentInfo && paymentInfo.status) || "unpaid",
        paymentToken: paymentInfo ? paymentInfo.token : "",
        paymentWindow: paymentInfo ? paymentInfo.payment_window_minutes : null,
        merchantPayCode: (paymentInfo && paymentInfo.merchant_pay_code) || "",
        payerAccount: (paymentInfo && paymentInfo.payer_account) || payingNumber,
        expiresAt: (paymentInfo && paymentInfo.expires_at) || null,
        instructions: null
      };
      payerAccount = orderResult.payerAccount || "";
      paymentDrafts = { reference: "", account: orderResult.payerAccount };

      cart = [];
      saveCart();
      renderCart();
      refreshProducts();

      if (paymentInfo) {
        // The pieces are reserved server-side. Card shoppers go straight into
        // the secure popup; every offline channel lands on the pay step, which
        // tells them exactly where to send the money and collects the
        // transaction reference so staff can confirm it.
        rememberPendingPayment(orderResult);
        if (orderResult.method === "card") {
          startFlutterwavePayment();
        } else if (orderResult.method === "merchant" && orderResult.merchantPayCode && !orderResult.instructions) {
          // The code is minted at checkout; the wording that explains how to
          // use it comes from the server so both stay in step.
          DB.requestMerchantPayCode(orderResult.id, orderResult.paymentToken).then(data => {
            orderResult.merchantPayCode = data.merchant_pay_code || orderResult.merchantPayCode;
            orderResult.instructions = data.instructions || null;
            rememberPendingPayment(orderResult);
            renderCart();
          }).catch(() => {});
        }
      }
    } catch (err) {
      toast(err.message || "Something went wrong — please try again");
      refreshProducts();
      renderCart();
    }
  }

  /* ---------- pending payment persistence ----------
     A shopper who closes the tab or switches to their bank app must be able
     to come back and finish. We remember only what is needed to resume: the
     order id, its payment token, the channel and the amount. The token is
     scoped to this one order by the server, so it is not a general credential.
     Stale entries are dropped the moment the window lapses. */
  function rememberPendingPayment(result) {
    try {
      if (!result || !result.paymentToken || result.paymentStatus === "paid") return;
      localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({
        id: result.id,
        total: result.total,
        method: result.method,
        paymentToken: result.paymentToken,
        paymentStatus: result.paymentStatus,
        merchantPayCode: result.merchantPayCode || "",
        payerAccount: result.payerAccount || "",
        expiresAt: result.expiresAt || null,
        window: result.paymentWindow || null
      }));
    } catch (e) {}
  }
  function forgetPendingPayment() {
    try { localStorage.removeItem(PENDING_PAYMENT_KEY); } catch (e) {}
  }
  function restorePendingPayment() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PENDING_PAYMENT_KEY) || "null"); } catch (e) { saved = null; }
    if (!saved || !saved.id || !saved.paymentToken) { forgetPendingPayment(); return null; }
    if (saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now()) { forgetPendingPayment(); return null; }
    return Object.assign({ status: "Unfulfilled", paymentWindow: saved.window, instructions: null }, saved);
  }

  /* ---------- offline payment step ----------
     Card shoppers continue inside the gateway. Everyone else needs to be told
     where the money goes and then hand back the transaction reference; that is
     all a claim is. Nothing here can settle an order — the server only marks
     an order paid after the gateway verifies a charge or staff confirm the
     money landed. */
  const PAY_STATUS_COPY = {
    pending: "Waiting for your payment",
    claimed: "Payment submitted — confirming with the bank / merchant",
    paid: "Payment received",
    failed: "Payment window closed"
  };

  function payToCardHTML(channel) {
    const payTo = paymentConfig.pay_to || {};
    if (channel === "momo") {
      const payer = orderResult.payerAccount || paymentDrafts.account || "";
      const rows = [
        ["Send to", payTo.momo_name || payTo.store_name || "Adonai Store"],
        ["Merchant number", payTo.momo_number || "—"],
        ["Amount", DB.ugx(orderResult.total)],
        ["Reference", orderResult.id]
      ];
      // Show back the number we captured at checkout so the shopper can see the
      // payment is matched to the right line before they send anything.
      if (payer) rows.push(["Paying from", payer]);
      return `<div class="pay-detail-card">${rows.map(([k, v]) => `
        <div class="pay-detail-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("")}
      </div>`;
    }
    if (channel === "bank") {
      const rows = [
        ["Bank", payTo.bank_name || "—"],
        ["Account name", payTo.bank_account_name || payTo.store_name || "Adonai Store"],
        ["Account number", payTo.bank_account_number || "—"],
        ["Branch", payTo.bank_branch || "—"],
        ["Amount", DB.ugx(orderResult.total)],
        ["Reference", payTo.bank_reference_hint || orderResult.id]
      ].filter(([, v]) => v !== "—");
      return `<div class="pay-detail-card">${rows.map(([k, v]) => `
        <div class="pay-detail-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("")}
      </div>`;
    }
    return "";
  }

  function payCodeCardHTML() {
    const code = orderResult && orderResult.merchantPayCode;
    if (!code) {
      return `<button type="button" class="claim-confirm-btn" id="requestPayCode">Generate my merchant pay code</button>
        <p class="pay-hint">Use this when someone else is paying for you, or when you would rather pay at a merchant point.</p>`;
    }
    const lines = (orderResult.instructions && orderResult.instructions.lines) || [];
    const wa = String((paymentConfig.pay_to || {}).whatsapp || "").replace(/\D/g, "");
    const shareText = `${S.store_name || "Adonai Store"} pay code ${code} — ${DB.ugx(orderResult.total)} for order ${orderResult.id}. Please pay this exact amount and keep the transaction ID.`;
    return `
      <div class="pay-code-card">
        <span class="pay-code-label">Your merchant pay code</span>
        <strong class="pay-code">${esc(code)}</strong>
        <span class="pay-code-amount">${DB.ugx(orderResult.total)} · order ${esc(orderResult.id)}</span>
      </div>
      ${lines.length ? `<ul class="pay-instructions">${lines.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
      <div class="pay-inline-actions">
        <button type="button" class="pay-mini-btn" id="copyPayCode" data-code="${esc(code)}">Copy code</button>
        ${wa ? `<a class="pay-mini-btn" target="_blank" rel="noopener" href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(shareText)}">Send on WhatsApp</a>` : ""}
      </div>`;
  }

  function payReferenceFormHTML(channel, referenceLabel, buttonLabel) {
    const submitted = orderResult.paymentStatus === "claimed";
    const claim = orderResult.claim || null;
    if (submitted) {
      return `<p class="pay-flash ok">✔ Reference ${esc((claim && claim.reference) || paymentDrafts.reference || "")} sent. Our team confirms it and your order updates automatically — you can close this page.</p>`;
    }
    return `
      <label class="claim-field-label" for="payRefInput">${esc(referenceLabel)}</label>
      <input class="claim-input" id="payRefInput" autocomplete="off" placeholder="${esc(referenceLabel)}" value="${esc(paymentDrafts.reference)}" />
      <button type="button" class="claim-confirm-btn" id="submitPaymentClaim" data-channel="${esc(channel)}" ${paymentBusy ? "disabled" : ""}>
        ${esc(paymentBusy ? "Submitting…" : buttonLabel)}
      </button>`;
  }

  function pendingPaymentBodyHTML() {
    const channel = orderResult.method;
    const info = channelInfo(channel);
    const label = (info && info.label) || "Payment";
    const header = `
      <div class="pay-step-head">
        <span class="pay-step-eyebrow">Step 2 of 2 · Complete payment</span>
        <h3 class="pay-step-title">${esc(label)}</h3>
        <p class="pay-step-sub">${esc((info && info.blurb) || "")}</p>
      </div>
      <div class="total-due-card">
        <span class="due-lbl">AMOUNT TO PAY</span>
        <span class="due-val">${DB.ugx(orderResult.total)}</span>
        <span class="due-lbl">ORDER ${esc(orderResult.id)}</span>
      </div>`;

    let body = "";
    if (channel === "card") {
      // In simulated mode there is deliberately no bank window and no PIN
      // prompt — say so, rather than letting a tester think it is broken.
      const simulated = paymentConfig.mock
        ? `<p class="pay-flash">Simulated gateway (development): this server has no Flutterwave keys, so the payment is approved
           instantly through the same server check the real gateway uses. No bank window opens and no PIN is asked for here —
           that is expected. A live store collects both inside Flutterwave's own window.</p>`
        : "";
      body = `<p class="wa-instruct">Your pieces are reserved. Pay with Visa, Mastercard, MTN MoMo or Airtel Money in the secure window — you will approve with your PIN or one-time code there.</p>${simulated}`;
    } else if (channel === "momo") {
      const payTo = paymentConfig.pay_to || {};
      const manual = !!payTo.momo_number;
      const number = orderResult.payerAccount || paymentDrafts.account || "";
      if (gatewayCollects("momo")) {
        // Instant rail: type the paying number, the network pushes the approval
        // prompt to that phone, the shopper confirms with their own MoMo PIN and
        // the gateway tells this server the money landed — no waiting on staff.
        body = `
          <div class="pay-instant">
            <label class="claim-field-label" for="instantPayerPhone">Number to send the payment prompt to</label>
            <input class="claim-input" id="instantPayerPhone" inputmode="tel" autocomplete="tel"
              placeholder="e.g. 0758873398" value="${esc(number)}" />
            <button type="button" class="claim-confirm-btn" id="sendPaymentPrompt" ${paymentBusy ? "disabled" : ""}>
              ${paymentBusy ? "Sending the prompt…" : `Send the prompt — pay ${DB.ugx(orderResult.total)}`}
            </button>
            <p class="pay-hint">Approve the prompt that arrives on that phone and confirm it with your MoMo PIN. Your PIN is only ever entered on your own phone.</p>
            ${paymentConfig.mock ? `<p class="pay-flash">Simulated gateway (development): no prompt is really sent and no money moves — the order settles through the server check so the flow can be tested end to end.</p>` : ""}
          </div>
          ${manual ? `
            <details class="pay-manual">
              <summary>Or send it yourself to our merchant line</summary>
              ${payToCardHTML("momo")}
              <p class="pay-hint">Send the exact amount using order ${esc(orderResult.id)} as the reason, then paste the transaction ID from your MoMo confirmation message.</p>
              ${payReferenceFormHTML("momo", "MoMo transaction ID", "I have paid — submit transaction ID")}
            </details>` : ""}`;
      } else {
        body = `${payToCardHTML("momo")}
          <p class="pay-hint">Send the exact amount to the merchant number above, using order ${esc(orderResult.id)} as the reason. Your MoMo app asks for your PIN — we never see it. Then paste the transaction ID from your MoMo confirmation message below.</p>
          ${payReferenceFormHTML("momo", "MoMo transaction ID", "I have paid — submit transaction ID")}`;
      }
    } else if (channel === "bank") {
      body = `${payToCardHTML("bank")}
        <p class="pay-hint">Transfer the exact amount from your bank app or branch and keep the reference. Your bank confirms the transfer with your PIN or token — we never see it. Then paste the reference or transaction ID below so we can confirm it against the statement.</p>
        ${payReferenceFormHTML("bank", "Bank reference / transaction ID", "I have paid — submit reference")}`;
    } else if (channel === "merchant") {
      body = `${payCodeCardHTML()}
        ${payReferenceFormHTML("merchant", "Transaction ID from the merchant point (optional)", "I have paid — submit for confirmation")}`;
    }

    const others = (paymentConfig.channels || []).filter(c =>
      c.available !== false && c.id !== channel && c.id !== "cod");
    const switcher = others.length ? `
      <div class="pay-switch">
        <span class="pay-switch-label">Prefer another way to pay?</span>
        <div class="pay-switch-row">
          ${others.map(c => `<button type="button" class="pay-mini-btn" data-switch-channel="${esc(c.id)}">${esc(c.short || c.label)}</button>`).join("")}
          <button type="button" class="pay-mini-btn" data-switch-channel="cod">Pay on delivery instead</button>
        </div>
      </div>` : "";

    const flash = paymentFlash ? `<p class="pay-flash">${esc(paymentFlash)}</p>` : "";
    const status = orderResult.paymentStatus === "claimed"
      ? `<p class="pay-flash ok">Your reference is with the team now. Nothing else is needed from you.</p>`
      : `<p class="pay-hint">Reserved for you${orderResult.paymentWindow ? ` for about ${esc(String(orderResult.paymentWindow))} minutes` : ""}. Unpaid orders release their pieces automatically.</p>`;

    return `${header}${body}${flash}${status}${switcher}`;
  }

  function pendingPaymentActionsHTML() {
    return `
      <button type="button" class="claim-confirm-btn" id="checkPaymentStatus" ${paymentBusy ? "disabled" : ""}>
        ${paymentBusy ? "Checking…" : "Check payment status"}
      </button>
      <button type="button" class="claim-confirm-btn ghost" id="keepShoppingAfterPay">Continue browsing — I will finish later</button>`;
  }

  /* Buttons rendered inside the pay step. Bound after every render because
     the step is re-rendered on each state change. */
  function bindPayStepActions() {
    const codeBtn = $("#requestPayCode");
    if (codeBtn) codeBtn.addEventListener("click", () => { requestPayCode(); });
    const copyBtn = $("#copyPayCode");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      const code = copyBtn.dataset.code || "";
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(code);
          toast(`Pay code ${code} copied`);
        } else {
          toast(`Your pay code is ${code}`);
        }
      } catch (e) { toast(`Your pay code is ${code}`); }
    });
    const switchButtons = $$("[data-switch-channel]");
    switchButtons.forEach(btn => btn.addEventListener("click", () => { switchPaymentChannel(btn.dataset.switchChannel); }));
    const refInput = $("#payRefInput");
    if (refInput) refInput.addEventListener("input", e => { paymentDrafts.reference = e.target.value; });
    const submitBtn = $("#submitPaymentClaim");
    if (submitBtn) submitBtn.addEventListener("click", () => { submitPaymentClaim(submitBtn.dataset.channel); });
    const promptBtn = $("#sendPaymentPrompt");
    if (promptBtn) promptBtn.addEventListener("click", () => { sendInstantMomoPrompt(); });
    const promptPhone = $("#instantPayerPhone");
    if (promptPhone) promptPhone.addEventListener("input", e => {
      paymentDrafts.account = e.target.value;
      payerAccount = e.target.value.trim();
    });
  }

  /* Instant mobile money: the shopper's own phone does the confirming, so the
     only thing we must get right is the number the prompt goes to. */
  async function sendInstantMomoPrompt() {
    if (!orderResult || !orderResult.paymentToken || paymentBusy) return;
    const input = $("#instantPayerPhone");
    const number = String((input && input.value) || paymentDrafts.account || payerAccount || "").replace(/[^0-9+]/g, "");
    if (number.replace(/\D/g, "").length < 9) {
      paymentFlash = "Enter the mobile money number that should receive the payment prompt.";
      renderCart();
      const again = $("#instantPayerPhone");
      if (again) again.focus();
      return;
    }
    paymentBusy = true; paymentFlash = ""; renderCart();
    try {
      // Keep the order's paying number in step so the prompt, the receipt and
      // the console all name the same line.
      if (number !== String(orderResult.payerAccount || "")) {
        const saved = await DB.setPaymentChannel(orderResult.id, orderResult.paymentToken, "momo", number);
        orderResult.payerAccount = saved.payer_account || number;
        paymentDrafts.account = orderResult.payerAccount;
        rememberPendingPayment(orderResult);
      }
    } catch (err) {
      paymentBusy = false;
      paymentFlash = err.message || "Could not save that number — please try again.";
      renderCart();
      return;
    }
    paymentBusy = false;
    await startFlutterwavePayment("momo");
  }

  async function requestPayCode() {
    if (!orderResult || !orderResult.paymentToken || paymentBusy) return;
    paymentBusy = true; renderCart();
    try {
      const data = await DB.requestMerchantPayCode(orderResult.id, orderResult.paymentToken);
      orderResult.merchantPayCode = data.merchant_pay_code;
      orderResult.instructions = data.instructions || null;
      if (data.expires_at) orderResult.expiresAt = data.expires_at;
      paymentFlash = "Show this code at any merchant point, or send it to whoever is paying for you.";
      rememberPendingPayment(orderResult);
    } catch (err) {
      paymentFlash = err.message || "Could not issue a pay code — please try again.";
    } finally {
      paymentBusy = false; renderCart();
    }
  }

  async function switchPaymentChannel(channel) {
    if (!orderResult || !orderResult.paymentToken || paymentBusy) return;
    paymentBusy = true; paymentFlash = ""; renderCart();
    try {
      const data = await DB.setPaymentChannel(
        orderResult.id, orderResult.paymentToken, channel, paymentDrafts.account || payerAccount || ""
      );
      orderResult.method = data.channel || channel;
      orderResult.merchantPayCode = data.merchant_pay_code || orderResult.merchantPayCode;
      if (data.expires_at) orderResult.expiresAt = data.expires_at;
      orderResult.paymentStatus = "pending";
      orderResult.claim = null;
      if (channel === "card") {
        paymentBusy = false; renderCart();
        return startFlutterwavePayment();
      }
    } catch (err) {
      paymentFlash = err.message || "That payment option could not be selected.";
    } finally {
      paymentBusy = false; renderCart();
    }
  }

  async function submitPaymentClaim(channel) {
    if (!orderResult || !orderResult.paymentToken || paymentBusy) return;
    const reference = String(paymentDrafts.reference || "").trim();
    if (channel !== "merchant" && !reference) {
      paymentFlash = channel === "bank"
        ? "Enter the bank reference or transaction ID from your payment message."
        : "Enter the transaction ID from your MoMo confirmation message.";
      return renderCart();
    }
    paymentBusy = true; paymentFlash = ""; renderCart();
    try {
      const data = await DB.submitPaymentClaim(orderResult.id, orderResult.paymentToken, channel, reference);
      if (data && data.ok === false && data.error) {
        paymentFlash = data.error;
      } else {
        orderResult.paymentStatus = (data && data.payment_status) || "claimed";
        orderResult.claim = { channel, reference, at: new Date().toISOString() };
        paymentFlash = "";
        toast("Payment submitted — our team confirms it shortly");
      }
      rememberPendingPayment(orderResult);
    } catch (err) {
      paymentFlash = err.message || "Could not submit that reference — please try again.";
    } finally {
      paymentBusy = false; renderCart();
    }
  }

  /* Reconcile with the server. This is the only place the pay step learns that
     the money arrived, so a stale tab can never show "paid" on its own. */
  async function refreshPendingPayment(notify) {
    if (!orderResult || !orderResult.paymentToken) return false;
    paymentBusy = true; renderCart();
    try {
      const data = await DB.fetchPaymentStatus(orderResult.id, orderResult.paymentToken);
      orderResult.paymentStatus = data.payment_status || orderResult.paymentStatus;
      orderResult.merchantPayCode = data.merchant_pay_code || orderResult.merchantPayCode || "";
      if (data.reference) orderResult.reference = data.reference;
      if (data.paid_at) orderResult.paidAt = data.paid_at;
      if (data.expires_at) orderResult.expiresAt = data.expires_at;
      if (data.payment_status === "paid") {
        forgetPendingPayment();
        if (notify) toast("Payment received — your order is confirmed ✔");
      } else if (data.payment_status === "failed") {
        forgetPendingPayment();
        if (notify) toast("The payment window closed — please order again", false);
      } else if (notify) {
        paymentFlash = data.payment_status === "claimed"
          ? "Your reference is with our team. The order updates the moment it is confirmed."
          : "No payment recorded yet. Once you pay, this updates automatically.";
      }
    } catch (err) {
      if (notify) paymentFlash = err.message || "Could not check the payment status right now.";
    } finally {
      paymentBusy = false; renderCart();
    }
    return orderResult.paymentStatus === "paid";
  }

  /* ---------- Flutterwave Inline popup orchestration ---------- */
  /* True when the gateway can collect this channel right now: card always (the
     channel only exists when the gateway does), mobile money when the store has
     gateway keys — the shopper then approves a prompt on their own phone. */
  function gatewayCollects(channel) {
    const target = String(channel || (orderResult && orderResult.method) || "");
    if (target === "card") return true;
    if (target === "momo") return !!paymentConfig.enabled;
    return false;
  }

  async function startFlutterwavePayment(channel) {
    if (!orderResult || !orderResult.paymentToken) return;
    const target = String(channel || orderResult.method || "");
    // Card is charged on the card rail and mobile money on the MoMo rail (the
    // shopper confirms on their phone with their own PIN). Bank and merchant
    // orders are confirmed by staff against the statement and must never be
    // parked in the popup where a shopper would pay twice.
    if (!gatewayCollects(target)) return;
    if (paymentBusy) return;
    paymentBusy = true;
    renderCart();
    try {
      const sessionData = await DB.createFlutterwaveSession(orderResult.id, orderResult.paymentToken, target);

      if (sessionData.mock) {
        // Local development mock (no real keys configured): approve through
        // the same server verification path the real gateway uses.
        const simulated = await DB.verifyFlutterwavePayment(orderResult.id, orderResult.paymentToken, `MOCK${Date.now()}`, sessionData.tx_ref);
        if (simulated && simulated.payment_status === "paid") {
          orderResult.paymentStatus = "paid";
          // Settled: nothing is pending any more, so a later visit must not
          // reopen a payment step for an order that is already paid.
          forgetPendingPayment();
        } else {
          toast((simulated && simulated.error) || "Mock payment did not confirm");
        }
        paymentBusy = false;
        renderCart();
        return;
      }

      const scriptOk = await DB.loadFlutterwaveScript();
      if (!scriptOk) throw new Error("Could not load the secure payment window — check your internet connection and try again");

      let handledResponse = false;
      window.FlutterwaveCheckout({
        public_key: sessionData.public_key,
        tx_ref: sessionData.tx_ref,
        amount: sessionData.amount,
        currency: sessionData.currency || "UGX",
        payment_options: sessionData.payment_options || "mobilemoneyuganda,card",
        meta: { order_id: sessionData.order_id },
        customer: {
          name: (sessionData.customer && sessionData.customer.name) || undefined,
          phone_number: (sessionData.customer && sessionData.customer.phone) || undefined,
        },
        customizations: {
          title: (S.store_name || "Adonai Store") + " — Secure checkout",
          description: `Order ${sessionData.order_id}`,
          logo: window.location.origin + "/assets/favicon-512.png",
        },
        callback: (response) => {
          handledResponse = true;
          finalizeFlutterwavePayment(response, sessionData);
        },
        onclose: () => {
          // The gateway may confirm mobile money a beat after the modal
          // closes; reconcile with the server either way.
          pollPaymentCompletion(!handledResponse);
        },
      });
      paymentBusy = false;
      renderCart();
    } catch (err) {
      paymentBusy = false;
      toast(err.message || "Payment could not be started — try again");
      renderCart();
    }
  }

  async function finalizeFlutterwavePayment(response, sessionData) {
    if (!orderResult || !orderResult.paymentToken) return;
    const popupStatus = String((response && response.status) || "").toLowerCase();
    if (popupStatus !== "successful" && popupStatus !== "completed") {
      orderResult.paymentStatus = "pending";
      renderCart();
      toast("Payment was not completed — you can retry while your pieces are still reserved");
      return;
    }
    paymentBusy = true;
    renderCart();
    try {
      const result = await DB.verifyFlutterwavePayment(
        orderResult.id,
        orderResult.paymentToken,
        (response && response.transaction_id) || "",
        (sessionData && sessionData.tx_ref) || ""
      );
      if (result && result.payment_status === "paid") {
        orderResult.paymentStatus = "paid";
        forgetPendingPayment();
      } else {
        const settled = await pollPaymentCompletion(true);
        if (!settled && result && result.error) toast(result.error);
      }
    } catch (err) {
      toast("Payment confirmation is taking longer than usual — checking with the server…");
      await pollPaymentCompletion(true);
    } finally {
      paymentBusy = false;
      renderCart();
    }
  }

  async function pollPaymentCompletion(silent) {
    if (!orderResult || !orderResult.paymentToken) return false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const statusData = await DB.fetchPaymentStatus(orderResult.id, orderResult.paymentToken);
        if (statusData.payment_status === "paid") {
          orderResult.paymentStatus = "paid";
          orderResult.reference = statusData.reference || orderResult.reference;
          forgetPendingPayment();
          renderCart();
          return true;
        }
        if (statusData.payment_status === "failed") {
          orderResult.paymentStatus = "failed";
          forgetPendingPayment();
          renderCart();
          return false;
        }
        if (statusData.payment_status === "claimed") {
          orderResult.paymentStatus = "claimed";
          orderResult.claim = statusData.claim || orderResult.claim;
          rememberPendingPayment(orderResult);
          renderCart();
        }
      } catch (err) { /* transient network hiccup — keep polling */ }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    if (!silent) toast("Still waiting for payment confirmation — it will appear here shortly");
    renderCart();
    return false;
  }

  /* Keep browser cart reservations alive while the shopper is active. The
     database remains authoritative and expires abandoned holds automatically. */
  window.setInterval(() => {
    if (cart.length && !document.hidden) {
      DB.heartbeatInventoryLocks(webLockOwner).catch(() => {});
    }
  }, 120000);

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
    renderPromotionalRail();
    DELIVERY_AREAS = buildDeliveryAreas();
    if (selectedAreaIndex >= DELIVERY_AREAS.length) selectedAreaIndex = 0;
    renderCart();
    renderGrid();
    updateDynamicSEO();
  });

  /* ---------- boot ---------- */
  refreshProducts();
  renderCart();

  // Discover which payment routes this store can actually honour. The server
  // only offers a channel once its details are published (gateway keys for
  // card, a merchant line for MoMo, a bank account for transfers), so the
  // storefront can never advertise a way to pay that would leave money in
  // limbo.
  DB.getPaymentConfig().then(config => {
    const previous = JSON.stringify(paymentConfig.methods || []);
    paymentConfig = Object.assign(paymentConfig, config || {});
    if (!channelAvailable(paymentMethod)) paymentMethod = "cod";
    if (JSON.stringify(paymentConfig.methods || []) !== previous) renderCart();
  }).catch(() => {});

  // A shopper who closed the tab mid-payment resumes exactly where they left
  // off: the order, its amount and the channel all come back, so the money
  // they may already have sent is never orphaned in a forgotten order.
  (function resumePendingPayment() {
    const saved = restorePendingPayment();
    if (!saved) return;
    orderResult = saved;
    DB.fetchPaymentStatus(orderResult.id, orderResult.paymentToken).then(status => {
      if (!status || !status.payment_status) return;
      orderResult.paymentStatus = status.payment_status;
      orderResult.merchantPayCode = status.merchant_pay_code || orderResult.merchantPayCode;
      orderResult.claim = status.claim || orderResult.claim;
      if (status.payment_status === "paid") forgetPendingPayment();
      else if (status.payment_status === "failed") { forgetPendingPayment(); orderResult = null; }
      else rememberPendingPayment(orderResult);
      renderCart();
    }).catch(() => { renderCart(); });
    openCart();
  })();

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
