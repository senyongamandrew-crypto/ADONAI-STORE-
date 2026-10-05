/* ============================================================
   ADONAI THRIFT STORE — PRODUCT DETAIL PAGE (PDP) CONTROLLER
   Route: /product/<slug>

   Desktop (≥1024px): 45% media gallery · 30% specs · 25% sticky buy box
   Mobile  (≤1023px): swipeable carousel → pricing → badges → accordions
                      → fixed bottom action bar (Cart + WhatsApp)
   ============================================================ */
(function () {
  "use strict";

  const K = window.AdonaiPDP;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = K.esc;
  const CART_KEY = "adonai-cart-v1";

  /* ---------- state ---------- */
  let product = window.__ADONAI_PDP_PRODUCT__ || null;
  let settings = DB.getSettings();
  let activePhoto = (() => {
    const requested = Number(new URLSearchParams(window.location.search).get("photo"));
    return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  })();
  let unit = localStorage.getItem("adonai-measure-unit") === "cm" ? "cm" : "in";
  let zone = localStorage.getItem("adonai-delivery-zone") || "kampala";
  let photos = [];
  let lightboxZoomed = false;

  const slugFromPath = () => {
    const match = window.location.pathname.match(/\/product\/([^/]+)/);
    if (match) return decodeURIComponent(match[1]);
    const params = new URLSearchParams(window.location.search);
    return params.get("slug") || params.get("id") || params.get("sku") || "";
  };
  const requestedSlug = slugFromPath();

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(message) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* ---------- cart (shared storage with the rail storefront) ---------- */
  function readCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { return []; }
  }
  function writeCart(lines) {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
    paintCartCount();
  }
  function paintCartCount() {
    const count = readCart().reduce((sum, line) => sum + Number(line.qty || 0), 0);
    const el = $("#cartCount");
    if (el) el.textContent = count;
  }

  function addToCart() {
    if (!product) return;
    const stock = K.stockState(product);
    if (stock.sold) return toast("That piece has already been claimed");
    const cart = readCart();
    const line = cart.find(l => l.product_id === product.id);
    const inCart = line ? line.qty : 0;
    if (inCart + 1 > stock.count) return toast(`Only ${stock.count} available`);
    if (line) line.qty++;
    else cart.push({ product_id: product.id, qty: 1 });
    writeCart(cart);
    if (window.AdonaiAnalytics) window.AdonaiAnalytics.trackAddToCart(product, 1);
    const sub = $("#pdpAddedSub");
    if (sub) sub.textContent = `${product.name} · ${K.ugx(K.displayPrice(product))}`;
    const panel = $("#pdpAdded");
    if (panel) panel.hidden = false;
  }

  /* ============================================================
     RENDER — BREADCRUMB
     ============================================================ */
  function renderCrumbs() {
    const demographic = product.demographic || "Catalog";
    const category = product.category || "Pieces";
    $("#pdpCrumbs").innerHTML = `
      <ol>
        <li><a href="/">Home</a></li>
        <li><a href="/?demo=${encodeURIComponent(demographic)}">${esc(demographic)}</a></li>
        <li><a href="/?demo=${encodeURIComponent(demographic)}&amp;cat=${encodeURIComponent(category)}">${esc(category)}</a></li>
        <li aria-current="page">${esc(product.name)}</li>
      </ol>`;
  }

  /* ============================================================
     RENDER — LEFT COLUMN: MEDIA GALLERY
     Desktop: vertical thumbnail strip + sticky main stage
     Mobile:  edge-to-edge swipeable carousel with counter + dots
     ============================================================ */
  const ANGLE_LABELS = ["Front", "Back", "Fabric", "Tag"];
  function angleLabel(index) {
    return ANGLE_LABELS[index] || `View ${index + 1}`;
  }

  function renderMedia() {
    const stock = K.stockState(product);
    const flaw = K.flawDisclosure(product);
    const discount = K.discountPercent(product);
    const grade = K.gradeFor(product);

    if (!photos.length) {
      $("#pdpMedia").innerHTML = `
        <div class="pdp-media-sticky">
          <div class="pdp-stage empty"><span>Photo coming shortly — ask us on WhatsApp for live pictures.</span></div>
        </div>`;
      return;
    }

    const thumbs = photos.map((src, i) => `
      <button class="pdp-thumb ${i === activePhoto ? "active" : ""} ${flaw.photoIndex === i ? "is-flaw" : ""}"
              data-thumb="${i}" type="button" aria-current="${i === activePhoto}"
              aria-label="${flaw.photoIndex === i ? "View the close-up photo of the flaw" : `View ${esc(angleLabel(i))} photo`}">
        ${K.pictureHTML(src, { alt: `${product.name} — ${angleLabel(i)}`, sizes: "72px", width: 72, height: 90 })}
        <span class="pdp-thumb-tag">${flaw.photoIndex === i ? "⚠️ Flaw" : esc(angleLabel(i))}</span>
      </button>`).join("");

    const slides = photos.map((src, i) => `
      <figure class="pdp-slide" data-slide="${i}">
        ${K.pictureHTML(src, {
          alt: `${product.name} — ${angleLabel(i)} view`,
          sizes: "(min-width: 1024px) 45vw, 100vw",
          eager: i === 0,
          className: "pdp-slide-img"
        })}
      </figure>`).join("");

    $("#pdpMedia").innerHTML = `
      <div class="pdp-media-sticky">
        <div class="pdp-gallery ${stock.sold ? "is-sold" : ""}">
          <div class="pdp-thumbrail" id="pdpThumbRail" role="tablist" aria-label="Photo angles">${thumbs}</div>
          <div class="pdp-stage-wrap">
            <div class="pdp-stage-badges">
              <span class="pdp-grade-chip" style="--grade:${grade.color};--grade-tint:${grade.tint}">${esc(grade.short)}</span>
              ${discount > 0 ? `<span class="pdp-disc-chip">-${discount}%</span>` : ""}
            </div>
            ${stock.sold ? `<div class="pdp-sold-overlay"><span>SOLD OUT</span></div>` : ""}
            <div class="pdp-stage-track" id="pdpTrack" tabindex="0" aria-label="Swipe through product photos">${slides}</div>
            ${photos.length > 1 ? `
              <button class="pdp-stage-nav prev" id="pdpPrev" type="button" aria-label="Previous photo">‹</button>
              <button class="pdp-stage-nav next" id="pdpNext" type="button" aria-label="Next photo">›</button>` : ""}
            <button class="pdp-zoom-btn" id="pdpZoom" type="button" aria-label="Open full screen photo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2M11 8v6M8 11h6"/></svg>
              Zoom
            </button>
            <span class="pdp-counter" id="pdpCounter">${activePhoto + 1} / ${photos.length}</span>
          </div>
        </div>
        ${photos.length > 1 ? `<div class="pdp-dots" id="pdpDots">${photos.map((_, i) =>
          `<button class="pdp-dot ${i === activePhoto ? "active" : ""}" data-dot="${i}" type="button" aria-label="Photo ${i + 1}"></button>`).join("")}</div>` : ""}
        <p class="pdp-media-note">📷 Real daylight photos of the exact piece you receive — never a catalog stock image.</p>
      </div>`;

    bindGallery();
  }

  function bindGallery() {
    const track = $("#pdpTrack");
    if (!track) return;

    const goTo = (index, smooth) => {
      activePhoto = Math.max(0, Math.min(photos.length - 1, index));
      const left = track.clientWidth * activePhoto;
      // Older Android WebViews (common on budget devices in UG) lack
      // Element.scrollTo — fall back to assigning scrollLeft directly.
      if (typeof track.scrollTo === "function") {
        try {
          track.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
        } catch (_) {
          track.scrollLeft = left;
        }
      } else {
        track.scrollLeft = left;
      }
      paintGalleryState();
    };

    $$("[data-thumb]").forEach(btn =>
      btn.addEventListener("click", () => goTo(Number(btn.dataset.thumb), true)));
    $$("[data-dot]").forEach(btn =>
      btn.addEventListener("click", () => goTo(Number(btn.dataset.dot), true)));

    const prev = $("#pdpPrev");
    const next = $("#pdpNext");
    if (prev) prev.addEventListener("click", () => goTo((activePhoto - 1 + photos.length) % photos.length, true));
    if (next) next.addEventListener("click", () => goTo((activePhoto + 1) % photos.length, true));

    // Native scroll-snap powers mobile swipe; keep the UI in sync with it.
    let scrollTimer;
    track.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (index !== activePhoto) {
          activePhoto = index;
          paintGalleryState();
        }
      }, 80);
    }, { passive: true });

    track.addEventListener("keydown", event => {
      if (event.key === "ArrowRight") { event.preventDefault(); goTo(activePhoto + 1, true); }
      if (event.key === "ArrowLeft") { event.preventDefault(); goTo(activePhoto - 1, true); }
    });

    track.addEventListener("click", () => openLightbox(activePhoto));
    const zoom = $("#pdpZoom");
    if (zoom) zoom.addEventListener("click", event => { event.stopPropagation(); openLightbox(activePhoto); });

    if (activePhoto) goTo(activePhoto, false);
  }

  function paintGalleryState() {
    const counter = $("#pdpCounter");
    if (counter) counter.textContent = `${activePhoto + 1} / ${photos.length}`;
    $$("[data-thumb]").forEach(btn => {
      const on = Number(btn.dataset.thumb) === activePhoto;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-current", String(on));
    });
    $$("[data-dot]").forEach(btn =>
      btn.classList.toggle("active", Number(btn.dataset.dot) === activePhoto));
  }

  /* ---------- lightbox ---------- */
  function openLightbox(index) {
    if (!photos.length) return;
    activePhoto = Math.max(0, Math.min(photos.length - 1, index));
    const box = $("#pdpLightbox");
    paintLightbox();
    box.hidden = false;
    document.body.classList.add("pdp-lightbox-open");
  }
  function closeLightbox() {
    $("#pdpLightbox").hidden = true;
    document.body.classList.remove("pdp-lightbox-open");
    lightboxZoomed = false;
  }
  function paintLightbox() {
    const stage = $("#plbStage");
    stage.innerHTML = K.pictureHTML(photos[activePhoto], {
      alt: `${product.name} — ${angleLabel(activePhoto)} full screen`,
      sizes: "100vw",
      eager: true,
      className: "plb-img"
    });
    stage.classList.toggle("zoomed", lightboxZoomed);
    $("#plbCounter").textContent =
      `${activePhoto + 1} / ${photos.length} · ${angleLabel(activePhoto)} — tap photo to ${lightboxZoomed ? "fit" : "zoom"}`;
    paintGalleryState();
  }

  $("#plbClose").addEventListener("click", closeLightbox);
  $("#pdpLightbox").addEventListener("click", event => {
    if (event.target === $("#pdpLightbox")) closeLightbox();
  });
  $("#plbPrev").addEventListener("click", event => {
    event.stopPropagation();
    activePhoto = (activePhoto - 1 + photos.length) % photos.length;
    lightboxZoomed = false;
    paintLightbox();
  });
  $("#plbNext").addEventListener("click", event => {
    event.stopPropagation();
    activePhoto = (activePhoto + 1) % photos.length;
    lightboxZoomed = false;
    paintLightbox();
  });
  $("#plbStage").addEventListener("click", () => {
    lightboxZoomed = !lightboxZoomed;
    paintLightbox();
  });
  window.addEventListener("keydown", event => {
    if ($("#pdpLightbox").hidden) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowRight") { activePhoto = (activePhoto + 1) % photos.length; paintLightbox(); }
    if (event.key === "ArrowLeft") { activePhoto = (activePhoto - 1 + photos.length) % photos.length; paintLightbox(); }
  });

  /* ============================================================
     RENDER — MIDDLE COLUMN: SPECS & STORYTELLING
     ============================================================ */
  function measurementsCard() {
    const rows = K.measurementRows(product);
    const note = K.measurementNote(product);
    if (!rows.length) {
      return `
        <div class="measurements-card empty">
          <h4>Exact Flat-Lay Measurements</h4>
          <p>Measurements for this piece are not logged yet. Message us on WhatsApp and a staff member will measure it flat and send the exact numbers within minutes.</p>
        </div>`;
    }
    return `
      <div class="measurements-card">
        <div class="measurements-head">
          <h4>Exact Flat-Lay Measurements</h4>
          <div class="unit-toggle" role="group" aria-label="Measurement units">
            <button type="button" class="${unit === "in" ? "active" : ""}" data-unit="in">inches</button>
            <button type="button" class="${unit === "cm" ? "active" : ""}" data-unit="cm">cm</button>
          </div>
        </div>
        <p class="measurements-intro">Tagged sizes vary by decade and country of manufacture. Measure a garment you already own flat, then compare these numbers.</p>
        <div class="measurements-grid">
          ${rows.map(row => `
            <div class="measure-row">
              <span class="measure-k">${esc(row.label)}</span>
              <span class="measure-v">${unit === "in" ? row.inches.toFixed(1) + " in" : row.cm.toFixed(1) + " cm"}</span>
            </div>`).join("")}
        </div>
        ${note ? `<p class="measurements-note">${esc(note)}</p>` : ""}
        <p class="measurements-foot">All measurements are taken flat, by hand, on this exact piece. Allow ±0.5 in for fabric give.</p>
      </div>`;
  }

  function renderDetail() {
    const grade = K.gradeFor(product);
    const stock = K.stockState(product);
    const price = K.displayPrice(product);
    const compare = Number(product.compare_price || 0);
    const discount = K.discountPercent(product);
    const flaw = K.flawDisclosure(product);
    const fabric = String(product.fabric || "").trim();
    const care = String(product.care_notes || "").trim();
    const story = String(product.desc || "").trim();
    const staffNote = String(product.staff_notes || "").trim();
    const size = product.size && product.size !== "-" ? product.size : "Standard";

    $("#pdpDetail").innerHTML = `
      <p class="pdp-eyebrow">${esc(product.brand || "Vintage / Unbranded")}</p>
      <h1 class="pdp-title">${esc(product.name)}</h1>

      <div class="pdp-identity">
        <span class="pdp-sku" title="Unique stock keeping unit">SKU ${esc(product.sku || product.barcode_id || product.id)}</span>
        <span class="pdp-grade-badge" style="--grade:${grade.color};--grade-tint:${grade.tint}">
          <i aria-hidden="true"></i>${esc(grade.label)}
        </span>
      </div>
      <p class="pdp-grade-blurb">${esc(grade.blurb)}</p>

      <div class="pdp-price-block">
        <span class="pdp-price">${K.ugx(price)}</span>
        ${compare > price ? `
          <span class="pdp-compare">${K.ugx(compare)}</span>
          <span class="pdp-save">Save ${discount}%</span>` : ""}
        <span class="pdp-price-note">Price in Ugandan Shillings · transport split 50/50 at checkout</span>
      </div>

      <dl class="pdp-highlights">
        <div><dt>Tagged size</dt><dd>${esc(size)}</dd></div>
        <div><dt>Colour / wash</dt><dd>${esc(product.color || "As photographed")}</dd></div>
        <div><dt>Category</dt><dd>${esc(product.category || "—")}</dd></div>
        <div><dt>Fits</dt><dd>${esc(product.demographic || "Unisex")}</dd></div>
        ${fabric ? `<div><dt>Fabric composition</dt><dd>${esc(fabric)}</dd></div>` : ""}
        <div><dt>Availability</dt><dd>${esc(stock.label)}</dd></div>
      </dl>

      ${measurementsCard()}

      ${flaw.hasFlaws ? `
        <div class="flaw-callout" id="flawCallout">
          <div class="flaw-head">
            <span class="flaw-icon" aria-hidden="true">⚠️</span>
            <h4>Condition notes — please read before ordering</h4>
          </div>
          <p>${esc(flaw.notes)}</p>
          ${flaw.photoIndex >= 0 && photos[flaw.photoIndex]
            ? `<button class="flaw-photo-link" type="button" data-flaw-photo="${flaw.photoIndex}">View the close-up photo of this flaw →</button>`
            : ""}
        </div>` : `
        <div class="flaw-callout clean">
          <div class="flaw-head">
            <span class="flaw-icon" aria-hidden="true">✓</span>
            <h4>No flaws recorded</h4>
          </div>
          <p>Our intake team inspected this piece under daylight and logged no holes, stains, missing buttons or repairs.</p>
        </div>`}

      <div class="pdp-accordions">
        <details class="pdp-acc" open>
          <summary>Item description<span class="acc-sign" aria-hidden="true"></span></summary>
          <div class="pdp-acc-body">
            <p>${story ? esc(story) : "A hand-picked piece from our Kampala rail — laundered, pressed and photographed the day it landed."}</p>
            ${staffNote ? `<p class="pdp-store-note"><strong>Store note:</strong> ${esc(staffNote)}</p>` : ""}
            <ul class="pdp-bullets">
              <li>One-of-one stock: when this unit sells, the listing closes.</li>
              <li>Laundered and steamed before it reaches the rail.</li>
              <li>Rail reference ${esc(product.rack_location || "Rail A-1")} · barcode ${esc(product.barcode_id || product.sku || product.id)}.</li>
            </ul>
          </div>
        </details>

        <details class="pdp-acc"${flaw.hasFlaws ? " open" : ""}>
          <summary>Flaw &amp; condition details<span class="acc-sign" aria-hidden="true"></span></summary>
          <div class="pdp-acc-body">
            <p><strong>${esc(grade.label)}</strong> — ${esc(grade.blurb)}</p>
            ${flaw.hasFlaws
              ? `<p>${esc(flaw.notes)}</p>`
              : `<p>No flaws were recorded during intake inspection.</p>`}
            <p class="pdp-muted">Grading scale: BNWT (tags attached) · Grade A (like new) · Grade B (gentle wear) · Vintage (collector piece valued for its era).</p>
          </div>
        </details>

        <details class="pdp-acc">
          <summary>Care instructions<span class="acc-sign" aria-hidden="true"></span></summary>
          <div class="pdp-acc-body">
            <p>${care ? esc(care) : "Wash cold, inside out, and line dry in shade to protect the fabric and colour."}</p>
            ${fabric ? `<p class="pdp-muted">Fabric: ${esc(fabric)}</p>` : ""}
          </div>
        </details>

        <details class="pdp-acc">
          <summary>Delivery, pickup &amp; returns<span class="acc-sign" aria-hidden="true"></span></summary>
          <div class="pdp-acc-body">
            <ul class="pdp-bullets">
              <li><strong>Central Region (Kampala, Wakiso, Mukono):</strong> same-day or next-day door delivery by boda courier.</li>
              <li><strong>Up-country hubs (Mbarara, Jinja, Gulu, Arua, Masaka, Mbale):</strong> 24–48 hour parcel transit via regional bus terminals or express couriers.</li>
              <li><strong>Self-pickup:</strong> collect free at ${esc(settings.address || "our Kampala store")}.</li>
              <li>Returns or exchanges honored within 2 days with a valid receipt.</li>
            </ul>
          </div>
        </details>
      </div>`;

    $$("[data-unit]").forEach(btn => btn.addEventListener("click", () => {
      unit = btn.dataset.unit;
      localStorage.setItem("adonai-measure-unit", unit);
      renderDetail();
    }));

    const flawLink = $("[data-flaw-photo]");
    if (flawLink) {
      flawLink.addEventListener("click", () => openLightbox(Number(flawLink.dataset.flawPhoto)));
    }
  }

  /* ============================================================
     RENDER — RIGHT COLUMN: STICKY BUY BOX
     ============================================================ */
  function renderBuyBox() {
    const stock = K.stockState(product);
    const price = K.displayPrice(product);
    const estimate = K.deliveryEstimate(zone, settings);
    const waLink = stock.sold
      ? K.enquiryWhatsAppLink(product, settings)
      : K.generateWhatsAppLink(product, settings, { zone });

    $("#pdpBuyBox").innerHTML = `
      <div class="pdp-buybox">
        <div class="buybox-price-row">
          <span class="buybox-price">${K.ugx(price)}</span>
          ${product.compare_price > price ? `<span class="buybox-compare">${K.ugx(product.compare_price)}</span>` : ""}
        </div>

        <p class="buybox-stock ${stock.tone}">
          <span class="dot" aria-hidden="true"></span>${esc(stock.label)}
        </p>
        <p class="buybox-stock-detail">${esc(stock.detail)}</p>

        <div class="buybox-actions">
          <button class="pdp-btn primary block" id="buyCart" type="button" ${stock.sold ? "disabled" : ""}>
            ${stock.sold ? "Sold — no longer available" : "Add to Cart"}
          </button>
          <a class="pdp-btn whatsapp block ${stock.sold ? "muted" : ""}" id="buyWhatsApp" href="${esc(waLink)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Z"/><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.6-2.1-.2-.3 0-.4.1-.6l.5-.5c.1-.2.2-.3.3-.5 0-.2 0-.4-.1-.5 0-.2-.7-1.6-.9-2.2-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5 4.4.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.2-.6-.3Z"/></svg>
            ${stock.sold ? "Ask for something similar" : "Order via WhatsApp"}
          </a>
        </div>

        <div class="buybox-delivery">
          <label class="buybox-label" for="zoneSelect">Where should we deliver?</label>
          <select id="zoneSelect" class="buybox-select">
            ${K.DELIVERY_ZONES.map(z =>
              `<option value="${z.id}" ${z.id === zone ? "selected" : ""}>${esc(z.name)}</option>`).join("")}
          </select>
          <div class="delivery-estimate">
            <div class="de-row"><span>Estimated arrival</span><strong>${esc(estimate.eta)}</strong></div>
            <div class="de-row"><span>Method</span><strong>${esc(estimate.mode)}</strong></div>
            <div class="de-row"><span>Delivery cost</span><strong>${esc(estimate.fee)}</strong></div>
            <p class="de-hubs">${esc(estimate.hubs)}</p>
          </div>
        </div>

        <div class="buybox-trust">
          <p class="buybox-label">Pay on delivery or pickup</p>
          <div class="pay-icons">
            ${K.PAYMENT_METHODS.map(method => `
              <span class="pay-chip" style="--pay:${method.color};--pay-ink:${method.ink}">${esc(method.label)}</span>`).join("")}
          </div>
          <ul class="trust-list">
            <li>✓ Inspect the piece before you pay</li>
            <li>✓ 2-day returns with a valid receipt</li>
            <li>✓ Real-time WhatsApp rider tracking</li>
          </ul>
        </div>
      </div>`;

    const cartBtn = $("#buyCart");
    if (cartBtn) cartBtn.addEventListener("click", addToCart);
    const zoneSelect = $("#zoneSelect");
    if (zoneSelect) zoneSelect.addEventListener("change", event => {
      zone = event.target.value;
      localStorage.setItem("adonai-delivery-zone", zone);
      renderBuyBox();
    });
  }

  /* ============================================================
     RENDER — MOBILE FIXED ACTION BAR
     ============================================================ */
  function renderActionBar() {
    const stock = K.stockState(product);
    const bar = $("#pdpActionBar");
    bar.hidden = false;
    $("#pabPrice").textContent = K.ugx(K.displayPrice(product));
    $("#pabStock").textContent = stock.label;
    $("#pabStock").className = `pab-stock ${stock.tone}`;

    const cartBtn = $("#pabCart");
    cartBtn.disabled = stock.sold;
    cartBtn.textContent = stock.sold ? "Sold Out" : "Add to Cart";

    const wa = $("#pabWhatsApp");
    wa.href = stock.sold
      ? K.enquiryWhatsAppLink(product, settings)
      : K.generateWhatsAppLink(product, settings, { zone });
  }

  /* ============================================================
     RENDER — RELATED PIECES
     ============================================================ */
  function renderRelated() {
    const all = DB.listProducts().filter(p => p.id !== product.id && p.in_stock_count > 0);
    const sameCategory = all.filter(p => p.category === product.category);
    const list = (sameCategory.length >= 2 ? sameCategory : all).slice(0, 4);
    if (!list.length) return;

    $("#pdpRelatedGrid").innerHTML = list.map(item => {
      const image = K.productImages(item)[0];
      const grade = K.gradeFor(item);
      return `
        <a class="rel-card" href="${esc(K.productPath(item))}">
          <div class="rel-media">
            ${image
              ? K.pictureHTML(image, { alt: item.name, sizes: "(min-width: 1024px) 220px, 45vw", width: 400, height: 500 })
              : `<span class="rel-noimg">No photo</span>`}
            <span class="rel-grade" style="--grade:${grade.color}">${esc(grade.short)}</span>
          </div>
          <p class="rel-name">${esc(item.name)}</p>
          <p class="rel-meta">${esc(item.size && item.size !== "-" ? "Size " + item.size : "One size")} · ${esc(item.brand || "Vintage")}</p>
          <p class="rel-price">${K.ugx(K.displayPrice(item))}</p>
        </a>`;
    }).join("");
    $("#pdpRelated").hidden = false;
  }

  /* ============================================================
     STORE PROFILE (footer + live System Parameters)
     ============================================================ */
  function renderStoreProfile() {
    settings = DB.getSettings();
    const whatsapp = K.storeWhatsAppNumber(settings);
    const address = settings.address || "Kampala, Uganda";
    const tagline = $("#footTagline");
    if (tagline) tagline.textContent = settings.tagline || "Curated pre-loved vintage";
    const loc = $("#footLoc");
    if (loc) loc.textContent = address.split(",")[0];
    const contact = $("#footContactList");
    if (contact) {
      contact.innerHTML = `
        <li><span class="k">WhatsApp:</span> <a class="rust" href="https://wa.me/${esc(whatsapp)}" target="_blank" rel="noopener">${esc(settings.whatsapp_display || "+" + whatsapp)}</a></li>
        <li><span class="k">Hotline:</span> <a href="tel:${esc(String(settings.hotline || "").replace(/\s/g, ""))}">${esc(settings.hotline || "")}</a></li>
        <li><span class="k">Location:</span> ${esc(address)}</li>
        <li><span class="k">Hours:</span> ${esc(settings.hours || "")}</li>`;
    }
    const copyright = $("#footCopyright");
    if (copyright) {
      copyright.textContent = `© 2026 ${settings.store_name || "Adonai Thrift Store"} · All prices in Ugandan Shillings (UGX)`;
    }
    const missingWa = $("#missingWhatsApp");
    if (missingWa) missingWa.href = K.enquiryWhatsAppLink(null, settings);
  }

  /* ============================================================
     PRODUCT RESOLUTION & BOOT
     ============================================================ */
  function matchesRequest(candidate) {
    if (!candidate || !requestedSlug) return false;
    const needle = requestedSlug.toLowerCase();
    return [candidate.slug, candidate.id, candidate.sku, candidate.barcode_id, K.productSlug(candidate)]
      .filter(Boolean)
      .some(value => String(value).toLowerCase() === needle);
  }

  function resolveFromLocalCatalog() {
    const catalog = DB.listProducts();
    return catalog.find(matchesRequest) || null;
  }

  async function resolveFromApi() {
    if (!requestedSlug) return null;
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(requestedSlug)}`, { cache: "no-store" });
      if (!response.ok) return null;
      const data = await response.json();
      return data && data.product ? data.product : null;
    } catch (error) {
      return null;
    }
  }

  function showMissing() {
    $("#pdpSkeleton").hidden = true;
    $("#pdpGrid").hidden = true;
    $("#pdpActionBar").hidden = true;
    $("#pdpMissing").hidden = false;
    document.title = "Piece no longer available | Adonai Thrift Store";
  }

  function renderAll() {
    if (!product) return showMissing();
    photos = K.productImages(product);
    if (activePhoto >= photos.length) activePhoto = 0;

    // Keep the tab title in step with the piece even when the page was served
    // from the generic shell (client-side resolve or a live price change).
    document.title = `${product.name} — ${K.ugx(K.displayPrice(product))} | Adonai Thrift Store Kampala`;

    $("#pdpSkeleton").hidden = true;
    $("#pdpMissing").hidden = true;
    $("#pdpGrid").hidden = false;
    document.body.classList.toggle("is-sold-piece", K.stockState(product).sold);

    renderCrumbs();
    renderMedia();
    renderDetail();
    renderBuyBox();
    renderActionBar();
    renderRelated();
  }

  async function boot() {
    renderStoreProfile();
    paintCartCount();

    if (!product) product = resolveFromLocalCatalog();
    if (product) renderAll();

    if (!product) {
      const remote = await resolveFromApi();
      if (remote) {
        product = remote;
        renderAll();
      } else {
        // The catalog may still be syncing on a cold load — give it one beat.
        setTimeout(() => {
          product = product || resolveFromLocalCatalog();
          if (product) renderAll();
          else showMissing();
        }, 1200);
      }
    }

    if (product && window.AdonaiAnalytics) window.AdonaiAnalytics.trackViewItem(product);
  }

  /* ---------- live sync: stock, price and store settings ---------- */
  DB.on("products", () => {
    if (!product) {
      const found = resolveFromLocalCatalog();
      if (found) { product = found; renderAll(); }
      return;
    }
    const fresh = DB.getProduct(product.id);
    if (!fresh) return;
    const wasAvailable = K.stockState(product).count > 0;
    const stillAvailable = K.stockState(fresh).count > 0;
    product = fresh;
    renderAll();
    if (wasAvailable && !stillAvailable) {
      toast("This piece just sold in the shop — pieces move fast");
    }
  });

  DB.on("settings", () => {
    renderStoreProfile();
    if (product) { renderBuyBox(); renderActionBar(); renderDetail(); }
  });

  /* ---------- action bar + confirmation wiring ---------- */
  $("#pabCart").addEventListener("click", addToCart);
  $("#pdpAddedClose").addEventListener("click", () => { $("#pdpAdded").hidden = true; });
  $("#pdpAdded").addEventListener("click", event => {
    if (event.target === $("#pdpAdded")) $("#pdpAdded").hidden = true;
  });

  boot();
})();
