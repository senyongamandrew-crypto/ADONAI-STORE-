/* ============================================================
   ADONAI THRIFT STORE — PRODUCT DETAIL PAGE (PDP) CONTROLLER
   Route: /product/<slug>

   Desktop (≥1024px): 45% media gallery · 30% specs · 25% sticky buy box
   Mobile  (≤1023px): swipeable carousel → pricing → badges → accordions
                      → fixed bottom action bar (one order path: the cart)
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
  // Intake maps photos to the category's angle protocol ("Macro front
  // face", "Outsole tread"…); captions fall back to Cover / Photo N.
  function angleLabel(index) {
    const mapped = product && product.photo_angle_labels && product.photo_angle_labels[String(index)];
    if (mapped) return index === 0 ? `Cover · ${mapped}` : mapped;
    return index === 0 ? "Cover" : `Photo ${index + 1}`;
  }
  const garmentVideo = () => product && product.video && product.video.url ? product.video : null;
  const galleryCount = () => photos.length + (garmentVideo() ? 1 : 0);
  const videoTime = () => `0:${String(Math.round(Number((garmentVideo() || {}).duration) || 0)).padStart(2, "0")}`;
  let galleryGoTo = null, lastMediaSignature = "";

  function renderMedia() {
    const oldVideo = $("#pdpGarmentVideo"); if (oldVideo) oldVideo.pause();
    const stock = K.stockState(product), flaw = K.flawDisclosure(product);
    const discount = K.discountPercent(product), grade = K.gradeFor(product);
    const video = garmentVideo(), total = galleryCount();
    if (!total) {
      galleryGoTo = null;
      $("#pdpMedia").innerHTML = `<div class="pdp-media-sticky"><div class="pdp-stage empty"><span>Photos coming shortly — ask us on WhatsApp for live pictures.</span></div></div>`;
      return;
    }
    let thumbs = photos.map((src, i) => `
      <button class="pdp-thumb ${flaw.photoIndex === i ? "is-flaw" : ""}" data-thumb="${i}" type="button" aria-label="${flaw.photoIndex === i ? "View the close-up photo of the flaw" : `View ${esc(angleLabel(i))}`}" aria-current="${i === activePhoto}">
        ${K.pictureHTML(src, { alt: `${product.name} — ${angleLabel(i)}`, sizes: "72px", width: 72, height: 90 })}
        <span class="pdp-thumb-tag">${flaw.photoIndex === i ? "⚠️ Flaw" : esc(angleLabel(i))}</span>
      </button>`).join("");
    let slides = photos.map((src, i) => `<figure class="pdp-slide" data-slide="${i}">${K.pictureHTML(src, { alt: `${product.name} — ${angleLabel(i)}`, sizes: "(min-width: 1024px) 45vw, 100vw", eager: i === 0, className: "pdp-slide-img" })}</figure>`).join("");
    if (video) {
      thumbs += `<button class="pdp-thumb pdp-video-thumb" data-thumb="${photos.length}" data-video-thumb type="button" aria-label="Watch garment video, ${videoTime()}" aria-current="${activePhoto === photos.length}"><span class="pdp-video-thumb-cover">${photos[0] ? K.pictureHTML(photos[0], { alt: "", sizes: "72px", width: 72, height: 90 }) : ""}<span class="pdp-video-play"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l12-7z"/></svg></span></span><span class="pdp-thumb-tag">Video</span></button>`;
      // Deliberately no src until the shopper selects the video. No autoplay.
      slides += `<figure class="pdp-slide pdp-slide-video" data-slide="${photos.length}"><video id="pdpGarmentVideo" data-video-src="${esc(K.resolveSrc(video.url))}" ${photos[0] ? `poster="${esc(K.resolveSrc(photos[0]))}"` : ""} controls playsinline preload="none" aria-label="${esc(product.name)} garment video"></video><span class="pdp-video-error" id="pdpVideoError" role="status" hidden>Video could not load. Check your connection and try again.<button type="button" id="pdpVideoRetry">Retry video</button></span></figure>`;
    }
    $("#pdpMedia").innerHTML = `
      <div class="pdp-media-sticky">
        <div class="pdp-gallery ${stock.sold ? "is-sold" : ""}">
          <div class="pdp-thumbrail" id="pdpThumbRail" aria-label="Garment photos and video">${thumbs}</div>
          <div class="pdp-stage-wrap">
            <div class="pdp-stage-badges"><span class="pdp-grade-chip" style="--grade:${grade.color};--grade-tint:${grade.tint}">${esc(grade.short)}</span>${discount > 0 ? `<span class="pdp-disc-chip">-${discount}%</span>` : ""}</div>
            ${stock.sold ? `<div class="pdp-sold-overlay"><span>SOLD OUT</span></div>` : ""}
            <div class="pdp-stage-track" id="pdpTrack" tabindex="0" aria-label="Swipe through garment photos and video">${slides}</div>
            ${total > 1 ? `<button class="pdp-stage-nav prev" id="pdpPrev" type="button" aria-label="Previous garment view">‹</button><button class="pdp-stage-nav next" id="pdpNext" type="button" aria-label="Next garment view">›</button>` : ""}
            <button class="pdp-zoom-btn" id="pdpZoom" type="button" aria-label="Open full screen photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2M11 8v6M8 11h6"/></svg>Zoom</button>
            <span class="pdp-counter" id="pdpCounter"></span>
          </div>
        </div>
        ${total > 1 ? `<div class="pdp-dots" id="pdpDots">${Array.from({length: total}, (_, i) => `<button class="pdp-dot" data-dot="${i}" type="button" aria-label="${i === photos.length ? "Garment video" : `Photo ${i + 1}`}"></button>`).join("")}</div>` : ""}
        <p class="pdp-media-note">📷 The exact piece you receive${video ? ` · ▶ ${videoTime()} garment video — tap Video to watch` : " — real garment photos"}.</p>
      </div>`;
    if (K.settleImages) K.settleImages($("#pdpMedia"));
    bindGallery();
  }

  function bindGallery() {
    const track = $("#pdpTrack"); if (!track) return;
    const goTo = (index, smooth) => {
      activePhoto = Math.max(0, Math.min(galleryCount() - 1, index));
      const left = track.clientWidth * activePhoto;
      if (typeof track.scrollTo === "function") {
        try { track.scrollTo({ left, behavior: smooth ? "smooth" : "auto" }); }
        catch (_) { track.scrollLeft = left; }
      } else track.scrollLeft = left;
      paintGalleryState();
    };
    galleryGoTo = goTo;
    $$("[data-thumb]").forEach(btn => btn.addEventListener("click", () => goTo(Number(btn.dataset.thumb), true)));
    $$("[data-dot]").forEach(btn => btn.addEventListener("click", () => goTo(Number(btn.dataset.dot), true)));
    const prev = $("#pdpPrev"), next = $("#pdpNext");
    if (prev) prev.addEventListener("click", () => goTo((activePhoto - 1 + galleryCount()) % galleryCount(), true));
    if (next) next.addEventListener("click", () => goTo((activePhoto + 1) % galleryCount(), true));
    let scrollTimer;
    track.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const index = Math.max(0, Math.min(galleryCount() - 1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
        if (index !== activePhoto) { activePhoto = index; paintGalleryState(); }
      }, 100);
    }, { passive: true });
    track.addEventListener("keydown", event => {
      if (event.target.tagName === "VIDEO") return; // retain native video seek/volume keys
      if (event.key === "ArrowRight") { event.preventDefault(); goTo(activePhoto + 1, true); }
      if (event.key === "ArrowLeft") { event.preventDefault(); goTo(activePhoto - 1, true); }
    });
    track.addEventListener("click", event => {
      if (!event.target.closest(".pdp-slide-video") && activePhoto < photos.length) openLightbox(activePhoto);
    });
    $("#pdpZoom").addEventListener("click", event => { event.stopPropagation(); if (activePhoto < photos.length) openLightbox(activePhoto); });
    const video = $("#pdpGarmentVideo");
    if (video) {
      video.addEventListener("error", () => { $("#pdpVideoError").hidden = false; });
      $("#pdpVideoRetry").addEventListener("click", event => { event.stopPropagation(); $("#pdpVideoError").hidden = true; video.load(); });
    }
    goTo(activePhoto, false);
  }

  function paintGalleryState() {
    const isVideo = !!garmentVideo() && activePhoto === photos.length;
    const counter = $("#pdpCounter");
    if (counter) counter.textContent = isVideo ? `Video · ${videoTime()}` : `${activePhoto + 1} / ${galleryCount()}`;
    const zoom = $("#pdpZoom"); if (zoom) zoom.hidden = isVideo;
    const wrap = $(".pdp-stage-wrap", $("#pdpMedia")); if (wrap) wrap.classList.toggle("is-video", isVideo);
    $$("[data-thumb]").forEach(btn => {
      const on = Number(btn.dataset.thumb) === activePhoto;
      btn.classList.toggle("active", on); btn.setAttribute("aria-current", String(on));
    });
    $$("[data-dot]").forEach(btn => {
      const on = Number(btn.dataset.dot) === activePhoto;
      btn.classList.toggle("active", on); btn.setAttribute("aria-current", String(on));
    });
    const video = $("#pdpGarmentVideo");
    if (video) {
      if (isVideo && !video.getAttribute("src")) { video.src = video.dataset.videoSrc; video.load(); }
      if (!isVideo) video.pause();
    }
  }

  window.addEventListener("resize", () => { if (galleryGoTo) galleryGoTo(activePhoto, false); }, { passive: true });
  document.addEventListener("visibilitychange", () => { const video = $("#pdpGarmentVideo"); if (document.hidden && video) video.pause(); });
  window.addEventListener("pagehide", () => { const video = $("#pdpGarmentVideo"); if (video) video.pause(); });

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
    if (galleryGoTo) galleryGoTo(activePhoto, false);
  }
  function paintLightbox() {
    const stage = $("#plbStage");
    stage.innerHTML = K.pictureHTML(photos[activePhoto], {
      alt: `${product.name} — ${angleLabel(activePhoto)} full screen`,
      sizes: "100vw",
      eager: true,
      className: "plb-img"
    });
    if (K.settleImages) K.settleImages(stage);
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
  /* Category specifications captured on the dynamic intake schema
     (category_field_schemas): grouped by section, units included. */
  function specificationRows() {
    return (Array.isArray(product.specifications) ? product.specifications : []).filter(row => row && row.label && row.value);
  }

  function specificationsCard() {
    const rows = specificationRows().filter(row => !String(row.key || "").startsWith("inspection."));
    if (!rows.length) return "";
    const sections = [];
    rows.forEach(row => {
      let group = sections.find(entry => entry.title === row.section);
      if (!group) sections.push(group = { title: row.section, rows: [] });
      group.rows.push(row);
    });
    return `
      <div class="pdp-specs-card" id="pdpSpecs">
        <h4>Specifications${product.subcategory ? ` · ${esc(product.subcategory)}` : ""}</h4>
        ${sections.map(group => `
          <div class="pdp-specs-group">
            ${group.title ? `<p class="pdp-specs-title">${esc(group.title)}</p>` : ""}
            <dl class="pdp-specs-grid">
              ${group.rows.map(row => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("")}
            </dl>
          </div>`).join("")}
        <p class="measurements-foot">Measured and recorded by hand on this exact piece at intake.</p>
      </div>`;
  }

  function inspectionList() {
    const rows = specificationRows().filter(row => String(row.key || "").startsWith("inspection."));
    return rows.length ? `<ul class="pdp-bullets pdp-inspection">${rows.map(row => `<li><strong>${esc(row.label)}:</strong> ${esc(row.value)}</li>`).join("")}</ul>` : "";
  }

  function measurementsCard() {
    const rows = K.measurementRows(product);
    // A piece with no logged measurements simply has no measurements card.
    // The old empty panel asked the shopper to message us on WhatsApp for
    // numbers that were not on the page, so it is not shown at all.
    if (!rows.length) return "";
    const note = K.measurementNote(product);
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
    const hasSpecs = specificationRows().length > 0;
    const fulfillment = String(product.fulfillment_notes || "").trim();
    const categoryLabel = [product.category, product.subcategory].filter(Boolean).join(" · ");
    const stockType = product.is_consignment
      ? "Partner · Vintage"
      : product.item_condition === "BRAND_NEW" ? "Brand New" : "Vintage / Pre-Loved";

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
        <span class="pdp-price-note">Price in Ugandan Shillings · delivery arranged at checkout</span>
      </div>

      <dl class="pdp-highlights">
        ${size !== "Standard" || !hasSpecs ? `<div><dt>Tagged size</dt><dd>${esc(size)}</dd></div>` : ""}
        <div><dt>Colour / wash</dt><dd>${esc(product.color || "As photographed")}</dd></div>
        <div><dt>Category</dt><dd>${esc(categoryLabel || "—")}</dd></div>
        <div><dt>Stock type</dt><dd>${esc(stockType)}</dd></div>
        <div><dt>Fits</dt><dd>${esc(product.demographic || "Unisex")}</dd></div>
        ${fabric ? `<div><dt>${hasSpecs ? "Material" : "Fabric composition"}</dt><dd>${esc(fabric)}</dd></div>` : ""}
        <div><dt>Availability</dt><dd>${esc(stock.label)}</dd></div>
      </dl>

      ${specificationsCard()}

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
            ${inspectionList()}
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
            ${fulfillment ? `<p class="pdp-store-note"><strong>For this item:</strong> ${esc(fulfillment)}</p>` : ""}
            <ul class="pdp-bullets">
              <li><strong>Central Region (Kampala, Wakiso, Mukono):</strong> delivery is targeted for the same day when your order is confirmed by 4:00 PM; later orders target the next available delivery day.</li>
              <li><strong>Regional Uganda:</strong> dispatch is targeted within one business day after confirmation, with 1–3 business days transit to major towns; remote routes may take longer and are confirmed before dispatch.</li>
              <li><strong>Self-pickup:</strong> collect free at ${esc(settings.address || "Plot 45 Salama Road / Kibuli, Kampala")}; wait for our ready-to-collect confirmation.</li>
              <li>Request a return within 48 hours for defective or incorrectly graded items. <a href="/return-policy">Read the 2-day return policy.</a></li>
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
  /* Ways to pay the store can actually honour, straight from the server's
     channel engine. Until it answers, the row falls back to the basics. */
  let paymentChannels = null;
  let payLabel = "Pay on delivery or pickup";
  function loadPaymentChannels() {
    if (typeof DB === "undefined" || !DB.getPaymentConfig) return;
    DB.getPaymentConfig().then(config => {
      const available = (config && config.channels || []).filter(c => c.available !== false).map(c => c.id);
      if (!available.length) return;
      paymentChannels = available;
      payLabel = available.indexOf("cod") === -1
        ? "Pay securely at checkout"
        : "Pay now, or on delivery / pickup";
      if (product) renderBuyBox();
    }).catch(() => {});
  }

  function renderBuyBox() {
    const stock = K.stockState(product);
    const price = K.displayPrice(product);
    const estimate = K.deliveryEstimate(zone, settings);
    /* Ordering has exactly ONE path: Add to Cart → checkout → the order is
       written to the database, reserves the piece and appears in the POS.
       The previous "Order via WhatsApp" button next to it wrote nothing at
       all — no order, no stock reservation — so a one-of-one piece could be
       promised to two shoppers at once and the sale would only exist once a
       staff member re-typed it. WhatsApp is kept only where it is NOT an
       order: a piece that is gone (sourcing a similar one) and a question
       about measurements that were never logged. */
    const waEnquiry = K.enquiryWhatsAppLink(product, settings);

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
          ${stock.sold ? `
          <a class="pdp-btn outline block" id="buyEnquiry" href="${esc(waEnquiry)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Z"/><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.6-2.1-.2-.3 0-.4.1-.6l.5-.5c.1-.2.2-.3.3-.5 0-.2 0-.4-.1-.5 0-.2-.7-1.6-.9-2.2-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5 4.4.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.2-.6-.3Z"/></svg>
            Ask for something similar
          </a>` : ""}
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
          <p class="buybox-label">${esc(payLabel)}</p>
          <div class="pay-icons">
            ${K.paymentChips(paymentChannels).map(method => `
              <span class="pay-chip" style="--pay:${method.color};--pay-ink:${method.ink}">${esc(method.label)}</span>`).join("")}
          </div>
          <ul class="trust-list">
            <li>✓ Inspect the piece before you pay</li>
            <li>✓ <a href="/return-policy">48-hour defect / grading return policy</a></li>
            <li>✓ Delivery updates on WhatsApp</li>
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

    /* WhatsApp appears in this bar only for a sold piece, where there is no
       order left to place. It is never a second "order" button competing
       with the cart on a piece a shopper can actually buy. */
    const wa = $("#pabWhatsApp");
    if (wa) {
      wa.hidden = !stock.sold;
      if (stock.sold) wa.href = K.enquiryWhatsAppLink(product, settings);
    }
    const barButtons = bar.querySelector(".pdp-actionbar-btns");
    if (barButtons) barButtons.classList.toggle("single", !stock.sold);
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
      return `
        <a class="rel-card" href="${esc(K.productPath(item))}">
          <div class="rel-media">
            ${image
              ? K.pictureHTML(image, { alt: item.name, sizes: "(min-width: 1024px) 220px, 45vw", width: 400, height: 500 })
              : `<span class="rel-noimg">No photo</span>`}
          </div>
          <p class="rel-name">${esc(item.name)}</p>
          <p class="rel-meta">${esc(item.size && item.size !== "-" ? "Size " + item.size : "One size")} · ${esc(item.brand || "Vintage")}</p>
          <p class="rel-price">${K.ugx(K.displayPrice(item))}</p>
        </a>`;
    }).join("");
    if (K.settleImages) K.settleImages($("#pdpRelatedGrid"));
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
      const email = K.storeEmail(settings);
      contact.innerHTML = `
        <li><span class="k">WhatsApp:</span> <a class="rust" href="https://wa.me/${esc(whatsapp)}" target="_blank" rel="noopener">${esc(settings.whatsapp_display || "+" + whatsapp)}</a></li>
        <li><span class="k">Hotline:</span> <a href="tel:${esc(String(settings.hotline || "").replace(/\s/g, ""))}">${esc(settings.hotline || "")}</a></li>
        <li><span class="k">Email:</span> <a href="mailto:${esc(email)}">${esc(email)}</a></li>
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
    if (activePhoto >= galleryCount()) activePhoto = 0;

    // Keep the tab title in step with the piece even when the page was served
    // from the generic shell (client-side resolve or a live price change).
    document.title = `${product.name} — ${K.ugx(K.displayPrice(product))} | Adonai Thrift Store Kampala`;

    $("#pdpSkeleton").hidden = true;
    $("#pdpMissing").hidden = true;
    $("#pdpGrid").hidden = false;
    document.body.classList.toggle("is-sold-piece", K.stockState(product).sold);

    renderCrumbs();
    // A routine catalog sync must not restart a shopper's playing video.
    const mediaSignature = JSON.stringify([photos, garmentVideo(), product.name, product.flaw_photo_index,
      K.stockState(product).sold, K.discountPercent(product), K.gradeFor(product).short]);
    if (mediaSignature !== lastMediaSignature) { renderMedia(); lastMediaSignature = mediaSignature; }
    renderDetail();
    renderBuyBox();
    renderActionBar();
    renderRelated();
  }

  async function boot() {
    renderStoreProfile();
    paintCartCount();
    loadPaymentChannels();

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
