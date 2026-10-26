/* ============================================================
   ADONAI STORE — CENTRAL REAL-TIME DB ENGINE (DB)
   The single source of truth for ALL interfaces:
     /           public storefront
     /pos        cashier register
     /admin      operations console
   - localStorage persistence (shared by every tab/interface)
   - BroadcastChannel + storage-event real-time sync across tabs
   - Web Locks (where supported) for atomic cross-tab transactions
   All UIs only talk to the DB.* API — swap this file for a
   Supabase-backed implementation later without touching the UIs.
   ============================================================ */
(function (global) {
  "use strict";

  const LS_KEY   = "adonai-db-v7";   // v7: FACTORY DEFAULT — clean Day-1 seed (no demo data)
  const CHANNEL  = "adonai-db-v7-sync";
  const OFFICIAL_STORE_EMAIL = "info@adonaithrift-store.online";
  const LEGACY_STORE_EMAIL = "adonaithriftstore@gmail.com";
  const LOCK     = "adonai-store-db-tx";
  const PURGE_FLAG = "adonai-db-v7-factory-purged";   // one-time cache-wipe marker

  /* ---------- factory cache purge (one-time, on first v7 boot) ----------
     v7 is the factory-reset release. On the FIRST load after this upgrade the
     engine wipes EVERY `adonai*` key from localStorage/sessionStorage — the
     old v1–v6 offline databases, carts, sessions, tokens, notification
     history and analytics queues — so no leftover items or cart state can
     reappear on load. It then seeds a clean Day-1 database below. */
  function purgeLegacyCaches() {
    // This migration is one-time. Re-running it on every navigation wipes
    // valid area unlock sessions and makes saved passwords appear broken.
    try { if (storage.getItem(PURGE_FLAG)) return []; } catch (e) {}
    const hits = [];
    const wipe = store => {
      if (!store) return;
      try {
        const doomed = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k && /^adonai/i.test(k) && k !== PURGE_FLAG) doomed.push(k);
        }
        doomed.forEach(k => { try { store.removeItem(k); hits.push(k); } catch (e) {} });
      } catch (e) {}
    };
    wipe(storage);
    try { wipe(typeof sessionStorage !== "undefined" ? sessionStorage : null); } catch (e) {}
    // Best-effort: drop any Cache Storage buckets (service-worker precache).
    try {
      if (typeof caches !== "undefined" && caches && caches.keys) {
        caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
      }
    } catch (e) {}
    try { storage.setItem(PURGE_FLAG, String(Math.floor(Date.now() / 1000))); } catch (e) {}
    return hits;
  }

  /* ---------- storage (localStorage, in-memory fallback for tests) ---------- */
  const _mem = {};
  const storage = (typeof localStorage !== "undefined") ? localStorage : {
    getItem: k => (Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null),
    setItem: (k, v) => { _mem[k] = String(v); },
    removeItem: k => { delete _mem[k]; }
  };

  /* ---------- domain constants ---------- */
  const CATEGORIES    = [
    "Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories", "Children Wear",
    "Boots", "Sandals", "Activewear & Sportswear", "Suits & Formalwear", "Underwear & Sleepwear", "Bags & Handbags",
    "Necklaces & Chains", "Bracelets & Bangles", "Rings & Earrings", "Watches", "Eyewear & Sunglasses", "Hats, Scarves & Belts",
    "Traditional & Occasionwear", "Swimwear & Beachwear"
  ];
  const ITEM_CONDITIONS = ["BRAND_NEW", "PRE_LOVED"];
  const QUANTITY_TYPES = ["BRAND_NEW", "PRE_LOVED"];
  const DEMO_CODES    = { "Men": "MEN", "Women": "WOM", "Children": "KID", "Unisex": "UNI" };
  const CONDITIONS    = ["Brand New with Tags (BNWT)", "Grade A — Excellent", "Grade B — Good", "Vintage / Collector"];
  // Unisex is a first-class demographic so it is available in inventory,
  // cashier filters, and the public storefront filters.
  const DEMOGRAPHICS  = ["Men", "Women", "Children", "Unisex"];
  const CAT_CODES     = {
    "Outerwear & Jackets": "JKT", "Tops & Shirts": "TOP", "Dresses & Skirts": "DRS", "Pants & Jeans": "PNT",
    "Shoes": "SHO", "Accessories": "ACC", "Children Wear": "CHD", "Boots": "BTS", "Sandals": "SND",
    "Activewear & Sportswear": "ACT", "Suits & Formalwear": "SUI", "Underwear & Sleepwear": "SLP",
    "Bags & Handbags": "BAG", "Necklaces & Chains": "NCK", "Bracelets & Bangles": "BRB",
    "Rings & Earrings": "JWL", "Watches": "WCH", "Eyewear & Sunglasses": "EYE", "Hats, Scarves & Belts": "HSB",
    "Traditional & Occasionwear": "TRD", "Swimwear & Beachwear": "SWM"
  };
  const TENDER_TYPES  = ["cash", "mtn", "airtel"];
  // Every tender the server can record on an order. The POS picker still
  // offers only the counter options above, but staff confirming an online
  // payment must not have the channel downgraded to "cash" in the local copy.
  const RECORDED_TENDERS = TENDER_TYPES.concat([
    "whatsapp", "flutterwave", "online", "card",
    "mobile_money", "momo", "bank_transfer", "bank", "merchant_code", "merchant"
  ]);
  const DISPATCH_STATUSES = ["Unfulfilled", "In Assembly", "Ready for Pickup", "Dispatched", "Completed"];
  const RIDER_STATUSES    = ["Available", "On delivery", "Offline"];
  const STAFF_ROLES = ["admin", "manager", "cashier", "rider"];
  const ROLE_LABELS = {
    admin:   "Admin (Full Control & Master Key)",
    manager: "Manager (Inventory, Ledger & Dispatch)",
    cashier: "Cashier (POS Checkout & Product Search Only)",
    rider:   "Boda Rider (Delivery & Dispatch Only)"
  };
  const LEDGER_KINDS = ["sale", "expense", "refund", "adjustment"];
  const LEDGER_KIND_LABELS = {
    sale: "Sale (Auto from Register / Online)",
    expense: "Expense (Supplies, Boda Float, Rent)",
    refund: "Refund (Customer Return)",
    adjustment: "Adjustment (Drawer Recount / Correction)"
  };
  const normalizeSaleRecord = sale => {
    if (!sale || typeof sale !== "object") return sale;
    const rider = sale.rider && typeof sale.rider === "object" ? sale.rider : {};
    return Object.assign({}, sale, {
      assigned_rider_id: sale.assigned_rider_id || sale.rider_id || rider.id || null,
      assigned_rider_name: sale.assigned_rider_name || sale.rider_name || rider.name || null
    });
  };

  const orderLanes = s => {
    const status = String(s && s.status || "").trim().toLowerCase();
    const raw = String(s && s.dispatch_status || (s && s.channel === "web" ? "Unfulfilled" : "Completed"))
      .trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (["cancelled", "canceled", "void"].includes(status) || ["cancelled", "canceled", "void"].includes(raw)) return "cancelled";
    if (["unfulfilled", "pending", "incoming", "received", "new", "new order", "needs review", "awaiting review", "waiting review", "waiting for review", "received and waiting for review", "awaiting fulfillment", "awaiting processing"].includes(raw)) return "incoming";
    if (["in assembly", "assembly", "assembling", "in progress", "processing", "packing", "packed"].includes(raw)) return "fulfillment";
    if (["ready", "ready for pickup", "ready for dispatch", "ready to dispatch", "dispatched", "with rider", "handed over", "out for delivery"].includes(raw)) return "ready";
    if (["completed", "complete", "delivered"].includes(raw) || status === "completed") return "completed";
    // Unknown web stages stay visible in the operator's intake queue instead
    // of silently disappearing into the completed lane.
    return s && s.channel === "web" ? "incoming" : "completed";
  };
  // There is no embedded/default master key. PIN-free access uses a signed
  // session issued by the server; opt-in credential protection uses only keys
  // explicitly configured by the owner. The old published key is retired.
  const DEFAULT_MASTER_KEY = "";
  // Live Render deployment — the public storefront and the API are served by the
  // same service. Fallback base used when the POS/admin runs inside the Android
  // APK shell (appassets origin) or another non-web container.
  const DEFAULT_WEB_APP_URL = "https://www.adonaithrift-store.online";

  /* ---------- factory Day-1 seed (v7) ----------
     Clean 'Day 1' state: the catalog, sales, ledger, guest book and rider
     roster all start EMPTY and the counters restart at their factory
     baselines, so the first receipt is AT-1001, first guest GUS-1001, first
     ledger entry LED-1001, first rider RDR-1001. Only ONE staff identity is
     provisioned — the STF-01 admin — and the suite stays in open-access mode
     until the owner sets a master key in System Parameters. Store settings
     (system configuration) are preserved. */
  const factoryCounters = () => ({
    product: 1000,      // next local product number → 1001
    sale_seq: 1000,     // general sale sequence
    sale_pos: 1000,     // next POS receipt number  → AT-1001
    sale_web: 1000,     // next web order number
    guest: 1000,        // next guest profile       → GUS-1001
    rider: 1000,        // next rider               → RDR-1001
    ledger: 1000        // next ledger entry        → LED-1001
  });

  function seedState() {
    return {
      version: 4,
      settings: {
        store_name: "Adonai Store",
        tagline: "Brand-new apparel + curated vintage pieces · Kampala, Uganda",
        address: "Plot 45 Salama Road / kibuli Kampala, Uganda",
        whatsapp: "256758893398",
        whatsapp_display: "+256 7588 73398",
        hotline: "+256 7656 52403",
        email: OFFICIAL_STORE_EMAIL,
        tiktok: "@adonai.thrift256",
        instagram: "@adonaithrift256",
        hours: "Mon - Sat: 8:30 AM - 7:30 PM | Sun: 10:00 AM - 6:00 PM",
        delivery_scope: "Adonai-managed delivery across Uganda (Central, Eastern, Western, and regional routes)",
        base_delivery_fee: 7000,
        currency: "UGX",
        storefront_promo_ids: "auto",
        access_locked: false,               // legacy cache only; the server now owns the access mode
        admin_key: ""                       // set a strong master key in System Parameters after onboarding
      },
      products: [],                         // catalog empty — ready for fresh batch/lot intake
      sales: [],                            // no sales history
      ledger: [],                           // no ledger entries
      guests: [],                           // no customer profiles
      riders: [],                           // no rider roster
      staff: [{
        id: "STF-01", name: "Store Admin", email: "", phone: "+256 7588 73398",
        role: "admin", pin: "", active: true, created_at: new Date().toISOString()
      }],
      counters: factoryCounters()
    };
  }

  /* ---------- state & realtime plumbing ---------- */
  let state = null;
  const subs = []; // {table, cb}

  function normalizeProductPolicy(product) {
    const condition = String(product.item_condition || "").toUpperCase();
    product.item_condition = condition === "BRAND_NEW" ? "BRAND_NEW" : "PRE_LOVED";
    product.quantity_type = product.item_condition;
    product.size_variants = Array.isArray(product.size_variants) ? product.size_variants : [];
    product.color_variants = Array.isArray(product.color_variants) ? product.color_variants : [];
    product.measurements = product.measurements && typeof product.measurements === "object" ? product.measurements : {};
    product.factory_tag_notes = product.factory_tag_notes || "";
    product.inner_packaging = product.inner_packaging || "";
    product.fabric_grading_notes = product.fabric_grading_notes || (product.item_condition === "BRAND_NEW" ? "Factory-fresh condition." : "Hand-inspected and laundered.");
    product.inventory_status = Number(product.in_stock_count || 0) > 0 ? "AVAILABLE" : "OUT_OF_STOCK";
    // Dynamic category schema (category_field_schemas): older cached rows
    // predate these keys, so default them instead of breaking renderers.
    product.subcategory = product.subcategory || "";
    product.attributes = product.attributes && typeof product.attributes === "object" && !Array.isArray(product.attributes) ? product.attributes : {};
    product.search_tags = Array.isArray(product.search_tags) ? product.search_tags : [];
    product.specifications = Array.isArray(product.specifications) ? product.specifications : [];
    product.fulfillment_notes = product.fulfillment_notes || "";
    return product;
  }

  function reload() {
    if (state) return;
    let raw = null;
    try { raw = storage.getItem(LS_KEY); } catch (e) { raw = null; }
    let ok = true;
    if (raw) { try { state = JSON.parse(raw); ok = valid(state); } catch (e) { ok = false; } }
    if (!raw || !ok) { state = seedState(); save(); }
    if (state && Array.isArray(state.products)) {
      // Heal cached rows too: an older POS session may have stored absolute
      // media URLs in localStorage, and those would stay broken on the
      // storefront until the next catalog sync replaced them.
      state.products = state.products.map(product => normalizeProductMedia(normalizeProductPolicy(product)));
      if (Array.isArray(state.sales)) state.sales = state.sales.map(normalizeSaleRecord);
      if (state.settings) {
        if (String(state.settings.email || "").trim().toLowerCase() === LEGACY_STORE_EMAIL) {
          state.settings.email = OFFICIAL_STORE_EMAIL;
        }
        if (/Adonai Thrift Store/i.test(String(state.settings.store_name || ""))) state.settings.store_name = "Adonai Store";
        if (!state.settings.tagline || /only|curated pre-loved vintage/i.test(String(state.settings.tagline))) {
          state.settings.tagline = "Brand-new apparel + curated vintage pieces · Kampala, Uganda";
        }
        if (!state.settings.delivery_scope || /^Uganda \(Central, Eastern, and Western regions\)$/i.test(String(state.settings.delivery_scope))) {
          state.settings.delivery_scope = "Adonai-managed delivery across Uganda (Central, Eastern, Western, and regional routes)";
        }
      }
      save();
    }
  }
  function save() {
    try {
      let snapshot = state;
      const policy = typeof PosAccess !== "undefined" && PosAccess.getPolicy ? PosAccess.getPolicy() : null;
      if (policy && policy.protected_areas.length) {
        // This store is shared across tabs. Never write unlocked private history
        // into it, where another cashier tab could read it without a password.
        snapshot = JSON.parse(JSON.stringify(state));
        if (policy.protected_areas.includes("finance") || policy.protected_areas.includes("orders")) {
          snapshot.sales = []; snapshot.ledger = []; snapshot.guests = []; snapshot.riders = [];
        }
        if (policy.protected_areas.includes("stock")) snapshot.products.forEach(product => {
          ["cost_price", "staff_notes", "stock_lot_id", "lot_grade_id"].forEach(key => { delete product[key]; });
        });
      }
      storage.setItem(LS_KEY, JSON.stringify(snapshot));
    } catch (e) { /* quota — ignore */ }
  }
  function valid(s) {
    return s && Array.isArray(s.products) && Array.isArray(s.sales) && Array.isArray(s.staff)
      && Array.isArray(s.ledger) && Array.isArray(s.guests) && Array.isArray(s.riders)
      && s.settings && s.counters;
  }

  /* API URL resolver for Dual-Target Architecture (Web Storefront vs Native Android APK) */
  function apiUrl(path) {
    if (!path.startsWith("/")) path = "/" + path;
    if (typeof window !== "undefined") {
      const isMobileApp = window.__ADONAI_MOBILE_APP__ === true ||
                          window.location.protocol === "file:" ||
                          window.location.origin.includes("capacitor") ||
                          window.location.hostname === "appassets.androidplatform.net" ||
                          (window.location.origin.includes("localhost") && !window.location.port);
      if (isMobileApp) {
        let base = (state && state.settings && (state.settings.app_url || state.settings.website_url)) || DEFAULT_WEB_APP_URL;
        base = base.replace(/\/+$/, "");
        return base + path;
      }
    }
    return path;
  }

  /* BroadcastChannel + storage event — every tab re-renders when any tab writes. */
  let bc = null;
  function broadcast(table) {
    subs.filter(s => table === "*" || s.table === table || s.table === "*").forEach(s => { try { s.cb(table); } catch (e) {} });
    if (bc) { try { bc.postMessage({ table }); } catch (e) {} }
  }

  const NUMERIC_SETTING_KEYS = new Set(["base_delivery_fee", "boda_base_fee"]);
  const BOOLEAN_SETTING_KEYS = new Set(["access_locked"]);

  function normalizeRemoteSettings(remote) {
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) return {};
    return Object.keys(remote).reduce((out, key) => {
      let value = remote[key];
      if (NUMERIC_SETTING_KEYS.has(key)) value = Math.max(0, Number(value) || 0);
      if (BOOLEAN_SETTING_KEYS.has(key)) value = value === true || value === 1 || String(value).toLowerCase() === "true" || String(value) === "1";
      out[key] = value;
      return out;
    }, {});
  }

  function applyRemoteSettings(remote) {
    const incoming = normalizeRemoteSettings(remote);
    if (!Object.keys(incoming).length) return false;
    reload();
    let changed = false;
    Object.keys(incoming).forEach(key => {
      if (state.settings[key] !== incoming[key]) {
        state.settings[key] = incoming[key];
        changed = true;
      }
    });
    if (changed) {
      save();
      broadcast("settings");
    }
    return changed;
  }

  let settingsSyncInFlight = null;
  function pullStoreSettings() {
    if (settingsSyncInFlight || typeof fetch === "undefined") return settingsSyncInFlight || Promise.resolve(false);
    settingsSyncInFlight = fetch(apiUrl("/api/settings"), { method: "GET", cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(data => data && data.settings ? applyRemoteSettings(data.settings) : false)
      .catch(() => false)
      .finally(() => { settingsSyncInFlight = null; });
    return settingsSyncInFlight;
  }

  let productSyncInFlight = null;
  // True once the server has answered the product pull at least once. The
  // storefront needs this to tell "the rail is genuinely empty" apart from
  // "the rail has not loaded yet", so it can hold its placeholder instead of
  // showing an empty grid to a shopper who has only just arrived.
  let productsSynced = false;
  // The storefront is holding a placeholder until the first catalog answer
  // arrives. This fires exactly once per page load — success, empty result
  // or a failed request — so the rail never stays stuck on a placeholder.
  function markProductsSynced() {
    if (productsSynced) return;
    productsSynced = true;
    broadcast("catalog");
  }
  /* ----------------------------------------------------------
     MEDIA REFERENCE RESOLUTION

     A photo reference belongs to the store, not to a hostname. Rows used to
     be written from the Android terminal as
     https://www.<store>/api/media/<id> because DB.apiUrl() prefixes the web
     origin outside the browser. The storefront may be served from the apex
     domain or a custom domain, and its Content-Security-Policy only allows
     images from 'self' — so those cards showed a broken-image glyph.

     Everything is now normalized to the host-independent
     /api/media/<id> path on the way in, and apiUrl() re-applies this
     runtime's own base (relative on the web, absolute in the packaged app).
     ---------------------------------------------------------- */
  const MEDIA_REFERENCE = /^(?:https?:)?\/\/[^/]+\/+((?:api)\/(?:media|promo-media)\/[a-f0-9]{32})\/?(?:[?#]\S*)?$/i;
  const BARE_MEDIA_REFERENCE = /^\/?((?:api)\/(?:media|promo-media)\/[a-f0-9]{32})\/?(?:[?#]\S*)?$/i;

  function canonicalMediaRef(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const hosted = raw.match(MEDIA_REFERENCE);
    if (hosted) return apiUrl("/" + hosted[1].toLowerCase());
    const bare = raw.match(BARE_MEDIA_REFERENCE);
    if (bare) return apiUrl("/" + bare[1].toLowerCase());
    return raw;
  }

  function normalizeProductMedia(product) {
    if (!product) return product;
    return Object.assign({}, product, {
      image_url: canonicalMediaRef(product.image_url),
      images: Array.isArray(product.images) ? product.images.map(canonicalMediaRef) : [],
      video: product.video ? Object.assign({}, product.video, { url: canonicalMediaRef(product.video.url) }) : null
    });
  }

  function pullProducts(publicAvailability, reservationOwner) {
    if (productSyncInFlight || typeof fetch === "undefined") return productSyncInFlight || Promise.resolve(false);
    const isPublic = publicAvailability === true || (typeof window !== "undefined" && window.__ADONAI_STOREFRONT__ === true);
    const owner = reservationOwner || (typeof window !== "undefined" ? window.__ADONAI_WEB_LOCK_OWNER__ : "");
    const query = isPublic ? `?availability=public${owner ? `&reservation_owner=${encodeURIComponent(owner)}` : ""}` : "";
    const endpoint = "/api/products" + query;
    productSyncInFlight = fetch(apiUrl(endpoint), { method: "GET", cache: "no-store" })
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (e) {}
        if (!response.ok || !data || !Array.isArray(data.products)) {
          markProductsSynced();
          return false;
        }
        reload();
        const before = JSON.stringify(state.products || []);
        const normalized = data.products.map(normalizeProductMedia);
        const after = JSON.stringify(normalized);
        markProductsSynced();
        if (before === after) return false;
        state.products = normalized;
        save();
        broadcast("products");
        return true;
      })
      .catch(() => { markProductsSynced(); return false; })
      .finally(() => { productSyncInFlight = null; });
    return productSyncInFlight;
  }

  let operationalSyncInFlight = null;
  let operationalSyncOnline = null;
  let operationalSyncLastSyncedAt = null;
  let operationalSyncStatusCode = 0;
  let operationalSyncFullAt = 0;
  let operationalSignature = null;
  const FULL_SYNC_EVERY_MS = 300000;
  // Asks the server for the whole store only when something changed. The revision is kept in the
  // cached state so a navigation reload can check freshness with a tiny request instead of a full download.
  function currentSyncRevision() {
    reload();
    return state && typeof state.sync_revision === "string" ? state.sync_revision : "";
  }
  function pullOperationalData(options) {
    if (operationalSyncInFlight || typeof fetch === "undefined") return operationalSyncInFlight || Promise.resolve(false);
    const ready = typeof Auth !== "undefined" && Auth.ready ? Auth.ready() : Promise.resolve();
    const forceFull = !!(options && options.force) || Date.now() - operationalSyncFullAt > FULL_SYNC_EVERY_MS;
    operationalSyncInFlight = ready.then(() => fetch(apiUrl("/api/sync/pull"), {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ if_revision: forceFull ? "" : currentSyncRevision() }),
      cache: "no-store"
    })).then(async response => {
      let data = null;
      try { data = await response.json(); } catch (e) {}
      if (!response.ok || !data || (!data.unchanged && !Array.isArray(data.products))) {
        operationalSyncOnline = false;
        operationalSyncStatusCode = response.status || 502;
        broadcast("sync");
        return false;
      }
      operationalSyncOnline = true;
      operationalSyncStatusCode = 200;
      operationalSyncLastSyncedAt = new Date().toISOString();
      if (data.unchanged) return false;
      operationalSyncFullAt = Date.now();
      // Identical payloads must not touch storage or re-render open screens.
      const signature = JSON.stringify([data.products, data.sales, data.ledger, data.settings, data.riders, data.categories, data.inventory, data.blocked_areas]);
      const revisionChanged = !!data.revision && data.revision !== currentSyncRevision();
      if (signature === operationalSignature && !revisionChanged) return false;
      operationalSignature = signature;
      reload();
      state.products = data.products.map(normalizeProductMedia);
      if (Array.isArray(data.sales)) state.sales = data.sales.map(normalizeSaleRecord);
      if (Array.isArray(data.ledger)) state.ledger = data.ledger.map(line => Object.assign({
        label: line.desc || `${line.kind} ${line.ref_id || ""}`,
        note: line.staff ? `Logged by ${line.staff}` : "",
        by: line.staff || "System",
        sale_id: line.ref_id || null
      }, line));
      if (data.revision) state.sync_revision = data.revision;
      save();
      if (data.settings) applyRemoteSettings(data.settings);
      broadcast("*");
      return true;
    }).catch(() => {
      operationalSyncOnline = false;
      operationalSyncStatusCode = 0;
      broadcast("sync");
      return false;
    }).finally(() => { operationalSyncInFlight = null; });
    return operationalSyncInFlight;
  }

  function initRealtime(iface) {
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = ev => {
        state = null; reload(); /* re-read shared cache */
        subs.filter(s => ev.data.table === "*" || s.table === ev.data.table || s.table === "*").forEach(s => { try { s.cb(ev.data.table); } catch (e) {} });
      };
    }
    if (typeof window !== "undefined") {
      window.addEventListener("storage", ev => {
        if (ev.key !== LS_KEY) return;
        state = null; reload();
        subs.filter(s => s.table === "*" || true).forEach(s => { try { s.cb("*"); } catch (e) {} });
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          state = null; reload();
          subs.filter(s => s.table === "*").forEach(s => s.cb("reload"));
          if (window.__ADONAI_STOREFRONT__ === true) pullProducts(true);
          else pullOperationalData();
        }
      });

      // Store profile settings are publicly readable and deliberately fetched
      // independently of the protected POS sync. Polling keeps already-open
      // storefronts current when an Android terminal saves System Parameters.
      pullStoreSettings();
      if (window.__ADONAI_STOREFRONT__ === true) pullProducts(true);
      // Freshness is checked every few seconds with a tiny revision request; the full store is only
      // downloaded when it actually changed. Store settings are polled less often.
      window.setInterval(() => {
        if (!document.hidden) {
          if (window.__ADONAI_STOREFRONT__ === true) pullProducts(true);
          else pullOperationalData();
        }
      }, 4000);
      window.setInterval(() => { if (!document.hidden) pullStoreSettings(); }, 10000);

      // Defer one tick so auth.js can restore the JWT after this module loads.
      // Staff consoles hydrate the full operational state; the storefront only
      // requests the public stock view adjusted for active POS holds.
      window.setTimeout(() => {
        if (window.__ADONAI_STOREFRONT__ === true) {
          pullProducts(true);
        } else {
          pullOperationalData().then(ok => { if (!ok) pullProducts(false); });
        }
      }, 0);
    }
  }
  /* One-time factory cache wipe on the first v7 boot (must run before the
     first reload() so the old cached database can never be re-read). */
  try { purgeLegacyCaches(); } catch (e) {}

  initRealtime();
  if (typeof window !== "undefined") window.addEventListener("pos-access-change", () => {
    reload(); save(); pullOperationalData();
  });

  /* Cross-tab atomic transaction. */
  function tx(table, fn) {
    const work = () => { reload(); const out = fn(state); save(); broadcast(table); return out; };
    if (typeof navigator !== "undefined" && navigator.locks && navigator.locks.request) {
      return navigator.locks.request(LOCK, () => work());
    }
    return Promise.resolve().then(work);
  }

  /* ---------- helpers ---------- */
  const money = n => Math.round(Number(n) || 0);
  const byId = (arr, id) => arr.find(x => x.id === id);
  const stockError = (name, have) => { const e = new Error(`Insufficient stock for "${name}" (in stock: ${have})`); e.code = "STOCK"; return e; };
  const shakeOn = s => String(s || "").trim();

  function apiHeaders(withAuth = true) {
    const headers = { "Content-Type": "application/json" };
    if (withAuth && typeof Auth !== "undefined" && Auth.authHeaders) Object.assign(headers, Auth.authHeaders());
    return headers;
  }

  /* Network guard: every API request aborts after 30s so workspaces never
     hang on a silent connection (the old UI stayed on "Loading…" forever).
     Uploads opt into a longer deadline; caller cancellation still works. */
  const API_TIMEOUT_MS = 30000;
  async function apiRequest(path, options = {}, withAuth = true, areaRetried = false) {
    if (withAuth && typeof Auth !== "undefined" && Auth.ready && !Auth.openAccess()) await Auth.ready();
    const controller = (typeof AbortController === "function") ? new AbortController() : null;
    let timedOut = false;
    const externalAbort = () => { if (controller) controller.abort(); };
    if (options.signal && controller) {
      if (options.signal.aborted) externalAbort();
      else options.signal.addEventListener("abort", externalAbort, { once: true });
    }
    const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(240000, Math.max(API_TIMEOUT_MS, Number(options.timeoutMs) || API_TIMEOUT_MS))) : null;
    let response;
    try {
      response = await fetch(apiUrl(path), Object.assign({}, options, {
        signal: (controller && controller.signal) || options.signal || undefined,
        headers: Object.assign(apiHeaders(withAuth), options.headers || {}, typeof PosAccess !== "undefined" && PosAccess.headers ? PosAccess.headers() : {})
      }));
    } catch (networkError) {
      const error = new Error(timedOut
        ? "The server took too long to answer. Check your connection and tap Try again."
        : "Could not reach the server. Check your connection and tap Try again.");
      error.status = 0;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (options.signal && controller) options.signal.removeEventListener("abort", externalAbort);
    }
    let data = null;
    try { data = await response.json(); } catch (e) {}
    if (!response.ok) {
      if (!areaRetried && data && data.code === "AREA_PASSWORD_REQUIRED" && typeof PosAccess !== "undefined") {
        if (await PosAccess.ensure(data.area)) return apiRequest(path, options, withAuth, true);
      }
      const error = new Error((data && (data.error || data.details)) || `Server request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    // Wake the bell immediately after a committed store action. Other
    // terminals still receive it through the independent history refresh.
    const verb = String(options.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(verb) && /^\/api\/(orders|products|finance|settings|dispatch|riders)(?:\/|\?|$)/.test(path)
        && typeof global.dispatchEvent === "function" && typeof global.CustomEvent === "function") {
      global.dispatchEvent(new global.CustomEvent("adonai-store-activity", { detail: { path } }));
    }
    return data || {};
  }

  function saleFromItems(st, items) {
    const lines = items.map(it => {
      const p = byId(st.products, it.product_id);
      if (!p) throw new Error("Unknown product: " + it.product_id);
      const qty = Math.max(1, money(it.qty));
      return { p, qty };
    });
    lines.forEach(({ p, qty }) => { if (p.in_stock_count < qty) throw stockError(p.name, p.in_stock_count); });
    lines.forEach(({ p, qty }) => { p.in_stock_count -= qty; });
    const finalItems = lines.map(({ p, qty }) => ({
      product_id: p.id, sku: p.sku || "", barcode_id: p.barcode_id, name: p.name, size: p.size || "-", qty,
      item_condition: p.item_condition || "PRE_LOVED", quantity_type: p.quantity_type || p.item_condition || "PRE_LOVED",
      unit_price: p.selling_price, line_total: p.selling_price * qty
    }));
    return { items: finalItems, total: finalItems.reduce((s, l) => s + l.line_total, 0) };
  }

  function logSaleEntry(st, sale, cashierName) {
    const n = ++st.counters.ledger;
    st.ledger.push({
      id: "LED-" + n, kind: "sale", amount: sale.total,
      label: `${sale.channel === "web" ? "Web storefront order" : "Register sale"} ${sale.id} · ${sale.items[0] ? sale.items[0].name : "items"}${sale.items.length > 1 ? " +" + (sale.items.length - 1) + " more" : ""}`,
      note: `Logged by ${cashierName || (sale.cashier && sale.cashier.name) || "Console"} · ${tenderLabel(sale.tender)}`,
      channel: (sale.tender && sale.tender.type) || "cash",
      by: cashierName || (sale.cashier && sale.cashier.name) || "Console",
      created_at: new Date().toISOString(), sale_id: sale.id
    });
  }
  function tenderLabel(t) {
    if (!t) return "—";
    if (t.type === "whatsapp") return "WhatsApp";
    if (t.type === "cash") return "Cash";
    if (t.type === "mtn") return "MTN MoMo";
    if (t.type === "airtel") return "Airtel Money";
    if (t.type === "flutterwave" || t.type === "online" || t.type === "card") return "Paid online (Flutterwave)";
    if (t.type === "mobile_money" || t.type === "momo") return "Mobile money (merchant line)";
    if (t.type === "bank_transfer" || t.type === "bank") return "Bank transfer";
    if (t.type === "merchant_code" || t.type === "merchant") return "Merchant pay code";
    return t.type;
  }

  /* ---------- standards-compliant Code 128 barcode generator ---------- */
  const CODE128_PATTERNS = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
  ];

  function generateBarcodeSVG(text, height = 48) {
    const clean = String(text || "").trim();
    if (!clean) return "";
    const START_B = 104, STOP = 106;
    const codes = [START_B];
    let checkSum = START_B;

    for (let i = 0; i < clean.length; i++) {
      const charCode = clean.charCodeAt(i);
      const val = charCode - 32;
      if (val < 0 || val > 95) continue;
      codes.push(val);
      checkSum += val * (i + 1);
    }

    const checkVal = checkSum % 103;
    codes.push(checkVal);
    codes.push(STOP);

    const quiet = 10;
    const rects = [];
    let x = quiet;

    codes.forEach(c => {
      const p = CODE128_PATTERNS[c];
      let isBar = true;
      for (let j = 0; j < p.length; j++) {
        const w = parseInt(p[j], 10);
        if (isBar) {
          rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#1A1410"/>`);
        }
        x += w;
        isBar = !isBar;
      }
    });

    const totalWidth = x + quiet;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" class="real-barcode-svg" style="width:100%;max-width:240px;height:${height}px;display:block;margin:0 auto;" shape-rendering="crispEdges">
      <rect width="${totalWidth}" height="${height}" fill="#ffffff"/>
      ${rects.join("")}
    </svg>`;
  }

  /*
     Open-access POS sales stay usable when the terminal has not been signed
     into the remote API yet. The register already has a complete local
     catalogue and localStorage database, so item selection and receipt
     creation should not be blocked by an optional server reservation call.
     Authenticated terminals continue to use the atomic server checkout below.
  */
  function processLocalPosSale({ items, tender, cashier, customer_name, customer_phone, customer_location, customer_email, customer_notes }) {
    return tx("sales", st => {
      if (!Array.isArray(items) || !items.length) throw new Error("Sale must contain at least one item");
      const result = saleFromItems(st, items);
      const now = new Date().toISOString();
      const sequence = (Number(st.counters.sale_pos) || Number(st.counters.sale_seq) || 0) + 1;
      st.counters.sale_pos = sequence;

      const finalTender = Object.assign({ type: "cash", paid: true }, tender || {});
      if (finalTender.type === "cash") {
        const tendered = Number(finalTender.tendered) || 0;
        finalTender.tendered = tendered;
        finalTender.change = Math.max(0, tendered - result.total);
      }

      const sale = {
        id: "AT-" + sequence,
        channel: "pos",
        status: "completed",
        created_at: now,
        customer_name: String(customer_name || "Walk-in Guest").trim(),
        customer_phone: String(customer_phone || "").trim(),
        customer_location: String(customer_location || "").trim(),
        delivery_address: String(customer_location || "").trim(),
        delivery_type: "pickup",
        delivery_fee: 0,
        delivery_notes: String(customer_notes || "").trim(),
        customer_email: String(customer_email || "").trim(),
        cashier: cashier || { name: "Staff", role: "open access" },
        items: result.items,
        subtotal: result.total,
        total: result.total,
        tender: finalTender,
        dispatch_status: "Delivered",
        assigned_rider_id: null,
        assigned_rider_name: null
      };

      st.sales.push(sale);
      logSaleEntry(st, sale, sale.cashier && sale.cashier.name);

      // Keep the local customer book consistent with the remote POS path.
      const cName = sale.customer_name;
      const cPhone = sale.customer_phone;
      if (cName && cName !== "Walk-in Guest") {
        const existingGuest = st.guests.find(g =>
          (cPhone && g.phone && g.phone === cPhone) ||
          (g.name && g.name.toLowerCase() === cName.toLowerCase())
        );
        if (!existingGuest) {
          st.guests.push({
            id: "GUS-" + (++st.counters.guest), name: cName, phone: cPhone,
            email: sale.customer_email, address: sale.customer_location,
            neighborhood: sale.customer_location,
            notes: sale.delivery_notes ? `Walk-in POS: ${sale.delivery_notes}` : "Walk-in POS Customer",
            created_at: now
          });
        }
      }
      return JSON.parse(JSON.stringify(sale));
    });
  }

  /* ---------- public API ---------- */
  global.DB = {
    CATEGORIES, CONDITIONS, ITEM_CONDITIONS, QUANTITY_TYPES, DEMOGRAPHICS, CAT_CODES, TENDER_TYPES, DISPATCH_STATUSES,
    RIDER_STATUSES, STAFF_ROLES, ROLE_LABELS, LEDGER_KINDS, LEDGER_KIND_LABELS,
    ORDER_LANES: orderLanes, DEFAULT_MASTER_KEY, TENDER_LABEL: tenderLabel,

    on(table, cb) { const s = { table, cb }; subs.push(s); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); }; },
    reloadNow() { state = null; reload(); },
    refreshOperationalData() { return pullOperationalData(); },
    applyAccessPolicy() { reload(); save(); return pullOperationalData(); },
    operationalSyncStatus() {
      return {
        online: operationalSyncOnline,
        last_synced_at: operationalSyncLastSyncedAt,
        status: operationalSyncStatusCode
      };
    },

    /* ----- settings ----- */
    getSettings() { reload(); return Object.assign({}, state.settings); },
    updateSettings(patch) {
      return tx("settings", st => {
        Object.keys(patch).forEach(k => { st.settings[k] = patch[k]; });
        return Object.assign({}, st.settings);
      });
    },
    pullStoreSettings,
    async syncStoreSettings(patch, adminCredential, options) {
      const pinFree = typeof Auth !== "undefined" && Auth.openAccess && Auth.openAccess();
      // Saving in PIN-free mode must work even if session bootstrap failed.
      if (!pinFree && typeof Auth !== "undefined" && Auth.ready) await Auth.ready();
      const cleanPatch = Object.assign({}, patch || {});
      const opts = options || {};
      const credential = pinFree ? "" : String(adminCredential || "").trim();
      const headers = { "Content-Type": "application/json" };

      if (credential) {
        if (credential.split(".").length === 3) headers.Authorization = "Bearer " + credential;
        else headers["X-Terminal-Key"] = credential;
      } else if (!pinFree && typeof Auth !== "undefined" && Auth.authHeaders) {
        Object.assign(headers, Auth.authHeaders());
      }

      const body = { settings: cleanPatch };
      if (opts.applyBaseFeeToCatalog) body.apply_base_fee_to_catalog = true;

      return apiRequest("/api/settings", { method: "POST", headers, body: JSON.stringify(body) }, false).then(data => {
        if (!data.ok) throw new Error(data.error || "Could not publish settings to the live storefront");

        const productsUpdated = Number(data.products_updated) || 0;
        // A catalog-wide transport rollout changed product prices server-side;
        // refresh the shared product cache right away instead of waiting for
        // the next poll so every open panel sees the new fees immediately.
        if (productsUpdated > 0 && typeof pullOperationalData === "function" && window.__ADONAI_STOREFRONT__ !== true) {
          pullOperationalData().catch(() => {});
        }

        const publicSettings = normalizeRemoteSettings(data.settings || {});
        return tx("settings", st => {
          Object.keys(publicSettings).forEach(key => { st.settings[key] = publicSettings[key]; });
          // The server never returns secret values. Keep the locally verified
          // master key in the admin_key slot only after the remote save succeeds.
          if (cleanPatch.master_key) st.settings.admin_key = String(cleanPatch.master_key);
          else if (cleanPatch.admin_key) st.settings.admin_key = String(cleanPatch.admin_key);
          const saved = Object.assign({}, st.settings);
          saved.products_updated = productsUpdated;
          return saved;
        });
      });
    },

    /* ----- staff & access (roster seeded; passkeys EMPTY until admin sets them) ----- */
    listStaff() { reload(); return state.staff.map(s => Object.assign({}, s)); },
    addStaff({ name, email, phone, role, pin, photo }) {
      return tx("staff", st => {
        name = shakeOn(name); if (!name) throw new Error("Full name is required");
        const r = STAFF_ROLES.includes(role) ? role : "cashier";
        const rec = {
          id: "STF-" + String(st.staff.length + 1).padStart(2, "0"),
          name, email: shakeOn(email), phone: shakeOn(phone), role: r,
          photo: typeof photo === "string" ? photo : "",   // operator-uploaded portrait (data-url)
          pin: pin ? String(pin).trim() : "",              // may stay empty (set later via Edit Key)
          active: true, created_at: new Date().toISOString()
        };
        if (rec.pin) {
          if (!/^\d{4,8}$/.test(rec.pin) && rec.pin.length < 6) throw new Error("Key must be a 4–8 digit PIN or a word of 6+ characters");
          if (st.staff.some(s => s.pin && s.pin === rec.pin)) throw new Error("That key is already in use");
        }
        st.staff.push(rec);
        return Object.assign({}, rec);
      });
    },
    updateStaff(id, patch) {
      return tx("staff", st => {
        const s = byId(st.staff, id); if (!s) throw new Error("Staff not found");
        ["name", "email", "phone", "role", "photo"].forEach(k => { if (patch[k] !== undefined) s[k] = patch[k]; });
        if (patch.active !== undefined) s.active = !!patch.active;
        return Object.assign({}, s);
      });
    },
    removeStaff(id) {
      return tx("staff", st => { st.staff = st.staff.filter(s => s.id !== id); return true; });
    },
    setStaffActive(id, active) {
      return tx("staff", st => {
        const s = byId(st.staff, id); if (!s) throw new Error("Staff not found");
        if (s.role === "admin" && !active && st.staff.filter(x => x.role === "admin" && x.active).length <= 1 && s.active) throw new Error("Keep at least one active admin");
        s.active = !!active;
        return Object.assign({}, s);
      });
    },
    resetStaffPin(id, newPin) {
      return tx("staff", st => {
        const pin = String(newPin || "").trim();
        if (pin && !(/^\d{4,8}$/.test(pin) || pin.length >= 6)) throw new Error("Key must be a 4–8 digit PIN or a word of 6+ characters");
        if (pin && st.staff.some(s => s.pin && s.pin === pin && s.id !== id)) throw new Error("That key is already in use");
        const s = byId(st.staff, id); if (!s) throw new Error("Staff not found");
        s.pin = pin;
        return Object.assign({}, s);
      });
    },
    verifyPin(pin) {
      reload();
      if (!pin) return null;
      const s = state.staff.find(x => x.active && x.pin && x.pin === String(pin).trim());
      return s ? { id: s.id, name: s.name, role: s.role, email: s.email } : null;
    },
    verifyMasterKey(k) {
      reload();
      const candidate = String(k || "").trim();
      if (!candidate) return false;
      const configured = String(state.settings.admin_key || "").trim();
      // Only a key explicitly configured by the admin can unlock — no
      // hardcoded fallback keys exist anymore.
      return !!configured && candidate === configured;
    },
    setMasterKey(k) {
      const key = String(k || "").trim();
      if (key.length < 6) return Promise.reject(new Error("Master key must be at least 6 characters"));
      return tx("settings", st => { st.settings.admin_key = key; return true; });
    },

    /* ----- products ----- */
    listProducts() { reload(); return state.products.map(p => Object.assign({}, p)); },
    getProduct(id) { reload(); const p = byId(state.products, id); return p ? Object.assign({}, p) : null; },
    findByBarcode(code) {
      reload();
      const c = String(code || "").trim().toUpperCase();
      const p = state.products.find(x => x.barcode_id.toUpperCase() === c || x.sku.toUpperCase() === c);
      return p ? Object.assign({}, p) : null;
    },
    async addProduct(input) {
      const payload = Object.assign({}, input || {});
      const data = await apiRequest("/api/products", {
        method: "POST",
        body: JSON.stringify(payload)
      }, true);
      const product = normalizeProductMedia(data.product);
      if (!product) throw new Error("The server did not return the registered product");
      return tx("products", st => {
        const existing = byId(st.products, product.id);
        if (existing) Object.assign(existing, product);
        else st.products.push(product);
        return Object.assign({}, product);
      });
    },
    async updateProduct(id, patch) {
      const data = await apiRequest("/api/products/" + encodeURIComponent(id), {
        method: "PUT",
        body: JSON.stringify(patch || {})
      }, true);
      const product = normalizeProductMedia(data.product);
      return tx("products", st => {
        const local = byId(st.products, id);
        if (local && product) Object.assign(local, product);
        return Object.assign({}, product || local || {});
      });
    },
    setProductImage(id, imageUrl) {
      return this.updateProduct(id, { image_url: String(imageUrl || "") });
    },
    async adjustStock(id, delta) {
      const product = this.getProduct(id);
      if (!product) throw new Error("Product not found");
      return this.updateProduct(id, { in_stock_count: Math.max(0, Number(product.in_stock_count || 0) + money(delta)) });
    },
    async removeProduct(id, mode = "archive") {
      await apiRequest("/api/products/" + encodeURIComponent(id), {
        method: "DELETE",
        body: JSON.stringify({ mode: mode === "permanent" ? "permanent" : "archive" })
      }, true);
      return tx("products", st => {
        st.products = st.products.filter(product => product.id !== id);
        return true;
      });
    },

    /* ----- sales (POS + web storefront, unified) ----- */
    async processPosSale({ items, tender, cashier, customer_name, customer_phone, customer_location, customer_email, customer_notes, lock_owner }) {
      // Every POS sale goes through the authenticated API. This is intentional:
      // a local-only fallback would let a browser terminal change a private
      // copy of stock without synchronizing the public storefront or another
      // cashier. The server remains the atomic source of truth for stock,
      // reservations, accounting, and printed receipts.
      const payload = {
        channel: "pos",
        lock_owner: String(lock_owner || ""),
        items: (items || []).map(item => ({ product_id: item.product_id, qty: item.qty })),
        tender: Object.assign({ type: "cash", paid: true }, tender || {}),
        cashier: cashier || null,
        customer_name: String(customer_name || "Walk-in Guest").trim(),
        customer_phone: String(customer_phone || "").trim(),
        customer_address: String(customer_location || "").trim(),
        delivery_type: "pickup",
        delivery_fee: 0,
        delivery_notes: String(customer_notes || "").trim(),
        status: "completed",
        dispatch_status: "Delivered"
      };
      const data = await apiRequest("/api/orders", {
        method: "POST",
        body: JSON.stringify(payload)
      }, true);
      const remote = data.order;
      if (!remote) throw new Error("The server did not return the completed sale");
      const sale = Object.assign({}, remote, {
        tender: Object.assign({ paid: true }, remote.tender || payload.tender),
        customer_email: String(customer_email || "").trim(),
        customer_location: remote.customer_address || String(customer_location || "").trim(),
        delivery_address: remote.customer_address || String(customer_location || "").trim(),
        customer_notes: String(customer_notes || "").trim(),
        assigned_rider_id: null,
        assigned_rider_name: null
      });
      return tx("sales", st => {
        (data.products || []).forEach(product => {
          const local = byId(st.products, product.id);
          if (local) Object.assign(local, product);
        });
        const existing = byId(st.sales, sale.id);
        if (existing) Object.assign(existing, sale);
        else st.sales.push(sale);
        if (!st.ledger.some(line => line.sale_id === sale.id)) logSaleEntry(st, sale, cashier && cashier.name);

        const cName = sale.customer_name;
        const cPhone = sale.customer_phone;
        const cLocation = sale.customer_location;
        if (cName && cName !== "Walk-in Guest") {
          const existingGuest = st.guests.find(g =>
            (cPhone && g.phone && g.phone === cPhone) ||
            (g.name && g.name.toLowerCase() === cName.toLowerCase())
          );
          if (!existingGuest) {
            st.guests.push({
              id: "GUS-" + (++st.counters.guest), name: cName, phone: cPhone,
              email: sale.customer_email, address: cLocation, neighborhood: cLocation,
              notes: sale.customer_notes ? `Walk-in POS: ${sale.customer_notes}` : "Walk-in POS Customer",
              created_at: new Date().toISOString()
            });
          }
        }
        return JSON.parse(JSON.stringify(sale));
      });
    },
    async createWebOrder({ customer_name, customer_phone, delivery_type, delivery_area, delivery_address, delivery_fee, delivery_notes, items, lock_owner, payment_method, payer_account }) {
      const fee = delivery_type === "pickup" ? 0 : Number(delivery_fee != null ? delivery_fee : 7000);
      // Any channel other than pay-on-delivery is a "collect now" intent: the
      // server reserves the pieces, issues the per-order payment token and
      // tells us where the money has to go.
      const channel = String(payment_method || "").trim().toLowerCase();
      const wantsOnlinePayment = !!channel && channel !== "cod" && channel !== "cash";
      const data = await apiRequest("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          channel: "web",
          lock_owner: String(lock_owner || ""),
          items: (items || []).map(item => ({ product_id: item.product_id, qty: item.qty })),
          customer_name: String(customer_name || "Web customer").trim(),
          customer_phone: String(customer_phone || "").trim(),
          delivery_type: delivery_type || "boda",
          delivery_area: String(delivery_area || "Kampala Central / Nakasero").trim(),
          delivery_address: String(delivery_address || "").trim(),
          delivery_fee: fee,
          delivery_notes: String(delivery_notes || "").trim(),
          ...(wantsOnlinePayment ? { payment_method: channel, payer_account: String(payer_account || "").trim() } : {}),
          status: "unfulfilled",
          dispatch_status: "Unfulfilled"
        })
      }, false);
      const remote = data.order;
      if (!remote) throw new Error("The server did not return the placed order");
      const sale = Object.assign({}, remote, {
        delivery_address: remote.customer_address || String(delivery_address || "").trim(),
        cashier: null,
        tender: remote.tender || { type: "pending", paid: false },
        assigned_rider_id: null,
        assigned_rider_name: null
      });
      // tx() resolves with the callback's value; attaching the payment block
      // to the Promise itself (rather than to the awaited order) silently
      // dropped the token and made every collect-now order look unpaid.
      const stored = await tx("sales", st => {
        (data.products || []).forEach(product => {
          const local = byId(st.products, product.id);
          if (local) Object.assign(local, product);
        });
        const existing = byId(st.sales, sale.id);
        if (existing) Object.assign(existing, sale);
        else st.sales.push(sale);
        return JSON.parse(JSON.stringify(sale));
      });
      // The per-order payment token authorizes payment actions for this order.
      // It is handed back to the caller in memory only — it is never stored in
      // the local sales record.
      if (data.payment) stored.payment = data.payment;
      return stored;
    },

    /* ---------- online payments (Flutterwave Inline) ---------- */
    _paymentConfigCache: null,
    async getPaymentConfig(force = false) {
      if (this._paymentConfigCache && !force) return this._paymentConfigCache;
      try {
        const data = await apiRequest("/api/payments/config", { method: "GET" }, false);
        this._paymentConfigCache = Object.assign({ enabled: false, provider: "flutterwave", currency: "UGX" }, data || {});
      } catch (err) {
        this._paymentConfigCache = { enabled: false, provider: "flutterwave", currency: "UGX" };
      }
      return this._paymentConfigCache;
    },
    async createFlutterwaveSession(orderId, paymentToken, channel) {
      const data = await apiRequest("/api/payments/flutterwave/session", {
        method: "POST",
        body: JSON.stringify({
          order_id: String(orderId || ""),
          payment_token: String(paymentToken || ""),
          // Which rail to collect on: card, or momo (push prompt + PIN on the
          // shopper's phone). Bank / merchant orders are refused by the server.
          channel: String(channel || "")
        })
      }, false);
      if (!data || !data.tx_ref) throw new Error((data && data.error) || "Could not start the payment session");
      return data;
    },
    async verifyFlutterwavePayment(orderId, paymentToken, transactionId, txRef) {
      // 202 = gateway hasn't confirmed yet; not an exception — normalize it.
      try {
        return await apiRequest("/api/payments/flutterwave/verify", {
          method: "POST",
          body: JSON.stringify({
            order_id: String(orderId || ""),
            payment_token: String(paymentToken || ""),
            transaction_id: String(transactionId || ""),
            tx_ref: String(txRef || "")
          })
        }, false);
      } catch (err) {
        if (err && err.status && err.data) return Object.assign({ ok: false, payment_status: "pending" }, err.data);
        throw err;
      }
    },
    async fetchPaymentStatus(orderId, paymentToken) {
      const params = new URLSearchParams({ order_id: String(orderId || ""), token: String(paymentToken || "") });
      const data = await apiRequest("/api/payments/status?" + params.toString(), { method: "GET" }, false);
      return data || {};
    },
    /* Change how a not-yet-paid order will be settled. The server re-posts the
       money to the right account, so this is safe to call at any point before
       the payment lands. */
    async setPaymentChannel(orderId, paymentToken, paymentMethod, payerAccount) {
      return apiRequest("/api/payments/method", {
        method: "POST",
        body: JSON.stringify({
          order_id: String(orderId || ""),
          payment_token: String(paymentToken || ""),
          payment_method: String(paymentMethod || ""),
          payer_account: String(payerAccount || "")
        })
      }, false);
    },
    /* Ask the system for this order's merchant pay code (idempotent). */
    async requestMerchantPayCode(orderId, paymentToken) {
      const data = await apiRequest("/api/payments/merchant-code", {
        method: "POST",
        body: JSON.stringify({ order_id: String(orderId || ""), payment_token: String(paymentToken || "") })
      }, false);
      if (!data || !data.merchant_pay_code) throw new Error((data && data.error) || "Could not issue a pay code");
      return data;
    },
    /* The reconciliation trail for one order: every gateway attempt with its
       reference and Flutterwave transaction id. Staff-only view data. */
    async fetchOrderPaymentTrail(orderId) {
      try {
        return await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" }, true);
      } catch (err) {
        const message = (err && err.data && err.data.error) || (err && err.message) || "Could not load the payment trail";
        const failure = new Error(message);
        failure.status = err && err.status;
        throw failure;
      }
    },
    /* Counter lookup: which order does this merchant pay code belong to?
       Staff-only — it exposes the customer behind the code. */
    async findOrderByPayCode(code) {
      try {
        return await apiRequest("/api/payments/merchant-code/lookup", {
          method: "POST",
          body: JSON.stringify({ code: String(code || "").trim() })
        }, true);
      } catch (err) {
        const message = (err && err.data && err.data.error) || (err && err.message) || "Could not look up that pay code";
        const failure = new Error(message);
        failure.status = err && err.status;
        throw failure;
      }
    },
    /* Tell the store what the shopper paid. Records a claim for staff to
       verify — it never marks the order paid on its own. */
    async submitPaymentClaim(orderId, paymentToken, paymentMethod, reference) {
      try {
        return await apiRequest("/api/payments/claim", {
          method: "POST",
          body: JSON.stringify({
            order_id: String(orderId || ""),
            payment_token: String(paymentToken || ""),
            payment_method: String(paymentMethod || ""),
            reference: String(reference || "")
          })
        }, false);
      } catch (err) {
        if (err && err.status && err.data) return Object.assign({ ok: false }, err.data);
        throw err;
      }
    },
    /* Load the Flutterwave Inline SDK on demand (only when paying). */
    loadFlutterwaveScript() {
      if (window.FlutterwaveCheckout) return Promise.resolve(true);
      if (this._flwScriptPromise) return this._flwScriptPromise;
      this._flwScriptPromise = new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "https://checkout.flutterwave.com/v3.js";
        script.async = true;
        script.onload = () => resolve(!!window.FlutterwaveCheckout);
        script.onerror = () => { this._flwScriptPromise = null; resolve(false); };
        document.head.appendChild(script);
      });
      return this._flwScriptPromise;
    },
    confirmWebOrder(id, method, by) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (s.status === "cancelled") throw new Error("Order was cancelled");
        s.tender = { type: RECORDED_TENDERS.includes(method) ? method : "cash", paid: true, confirmed_by: by || "admin" };
        s.status = "completed";
        s.completed_at = new Date().toISOString();
        if (!st.ledger.some(l => l.sale_id === s.id)) {
          logSaleEntry(st, s, by || "admin");
        }
        return JSON.parse(JSON.stringify(s));
      });
    },
    /* Confirm money actually landed (mobile money, bank, merchant pay code,
       cash) or revert that confirmation. The SERVER is the source of truth:
       it records the payment attempt, moves the order to PAID and settles
       partner payables. The local cache is only updated afterwards, so a
       failed call can never leave a console showing money that never arrived. */
    async setPaymentStatus(id, paid, method = "cash", by = "admin", options = {}) {
      const opts = options || {};
      let serverResult = null;
      try {
        serverResult = await apiRequest(`/api/orders/${encodeURIComponent(id)}/payment`, {
          method: "POST",
          body: JSON.stringify({
            paid: paid ? true : false,
            payment_method: String(method || "cash"),
            reference: String(opts.reference || ""),
            note: String(opts.note || "")
          })
        }, true);
      } catch (err) {
        if (!err || !err.status) throw err;               // real network failure
        const message = (err.data && err.data.error) || err.message || "Payment status was not accepted";
        const failure = new Error(message);
        failure.status = err.status; failure.data = err.data;
        throw failure;
      }
      const confirmedAt = new Date().toISOString();
      const confirmedBy = by || "admin";
      tx("sales", st => {
        const s = byId(st.sales, id); if (!s) return;
        if (paid) {
          const m = RECORDED_TENDERS.includes(method) ? method : "cash";
          if (!s.tender) s.tender = {};
          s.tender.type = m;
          s.tender.paid = true;
          s.tender.confirmed_by = confirmedBy;
          s.tender.confirmed_at = confirmedAt;
          if (s.payment) { s.payment.status = "paid"; s.payment.channel = m; }
          if (!st.ledger.some(l => l.sale_id === s.id)) {
            logSaleEntry(st, s, confirmedBy);
          }
        } else {
          s.tender = { type: "whatsapp", paid: false };
          if (s.payment) s.payment.status = s.payment.channel ? "pending" : "unpaid";
          st.ledger = st.ledger.filter(l => l.sale_id !== s.id);
        }
      });
      return serverResult;
    },
    async updateOrderFulfillment(id, fulfillment_status, extra) {
      const data = await apiRequest("/api/orders/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(Object.assign({ fulfillment_status }, extra || {}))
      }, true);
      if (!data.order) throw new Error("The server did not return the updated order");
      const remoteOrder = normalizeSaleRecord(data.order);
      return tx("sales", st => {
        const local = byId(st.sales, id);
        if (local) Object.assign(local, remoteOrder, {
          delivery_address: remoteOrder.customer_address || local.delivery_address || ""
        });
        else st.sales.push(remoteOrder);
        return JSON.parse(JSON.stringify(remoteOrder));
      });
    },
    cancelWebOrder(id) {
      return this.updateOrderFulfillment(id, "Cancelled");
    },
    async assignRiderToOrder(orderId, riderId) {
      const data = await apiRequest("/api/dispatch/orders/" + encodeURIComponent(orderId) + "/assign", {method:"POST", body:JSON.stringify({rider_id:riderId})}, true);
      if (!data.order) throw new Error("The server did not return the dispatched order");
      const order = normalizeSaleRecord(data.order);
      await tx("sales", st => {
        const local = byId(st.sales, orderId);
        if (local) Object.assign(local, order); else st.sales.push(order);
      });
      await pullOperationalData();
      // Server result of the rider WhatsApp message ({status, error, wa_link}); not stored locally.
      order.rider_notice = data.rider_notice || null;
      return order;
    },
    /* Removes an assigned/completed order from the working Orders list only; the record and exports stay. */
    async setOrderListVisibility(orderId, visible) {
      const data = await apiRequest("/api/orders/" + encodeURIComponent(orderId) + (visible ? "/list-restore" : "/list-archive"), {method:"POST", body:"{}"}, true);
      if (!data.order) throw new Error("The server did not return the order");
      const order = normalizeSaleRecord(data.order);
      await tx("sales", st => { const local = byId(st.sales, orderId); if (local) Object.assign(local, order); else st.sales.push(order); });
      return order;
    },
    listSales() { reload(); return state.sales.map(s => JSON.parse(JSON.stringify(s))).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    getSale(id) { reload(); const s = byId(state.sales, id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    setDispatchStatus(id, dispatch_status) {
      if (!DISPATCH_STATUSES.includes(dispatch_status) && dispatch_status !== "Cancelled") {
        return Promise.reject(new Error("Unknown fulfillment stage"));
      }
      return this.updateOrderFulfillment(id, dispatch_status);
    },

    /* ----- guest book ----- */
    listGuests() { reload(); return state.guests.map(g => Object.assign({}, g)).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    addGuest(g) {
      return tx("guests", st => {
        if (!shakeOn(g.name)) throw new Error("Guest name is required");
        const rec = {
          id: "GUS-" + (++st.counters.guest),
          name: shakeOn(g.name), phone: shakeOn(g.phone), email: shakeOn(g.email),
          address: shakeOn(g.address), neighborhood: shakeOn(g.neighborhood), notes: shakeOn(g.notes),
          created_at: new Date().toISOString()
        };
        st.guests.push(rec);
        return Object.assign({}, rec);
      });
    },
    updateGuest(id, patch) {
      return tx("guests", st => {
        const g = byId(st.guests, id); if (!g) throw new Error("Guest not found");
        ["name", "phone", "email", "address", "neighborhood", "notes"].forEach(k => { if (patch[k] !== undefined) g[k] = shakeOn(patch[k]); });
        return Object.assign({}, g);
      });
    },
    removeGuest(id) {
      return tx("guests", st => { st.guests = st.guests.filter(g => g.id !== id); return true; });
    },

    /* ----- boda riders ----- */
    listRiders() { reload(); return state.riders.map(r => Object.assign({}, r)); },
    async updateRider(id, patch) {
      const data = await apiRequest("/api/riders/" + encodeURIComponent(id), {method:"PATCH", body:JSON.stringify(patch)}, true);
      if (!data.rider) throw new Error("The server did not save rider details");
      return tx("riders", st => {const old=byId(st.riders,id);if(old) Object.assign(old,data.rider);else st.riders.push(data.rider);return data.rider;});
    },
    async addRider(rider) {
      const data = await apiRequest("/api/riders", {method:"POST", body:JSON.stringify(rider)}, true);
      if (!data.rider) throw new Error("The server did not save the rider");
      return tx("riders", st => {st.riders.push(data.rider);return data.rider;});
    },
    async removeRider(id) {
      await apiRequest("/api/riders/"+encodeURIComponent(id), {method:"DELETE"}, true);
      return tx("riders", st => {st.riders=st.riders.filter(r=>r.id!==id);return true;});
    },
    getDispatchBoard(signal) {return apiRequest("/api/dispatch/board", {signal}, true);},
    pairRiderPhone(id) {return apiRequest("/api/dispatch/riders/"+encodeURIComponent(id)+"/pair", {method:"POST",body:"{}"}, true);},
    deliveryAppCode(id) {return apiRequest("/api/dispatch/riders/"+encodeURIComponent(id)+"/app-code", {method:"POST",body:"{}"}, true);},
    revokeRiderPhone(id) {return apiRequest("/api/dispatch/riders/"+encodeURIComponent(id)+"/revoke", {method:"POST",body:"{}"}, true);},

    /* ----- authoritative, scoped report downloads ----- */
    async prepareExport(options, signal) {
      const data = await apiRequest("/api/exports/prepare", {
        method: "POST", body: JSON.stringify(options || {}), signal, timeoutMs: 120000
      }, true);
      if (!data.download || !data.download.url) throw new Error("The report could not be prepared. Try again.");
      return Object.assign({}, data.download, { url: apiUrl(data.download.url) });
    },

    /* ----- durable garment media (bytes never enter browser DB) ----- */
    async uploadMedia(file, kind, signal) {
      if (!["image", "video"].includes(kind)) throw new Error("Choose a photo or video");
      const data = await apiRequest("/api/media/" + (kind === "video" ? "videos" : "images"), {
        method: "POST", body: file, signal, timeoutMs: kind === "video" ? 210000 : 60000,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name || "garment") }
      }, true);
      if (!data.media || !data.media.id) throw new Error("The upload did not complete. Please try again.");
      return Object.assign({}, data.media, { url: apiUrl(data.media.url) });
    },
    async uploadPromotionHtml(file, signal) {
      if (!file || !/\.html?$/i.test(String(file.name || ""))) throw new Error("Choose an .html or .htm banner file");
      const data = await apiRequest("/api/promo-media/html", {
        method: "POST", body: file, signal, timeoutMs: 60000,
        headers: { "Content-Type": file.type || "text/html", "X-File-Name": encodeURIComponent(file.name || "promotion.html") }
      }, true);
      if (!data.creative || !data.creative.id) throw new Error("The HTML banner upload did not complete. Please try again.");
      return Object.assign({}, data.creative, { url: apiUrl(data.creative.url) });
    },
    async mediaPreview(id, signal) {
      if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new Error("Invalid media reference");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }
      const timer = setTimeout(abort, 60000);
      try {
        const response = await fetch(apiUrl("/api/media/" + id), {
          method: "GET", signal: controller.signal,
          headers: Object.assign(apiHeaders(true), { "X-Adonai-Media-Preview": "1" }, typeof PosAccess !== "undefined" && PosAccess.headers ? PosAccess.headers() : {})
        });
        if (!response.ok) throw new Error("Preview could not load. The uploaded video will be available after saving.");
        return await response.blob();
      } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort); }
    },
    discardMedia(id) {
      if (!/^[a-f0-9]{32}$/.test(String(id || ""))) return Promise.resolve(false);
      return apiRequest("/api/media/" + id, { method: "DELETE" }, true, true);
    },

    /* ----- live backend financials & POS holds ----- */
    pullProducts,
    pullOperationalData,
    productsSynced: () => productsSynced,
    financeRequest(path, options) {
      const suffix = String(path || "").replace(/^\//, "");
      return apiRequest("/api/finance/" + suffix, options || { method: "GET" }, true);
    },
    consignmentRequest(path, options) {
      const suffix = String(path || "").replace(/^\//, "");
      return apiRequest("/api/consignment/" + suffix, options || { method: "GET" }, true);
    },
    acquireInventoryLock(productId, lockOwner, quantity = 1) {
      const publicReservation = String(lockOwner || "").startsWith("WEB-");
      return apiRequest("/api/inventory-locks/acquire", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, lock_owner: lockOwner, quantity })
      }, !publicReservation);
    },
    releaseInventoryLock(productId, lockOwner, quantity = 1) {
      const publicReservation = String(lockOwner || "").startsWith("WEB-");
      return apiRequest("/api/inventory-locks/release", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, lock_owner: lockOwner, quantity })
      }, !publicReservation);
    },
    releaseInventoryLockOwner(lockOwner, keepalive = false) {
      const publicReservation = String(lockOwner || "").startsWith("WEB-");
      return apiRequest("/api/inventory-locks/release-owner", {
        method: "POST",
        keepalive: !!keepalive,
        body: JSON.stringify({ lock_owner: lockOwner })
      }, !publicReservation);
    },
    heartbeatInventoryLocks(lockOwner) {
      const publicReservation = String(lockOwner || "").startsWith("WEB-");
      return apiRequest("/api/inventory-locks/heartbeat", {
        method: "POST",
        body: JSON.stringify({ lock_owner: lockOwner })
      }, !publicReservation);
    },

    /* ----- legacy financial ledger compatibility ----- */
    listLedger() { reload(); return state.ledger.map(e => Object.assign({}, e)).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    addLedgerEntry({ kind, amount, label, channel, by }) {
      return tx("ledger", st => {
        if (!LEDGER_KINDS.includes(kind)) throw new Error("Unknown entry category");
        const amt = money(amount);
        if (!amt) throw new Error("Amount is required");
        const signed = (kind === "expense" || kind === "refund") ? -Math.abs(amt) : Math.abs(amt);
        const rec = {
          id: "LED-" + (++st.counters.ledger),
          kind, amount: signed,
          label: shakeOn(label) || LEDGER_KIND_LABELS[kind],
          note: `Logged by ${shakeOn(by) || "console"} · ${channel === "momo" ? "MTN MoMo" : channel === "airtel" ? "Airtel Money" : "Cash"}`,
          channel: channel || "cash", by: shakeOn(by) || "console",
          created_at: new Date().toISOString(), sale_id: null
        };
        st.ledger.push(rec);
        return Object.assign({}, rec);
      });
    },
    removeLedgerEntry(id) {
      return tx("ledger", st => {
        const e = byId(st.ledger, id);
        if (e && e.kind === "sale") throw new Error("Auto-logged sales can only be reversed via a refund entry");
        st.ledger = st.ledger.filter(x => x.id !== id);
        return true;
      });
    },
    ledgerSummary() {
      reload();
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      return state.ledger.reduce((acc, e) => {
        if (e.amount > 0) acc.revenue += e.amount; else acc.outflow += e.amount;
        if (e.amount > 0 && new Date(e.created_at) >= midnight) acc.todaySales += e.amount;
        return acc;
      }, { revenue: 0, outflow: 0, todaySales: 0 });
    },

    /* ----- admin ----- */
    resetToSeed() {
      return tx("*", st => { const fresh = seedState(); Object.keys(st).forEach(k => delete st[k]); Object.assign(st, fresh); return true; });
    },
    /** HARD FACTORY RESET — wipes every adonai* browser key (old DB copies,
        carts, sessions, tokens, notifications, analytics) and reseeds the
        clean Day-1 state. Reload after calling. */
    factoryReset() {
      try { storage.removeItem(LS_KEY); } catch (e) {}
      try { storage.removeItem(PURGE_FLAG); } catch (e) {}
      purgeLegacyCaches();
      state = null;
      reload();
      broadcast("*");
      return true;
    },
    ugx(n) { return "UGX " + money(n).toLocaleString("en-US"); },
    laneOf: orderLanes,
    barcodeSVG: generateBarcodeSVG,
    apiUrl: apiUrl,
    canonicalMediaRef: canonicalMediaRef
  };
})(typeof window !== "undefined" ? window : globalThis);
