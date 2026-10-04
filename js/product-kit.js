/* ============================================================
   ADONAI THRIFT STORE — SHARED PRODUCT PRESENTATION KIT
   One source of truth for everything that describes a 1-of-1
   thrift piece across the rail grid and the Product Detail Page:
     · condition grade badges (BNWT / A / B / Vintage)
     · exact flat-lay measurement engine (inches ⇄ cm)
     · permalink slugs for /product/<slug>
     · WhatsApp checkout deep links
     · Ugandan regional delivery estimates
     · responsive WebP <picture> markup (CLS-safe)
   Loaded by index.html and product.html; safe to load twice.
   ============================================================ */
(function (global) {
  "use strict";

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  /* ----------------------------------------------------------
     1. CONDITION & GRADE IDENTIFICATION SYSTEM
     Every piece renders a colour-coded badge. Colours are fixed
     by the design system and mirrored in css/product.css.
     ---------------------------------------------------------- */
  const GRADES = {
    bnwt: {
      key: "bnwt",
      label: "Brand New with Tags",
      short: "BNWT",
      color: "#059669",
      tint: "#ECFDF5",
      blurb: "Never worn. Original retail tags still attached."
    },
    a: {
      key: "a",
      label: "Grade A · Like New",
      short: "Grade A",
      color: "#2563EB",
      tint: "#EFF6FF",
      blurb: "Worn lightly with no visible flaws. Laundered and pressed."
    },
    b: {
      key: "b",
      label: "Grade B · Gentle Wear",
      short: "Grade B",
      color: "#D97706",
      tint: "#FFFBEB",
      blurb: "Honest, gentle wear. Every flaw is photographed and disclosed below."
    },
    vintage: {
      key: "vintage",
      label: "Vintage · Collector",
      short: "Vintage",
      color: "#7C3AED",
      tint: "#F5F3FF",
      blurb: "Genuine period piece valued for its era, cut and fabric."
    },
    unknown: {
      key: "unknown",
      label: "Pre-loved · Inspected",
      short: "Inspected",
      color: "#475569",
      tint: "#F1F5F9",
      blurb: "Hand-inspected, laundered and photographed in daylight."
    }
  };

  function gradeFor(product) {
    const raw = String((product && product.condition) || "").toLowerCase();
    if (/bnwt|brand\s*new|with\s*tags|deadstock/.test(raw)) return GRADES.bnwt;
    if (/grade\s*a|like\s*new|excellent/.test(raw)) return GRADES.a;
    if (/grade\s*b|gentle|good|fair/.test(raw)) return GRADES.b;
    if (/vintage|collector|retro/.test(raw)) return GRADES.vintage;
    return GRADES.unknown;
  }

  /* ----------------------------------------------------------
     2. EXACT FLAT-LAY MEASUREMENTS ENGINE
     Thrift sizing varies across global manufacturing standards
     and decades, so the tagged size (S/M/L/XL) is never enough.
     Values are stored in INCHES and converted on the fly.
     ---------------------------------------------------------- */
  const MEASUREMENT_FIELDS = [
    // Tops / jackets / dresses
    { key: "shoulder", label: "Shoulder Width", group: "top" },
    { key: "chest", label: "Chest (Pit-to-Pit)", group: "top" },
    { key: "sleeve", label: "Sleeve Length", group: "top" },
    { key: "length", label: "Total Length", group: "top" },
    // Pants / jeans / skirts
    { key: "waist", label: "Waist (Flat)", group: "bottom" },
    { key: "hip", label: "Hip Width", group: "bottom" },
    { key: "inseam", label: "Inseam Length", group: "bottom" },
    { key: "rise", label: "Rise", group: "bottom" },
    { key: "thigh", label: "Thigh Width", group: "bottom" },
    { key: "leg_opening", label: "Leg Opening", group: "bottom" },
    // Footwear
    { key: "insole", label: "Insole Length", group: "feet" },
    { key: "heel", label: "Heel Height", group: "feet" }
  ];

  const MEASUREMENT_GROUPS = {
    "Tops & Shirts": "top",
    "Outerwear & Jackets": "top",
    "Dresses & Skirts": "top",
    "Children Wear": "top",
    "Pants & Jeans": "bottom",
    Shoes: "feet",
    Accessories: "any"
  };

  const titleCase = key => String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  function measurementsOf(product) {
    const raw = product && product.measurements;
    if (!raw) return {};
    if (typeof raw === "string") {
      try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
    }
    return typeof raw === "object" ? raw : {};
  }

  /** Ordered, display-ready measurement rows with both unit systems. */
  function measurementRows(product) {
    const data = measurementsOf(product);
    const rows = [];
    const seen = new Set(["notes"]);
    MEASUREMENT_FIELDS.forEach(field => {
      const value = Number(data[field.key]);
      if (Number.isFinite(value) && value > 0) {
        rows.push({
          key: field.key,
          label: field.label,
          inches: value,
          cm: Math.round(value * 2.54 * 10) / 10
        });
      }
      seen.add(field.key);
    });
    // Staff may log uncommon specs (cuff, drop, strap…) without a migration.
    Object.keys(data).forEach(key => {
      if (seen.has(key)) return;
      const value = Number(data[key]);
      if (Number.isFinite(value) && value > 0) {
        rows.push({
          key,
          label: titleCase(key),
          inches: value,
          cm: Math.round(value * 2.54 * 10) / 10
        });
      }
    });
    return rows;
  }

  const measurementNote = product => String(measurementsOf(product).notes || "").trim();
  const hasMeasurements = product => measurementRows(product).length > 0;

  /** Which measurement fields staff should capture for this category. */
  function expectedMeasurementFields(category) {
    const group = MEASUREMENT_GROUPS[category] || "any";
    if (group === "any") return MEASUREMENT_FIELDS;
    return MEASUREMENT_FIELDS.filter(f => f.group === group);
  }

  /* ----------------------------------------------------------
     3. PERMALINKS — /product/<slug>
     ---------------------------------------------------------- */
  function slugify(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");
  }

  function productSlug(product) {
    if (!product) return "";
    if (product.slug) return String(product.slug);
    const name = slugify(product.name).slice(0, 120).replace(/-+$/, "");
    const tail = slugify(product.sku || product.id).slice(0, 40).replace(/-+$/, "");
    if (tail && !name.endsWith(tail)) return `${name}-${tail}`.replace(/^-+/, "");
    return name || tail || "thrift-piece";
  }

  const productPath = product => `/product/${productSlug(product)}`;

  function productUrl(product) {
    const origin = (global.location && global.location.origin && global.location.origin !== "null")
      ? global.location.origin
      : "https://adonai-store.onrender.com";
    return origin + productPath(product);
  }

  /* ----------------------------------------------------------
     4. PRICING HELPERS
     ---------------------------------------------------------- */
  const displayPrice = p => Number(p && (p.final_selling_price != null ? p.final_selling_price : p.selling_price)) || 0;

  const ugx = n => "UGX " + Math.round(Number(n) || 0).toLocaleString("en-UG");

  function discountPercent(product) {
    const original = Number((product && product.compare_price) || 0);
    const selling = displayPrice(product);
    return original > 0 && selling > 0 && selling < original
      ? Math.round(((original - selling) / original) * 100)
      : 0;
  }

  /** Single-unit inventory state: thrift stock is almost always 1-of-1. */
  function stockState(product) {
    const count = Math.max(0, Number((product && product.in_stock_count) || 0));
    if (count <= 0) {
      return { sold: true, count: 0, label: "SOLD OUT", tone: "sold",
        detail: "This piece has already found a home." };
    }
    if (count === 1) {
      return { sold: false, count: 1, label: "Only 1 Item Available", tone: "last",
        detail: "One-of-one piece — once it sells, it is gone for good." };
    }
    return { sold: false, count, label: `${count} Items Available`, tone: "in",
      detail: "Limited pieces on the rail." };
  }

  /* ----------------------------------------------------------
     5. FLAW & CONDITION DISCLOSURE
     ---------------------------------------------------------- */
  function flawDisclosure(product) {
    const notes = String((product && product.flaw_notes) || "").trim();
    const index = Number((product && product.flaw_photo_index));
    return {
      hasFlaws: notes.length > 0,
      notes,
      photoIndex: Number.isFinite(index) && index >= 0 ? index : -1
    };
  }

  /* ----------------------------------------------------------
     6. REGIONAL LOGISTICS — UGANDA DELIVERY ESTIMATOR
     ---------------------------------------------------------- */
  const DELIVERY_ZONES = [
    {
      id: "kampala",
      name: "Kampala Metro (Central)",
      hubs: "Kampala · Wakiso · Entebbe · Mukono",
      eta: "Same-day or next-day",
      mode: "Door delivery by boda courier",
      feeKind: "standard"
    },
    {
      id: "upcountry",
      name: "Up-country Hubs",
      hubs: "Mbarara · Jinja · Gulu · Arua · Masaka · Mbale",
      eta: "24–48 hours",
      mode: "Regional bus terminal or express courier",
      feeKind: "quoted"
    },
    {
      id: "pickup",
      name: "Self-Pickup in Kampala",
      hubs: "Collect at our store counter",
      eta: "Ready in 1 hour",
      mode: "Free pickup — try it on before you pay",
      feeKind: "free"
    }
  ];

  function deliveryEstimate(zoneId, settings) {
    const zone = DELIVERY_ZONES.find(z => z.id === zoneId) || DELIVERY_ZONES[0];
    const base = Math.max(0, Number(
      settings && (settings.base_delivery_fee != null ? settings.base_delivery_fee : settings.boda_base_fee)
    ) || 7000);
    let fee = "";
    if (zone.feeKind === "standard") fee = `From ${ugx(base)}`;
    else if (zone.feeKind === "free") fee = "Free";
    else fee = "Bus/courier fare quoted on WhatsApp";
    return Object.assign({}, zone, { fee, baseFee: base });
  }

  /* ----------------------------------------------------------
     7. WHATSAPP CHECKOUT DEEP-LINK GENERATOR
     Builds the pre-filled order message targeting the store line.
     ---------------------------------------------------------- */
  function storeWhatsAppNumber(settings) {
    const raw = String((settings && settings.whatsapp) || "256758873398").replace(/\D/g, "");
    return raw || "256758873398";
  }

  function generateWhatsAppLink(product, settings, options) {
    const opts = options || {};
    const phoneNumber = storeWhatsAppNumber(settings);
    const storeName = (settings && settings.store_name) || "Adonai Thrift Store";
    const grade = gradeFor(product);
    const size = product && product.size && product.size !== "-" ? product.size : "Standard";
    const lines = [
      `Hello ${storeName}, I would like to order this item:`,
      "",
      `*Item:* ${product.name}`,
      `*SKU:* ${product.sku || product.barcode_id || product.id}`,
      `*Price:* ${ugx(displayPrice(product))}`,
      `*Condition:* ${product.condition || grade.label}`,
      `*Size:* ${size}`
    ];
    if (opts.zone) {
      const zone = deliveryEstimate(opts.zone, settings);
      lines.push(`*Delivery:* ${zone.name} — ${zone.eta}`);
    }
    if (opts.note) lines.push(`*Note:* ${opts.note}`);
    lines.push(`*Link:* ${productUrl(product)}`);
    return `https://wa.me/${phoneNumber}?text=${encodeURIComponent(lines.join("\n"))}`;
  }

  /** Generic enquiry (used when a piece is already sold). */
  function enquiryWhatsAppLink(product, settings, message) {
    const phoneNumber = storeWhatsAppNumber(settings);
    const storeName = (settings && settings.store_name) || "Adonai Thrift Store";
    const text = message || (product
      ? `Hello ${storeName}, do you have anything similar to ${product.name} (${product.sku || product.id})?`
      : `Hello ${storeName}, I have a question about an item on your website.`);
    return `https://wa.me/${phoneNumber}?text=${encodeURIComponent(text)}`;
  }

  /* ----------------------------------------------------------
     8. RESPONSIVE IMAGE DELIVERY (WebP + srcset, CLS-safe)
     ---------------------------------------------------------- */
  const MANIFEST = () => global.ADONAI_IMAGE_MANIFEST || {};

  function normalizeAssetKey(src) {
    return String(src || "").replace(/^\.?\//, "").split("?")[0];
  }

  /**
   * Resolve an asset reference to a root-relative URL.
   * PDP permalinks live at /product/<slug>, so a bare "assets/…" path would
   * otherwise resolve against /product/ and 404.
   */
  function resolveSrc(src) {
    const value = String(src || "").trim();
    if (!value) return "";
    if (/^(https?:|data:|blob:|\/)/i.test(value)) return value;
    return "/" + value.replace(/^\.?\//, "");
  }

  function imageEntry(src) {
    const key = normalizeAssetKey(src);
    return MANIFEST()[key] || null;
  }

  /** Collected gallery photos (main image first, de-duplicated). */
  function productImages(product) {
    if (!product) return [];
    const list = [];
    if (product.image_url) list.push(product.image_url);
    (Array.isArray(product.images) ? product.images : []).forEach(src => {
      if (src && typeof src === "string" && list.indexOf(src) === -1) list.push(src);
    });
    return list;
  }

  /**
   * Build a <picture> block with WebP sources, lazy loading and explicit
   * intrinsic dimensions so the browser reserves space (no layout shift).
   */
  function pictureHTML(src, options) {
    const opts = options || {};
    const alt = esc(opts.alt || "");
    const sizes = opts.sizes || "100vw";
    const loading = opts.eager ? "eager" : "lazy";
    const fetchPriority = opts.eager ? "high" : "auto";
    const className = opts.className ? ` class="${esc(opts.className)}"` : "";
    const entry = imageEntry(src);
    const width = opts.width || (entry && entry.w) || 800;
    const height = opts.height || (entry && entry.h) || 1000;
    const resolved = resolveSrc(src);
    const imgTag =
      `<img src="${esc(resolved)}" alt="${alt}" width="${width}" height="${height}" ` +
      `loading="${loading}" decoding="async" fetchpriority="${fetchPriority}"${className} />`;

    if (!entry || !entry.webp || !entry.webp.length) return imgTag;

    const srcset = entry.webp
      .map(w => `${esc(resolveSrc(entry.stem))}-${w}.webp ${w}w`)
      .join(", ");
    return (
      `<picture>` +
      `<source type="image/webp" srcset="${srcset}" sizes="${esc(sizes)}" />` +
      imgTag +
      `</picture>`
    );
  }

  /* ----------------------------------------------------------
     9. PAYMENT TRUST SIGNALS
     ---------------------------------------------------------- */
  const PAYMENT_METHODS = [
    { id: "mtn", label: "MTN MoMo", color: "#FFCC00", ink: "#1F2937", short: "MTN" },
    { id: "airtel", label: "Airtel Money", color: "#E8192C", ink: "#FFFFFF", short: "Airtel" },
    { id: "cash", label: "Cash on Delivery", color: "#111827", ink: "#FFFFFF", short: "Cash" }
  ];

  global.AdonaiPDP = {
    esc,
    GRADES,
    gradeFor,
    MEASUREMENT_FIELDS,
    expectedMeasurementFields,
    measurementRows,
    measurementNote,
    hasMeasurements,
    measurementsOf,
    slugify,
    productSlug,
    productPath,
    productUrl,
    displayPrice,
    ugx,
    discountPercent,
    stockState,
    flawDisclosure,
    DELIVERY_ZONES,
    deliveryEstimate,
    generateWhatsAppLink,
    enquiryWhatsAppLink,
    storeWhatsAppNumber,
    productImages,
    pictureHTML,
    resolveSrc,
    imageEntry,
    PAYMENT_METHODS
  };
})(typeof window !== "undefined" ? window : globalThis);
