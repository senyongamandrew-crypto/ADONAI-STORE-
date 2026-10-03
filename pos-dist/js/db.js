/* ============================================================
   ADONAI THRIFT STORE — CENTRAL REAL-TIME DB ENGINE (DB)
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

  const LS_KEY   = "adonai-db-v6";   // v6: guest book, riders, ledger, staff roster, master-key
  const CHANNEL  = "adonai-db-v6-sync";
  const LOCK     = "adonai-thrift-db-tx";

  /* ---------- storage (localStorage, in-memory fallback for tests) ---------- */
  const _mem = {};
  const storage = (typeof localStorage !== "undefined") ? localStorage : {
    getItem: k => (Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null),
    setItem: (k, v) => { _mem[k] = String(v); },
    removeItem: k => { delete _mem[k]; }
  };

  /* ---------- domain constants ---------- */
  const CATEGORIES    = ["Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories", "Children Wear"];
  const DEMO_CODES    = { "Men": "MEN", "Women": "WOM", "Children": "KID", "Unisex": "UNI" };
  const CONDITIONS    = ["Grade A — Excellent", "Grade B — Good", "Vintage / Collector"];
  // Unisex is a first-class demographic so it is available in inventory,
  // cashier filters, and the public storefront filters.
  const DEMOGRAPHICS  = ["Men", "Women", "Children", "Unisex"];
  const CAT_CODES     = { "Outerwear & Jackets": "JKT", "Tops & Shirts": "TOP", "Dresses & Skirts": "DRS", "Pants & Jeans": "PNT", "Shoes": "SHO", "Accessories": "ACC", "Children Wear": "CHD" };
  const TENDER_TYPES  = ["cash", "mtn", "airtel"];
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
  const orderLanes = s => {
    if (s.status === "cancelled" || s.dispatch_status === "Cancelled") return "completed";
    const d = s.dispatch_status || (s.channel === "web" ? "Unfulfilled" : "Completed");
    if (d === "Unfulfilled" || d === "Pending" || d === "Incoming") return "incoming";
    if (d === "In Assembly" || d === "Packed") return "fulfillment";
    if (d === "Ready for Pickup" || d === "Dispatched" || d === "With rider" || d === "Handed over") return "ready";
    return "completed";
  };
  // SECURITY: there is no default/sandbox master key. Admin access requires a
  // key explicitly configured by the owner (environment variable on the server
  // or System Parameters). The old published default has been retired.
  const DEFAULT_MASTER_KEY = "";
  // Live Render deployment — the public storefront and the API are served by the
  // same service. Fallback base used when the POS/admin runs inside the Android
  // APK shell (appassets origin) or another non-web container.
  const DEFAULT_WEB_APP_URL = "https://adonai-store.onrender.com";

  /* ---------- seed data ---------- */
  function seedProducts() {
    const A = "Grade A — Excellent", B = "Grade B — Good", V = "Vintage / Collector";
    const raw = [
      ["Indigo Type III Trucker Jacket", "Levi's", "Indigo", "Men", "Outerwear & Jackets", "L", A, 40000, 68000, 120000, 1, "1980s trucker jacket. Authentic vintage wash with whiskers and brass buttons intact."],
      ["Olive Waxed Field Jacket", "Barbour Style", "Olive", "Men", "Outerwear & Jackets", "XL", B, 55000, 85000, 150000, 1, "Matte waxed cotton with a corduroy collar. Windproof and rain-resistant."],
      ["Cream Silk Slip Dress", "Unbranded", "Cream", "Women", "Dresses & Skirts", "S", V, 45000, 78000, 130000, 1, "Bias-cut silk slip from the 90s — fluid drape, adjustable straps."],
      ["Black Leather Chelsea Boots", "Clarks", "Black", "Men", "Shoes", "43", B, 60000, 95000, 170000, 1, "Polished leather uppers with elastic gussets. Resoled once — plenty of life left."],
      ["White Oxford Button-Down", "Ralph Lauren", "White", "Men", "Tops & Shirts", "L", A, 20000, 38000, 75000, 2, "Crisp cotton oxford with single-needle stitching. Lightly worn."],
      ["Emerald Velvet Tailored Blazer", "Vintage Boutique", "Emerald Green", "Women", "Outerwear & Jackets", "M", A, 35000, 60000, 110000, 1, "Plush cotton-velvet tailored blazer in deep emerald with satin lapels and structured shoulders."],
      ["Pleated Midi Skirt", "Unbranded", "Rust", "Women", "Dresses & Skirts", "M", A, 18000, 35000, 65000, 1, "Satin pleats with a comfortable elastic waist — moves beautifully."],
      ["Ankara Print Wrap Dress", "Hand-made", "Multi", "Women", "Dresses & Skirts", "M", A, 32000, 55000, 95000, 1, "Kitenge wax-print wrap tailored in Kampala. Wears like new."],
      ["High-Waist 501 Jeans", "Levi's", "Mid-wash", "Women", "Pants & Jeans", "30", B, 26000, 48000, 85000, 2, "Classic straight leg with button fly. Honest fade at the knees."],
      ["Khaki Pleated Chinos", "Dockers", "Khaki", "Men", "Pants & Jeans", "32", B, 15000, 30000, 55000, 1, "Relaxed pleat-front, freshly hemmed. Office-ready."],
      ["Canvas Field Tote", "Unbranded", "Natural", "Women", "Accessories", "-", A, 10000, 22000, 40000, 1, "Heavy canvas tote with leather handles and a spotless interior."],
      ["Tan Leather Belt", "Unbranded", "Tan", "Men", "Accessories", "34", B, 9000, 18000, 32000, 2, "Full-grain leather with a brass buckle — broken in just right."],
      ["Kids' Denim Jacket", "OshKosh", "Light wash", "Children", "Children Wear", "8y", B, 13000, 25000, 45000, 1, "Sturdy kids' denim with room to grow. All snaps working."],
      ["Silk Printed Scarf", "Unbranded", "Paisley", "Women", "Accessories", "-", V, 13000, 26000, 48000, 1, "Hand-rolled 70s silk square. No pulls, no stains."],
      ["Retro Running Trainers", "Nike", "White / Gum", "Men", "Shoes", "44", B, 30000, 55000, 98000, 1, "Retro runner on a gum sole. Cleaned and disinfected."],
      ["Floral Summer Blouse", "Unbranded", "Floral", "Women", "Tops & Shirts", "S", A, 14000, 28000, 50000, 1, "Airy rayon blouse with covered buttons. Zero pilling."]
    ];
    const IMGS = Array.from({ length: 16 }, (_, i) => `assets/products/p${1001 + i}.jpg`);
    return raw.map((r, i) => ({
      id: "PRD-" + String(1001 + i),
      sku: "ADN-" + (DEMO_CODES[r[3]] || "GEN") + "-" + String(1001 + i),
      barcode_id: "ADT-" + String(10001 + i),
      name: r[0], brand: r[1], color: r[2], demographic: r[3],
      category: r[4], size: r[5], condition: r[6],
      cost_price: r[7], selling_price: r[8], compare_price: r[9],
      in_stock_count: r[10], desc: r[11],
      // Curated local photography — staff replace with the real photo(s) at intake.
      image_url: IMGS[i], images: [],
      created_at: new Date(Date.now() - (30 - i) * 86400000).toISOString()
    }));
  }

  /* Slim reference dataset: ONE register sale + ONE ledger expense (matches the
     accepted console walkthrough screens — clean book for go-live). */
  function seedSales(products) {
    const jacket = products[0]; // Indigo Type III Trucker Jacket — UGX 68,000
    const when = new Date(Date.now() - 26 * 3600000).toISOString();
    const items = [{ product_id: jacket.id, barcode_id: jacket.barcode_id, name: jacket.name, qty: 1, unit_price: jacket.selling_price, line_total: jacket.selling_price }];
    return { sales: [{
      id: "AT-1841", channel: "pos", status: "completed", created_at: when,
      customer_name: "Amina Namubiru", customer_phone: "+256772123456",
      cashier: { name: "Priya Shah", id: "STF-06" },
      items, total: jacket.selling_price, dispatch_status: "Delivered",
      tender: { type: "cash", tendered: 70000, change: 2000 }
    }], posN: 1841, webN: 1000 };
  }

  function seedLedger(sale) {
    return [
      { id: "LED-1001", kind: "sale", amount: sale.total,
        label: "Register sale " + sale.id + " · " + sale.items[0].name.replace("Indigo Type III ", "Indigo "),
        note: "Logged by " + sale.cashier.name + " · Cash",
        channel: "cash", by: sale.cashier.name, created_at: sale.created_at, sale_id: sale.id },
      { id: "LED-1002", kind: "expense", amount: -15000,
        label: "Rider fuel float — Central & Nakasero zone",
        note: "Logged by Luis Ortega · Cash",
        channel: "cash", by: "Luis Ortega",
        created_at: new Date(Date.now() - 25 * 3600000).toISOString(), sale_id: null }
    ];
  }

  const seedGuests = () => ([
    { id: "GUS-1001", name: "Noor Batte",       phone: "+256 7545 67890", email: "",                      address: "Tank Hill Road", neighborhood: "Muyenga",  notes: "Deliver with care. Loves vintage knitwear.",        created_at: new Date(Date.now() - 21 * 86400000).toISOString() },
    { id: "GUS-1002", name: "Chris Mukasa",     phone: "+256 7823 45678", email: "chrismukasa@gmail.com", address: "Ntinda View Heights, Block B", neighborhood: "Ntinda", notes: "Pickup or boda delivery after 5 PM.",                 created_at: new Date(Date.now() - 15 * 86400000).toISOString() },
    { id: "GUS-1003", name: "Amina Namubiru",   phone: "+256 7721 23456", email: "amina.namubiru@gmail.com", address: "Plot 8 Kololo Terrace", neighborhood: "Kololo", notes: "Prefers WhatsApp delivery alerts. Regular buyer of vintage dresses.", created_at: new Date(Date.now() - 9 * 86400000).toISOString() },
    { id: "GUS-1004", name: "Beatrice Kiconco", phone: "+256 7012 34567", email: "",                      address: "Bugolobi Flats, Block 12", neighborhood: "Bugolobi", notes: "Pays via MTN Mobile Money on delivery.",             created_at: new Date(Date.now() - 4 * 86400000).toISOString() }
  ]);

  /* Open-access roster — identities seeded for assignment/notes only; passkeys
     stay EMPTY until the admin sets them and flips the access lock. */
  const seedStaff = () => ([
    { id: "STF-01", name: "Amara Adeyemi", email: "amara@adonaithrift.store",  phone: "+256 7588 73398",  role: "admin",   pin: "", active: true,  created_at: new Date(Date.now() - 40 * 86400000).toISOString() },
    { id: "STF-02", name: "Elena Varga",   email: "elena@adonaithrift.store",  phone: "+256 7023 45678",  role: "rider",   pin: "", active: true,  created_at: new Date(Date.now() - 38 * 86400000).toISOString() },
    { id: "STF-03", name: "Jonah Hale",    email: "jonah@adonaithrift.store",  phone: "+256 7588 73390",  role: "cashier", pin: "", active: true,  created_at: new Date(Date.now() - 35 * 86400000).toISOString() },
    { id: "STF-04", name: "Kofi Mensah",   email: "kofi@adonaithrift.store",   phone: "+256 7012 34567",  role: "rider",   pin: "", active: true,  created_at: new Date(Date.now() - 33 * 86400000).toISOString() },
    { id: "STF-05", name: "Luis Ortega",   email: "luis@adonaithrift.store",   phone: "+256 7656 52403",  role: "manager", pin: "", active: true,  created_at: new Date(Date.now() - 30 * 86400000).toISOString() },
    { id: "STF-06", name: "Priya Shah",    email: "priya@adonaithrift.store",  phone: "+256 7588 73399",  role: "cashier", pin: "", active: true,  created_at: new Date(Date.now() - 28 * 86400000).toISOString() },
    { id: "STF-07", name: "Samir Okello",  email: "samir@adonaithrift.store",  phone: "+256 7034 56789",  role: "rider",   pin: "", active: false, created_at: new Date(Date.now() - 25 * 86400000).toISOString() }
  ]);

  const seedRiders = () => ([
    { id: "RDR-1001", name: "Elena Varga",  phone: "+256 7023 45678", vehicle: "Boda express",   zone: "Ntinda & Bukoto",              status: "On delivery" },
    { id: "RDR-1002", name: "Kofi Mensah",  phone: "+256 7012 34567", vehicle: "Motorbike (Boda)", zone: "Central Kampala & Nakasero", status: "Available"   },
    { id: "RDR-1003", name: "Samir Okello", phone: "+256 7034 56789", vehicle: "Motorbike (Boda)", zone: "Entebbe & Mukono corridor",  status: "Available"   }
  ]);

  function seedState() {
    const products = seedProducts();
    const { sales, posN, webN } = seedSales(products);
    return {
      version: 3,
      settings: {
        store_name: "Adonai Thrift Store",
        tagline: "Curated pre-loved vintage · Laundered, graded and sold once",
        address: "Plot 45 Salama Road / kibuli Kampala, Uganda",
        whatsapp: "256758893398",
        whatsapp_display: "+256 7588 73398",
        hotline: "+256 7656 52403",
        email: "adonaithriftstore@gmail.com",
        tiktok: "@adonai.thrift256",
        instagram: "@adonaithrift256",
        hours: "Mon - Sat: 8:30 AM - 7:30 PM | Sun: 10:00 AM - 6:00 PM",
        delivery_scope: "Uganda (Central, Eastern, and Western regions)",
        base_delivery_fee: 7000,
        currency: "UGX",
        access_locked: false,               // OPEN ACCESS MODE until admin sets a key crew & flips the lock
        admin_key: ""                       // set a strong master key in System Parameters after onboarding
      },
      products,
      sales,
      ledger: seedLedger(sales[0]),
      guests: seedGuests(),
      riders: seedRiders(),
      staff: seedStaff(),
      counters: { product: 1016, sale_seq: 1861, sale_pos: posN, sale_web: webN, guest: 1004, rider: 1003, ledger: 1002 }
    };
  }

  /* ---------- state & realtime plumbing ---------- */
  let state = null;
  const subs = []; // {table, cb}

  function reload() {
    if (state) return;
    let raw = null;
    try { raw = storage.getItem(LS_KEY); } catch (e) { raw = null; }
    let ok = true;
    if (raw) { try { state = JSON.parse(raw); ok = valid(state); } catch (e) { ok = false; } }
    if (!raw || !ok) { state = seedState(); save(); }
  }
  function save() {
    try { storage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* quota — ignore */ }
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
    subs.filter(s => s.table === table || s.table === "*").forEach(s => { try { s.cb(table); } catch (e) {} });
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
  function pullProducts(publicAvailability) {
    if (productSyncInFlight || typeof fetch === "undefined") return productSyncInFlight || Promise.resolve(false);
    const isPublic = publicAvailability === true || (typeof window !== "undefined" && window.__ADONAI_STOREFRONT__ === true);
    const endpoint = "/api/products" + (isPublic ? "?availability=public" : "");
    productSyncInFlight = fetch(apiUrl(endpoint), { method: "GET", cache: "no-store" })
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (e) {}
        if (!response.ok || !data || !Array.isArray(data.products)) return false;
        reload();
        const before = JSON.stringify(state.products || []);
        const after = JSON.stringify(data.products);
        if (before === after) return false;
        state.products = data.products;
        save();
        broadcast("products");
        return true;
      })
      .catch(() => false)
      .finally(() => { productSyncInFlight = null; });
    return productSyncInFlight;
  }

  let operationalSyncInFlight = null;
  function pullOperationalData() {
    if (operationalSyncInFlight || typeof fetch === "undefined") return operationalSyncInFlight || Promise.resolve(false);
    const authH = (typeof Auth !== "undefined" && Auth.authHeaders) ? Auth.authHeaders() : {};
    operationalSyncInFlight = fetch(apiUrl("/api/sync/pull"), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authH),
      cache: "no-store"
    }).then(async response => {
      let data = null;
      try { data = await response.json(); } catch (e) {}
      if (!response.ok || !data || !Array.isArray(data.products)) return false;
      reload();
      state.products = data.products;
      if (Array.isArray(data.sales)) state.sales = data.sales;
      if (Array.isArray(data.ledger)) state.ledger = data.ledger.map(line => Object.assign({
        label: line.desc || `${line.kind} ${line.ref_id || ""}`,
        note: line.staff ? `Logged by ${line.staff}` : "",
        by: line.staff || "System",
        sale_id: line.ref_id || null
      }, line));
      save();
      if (data.settings) applyRemoteSettings(data.settings);
      broadcast("*");
      return true;
    }).catch(() => false).finally(() => { operationalSyncInFlight = null; });
    return operationalSyncInFlight;
  }

  function initRealtime(iface) {
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = ev => {
        state = null; reload(); /* re-read shared cache */
        subs.filter(s => s.table === ev.data.table || s.table === "*").forEach(s => { try { s.cb(ev.data.table); } catch (e) {} });
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
      window.setInterval(() => {
        if (!document.hidden) {
          pullStoreSettings();
          if (window.__ADONAI_STOREFRONT__ === true) pullProducts(true);
          else pullOperationalData();
        }
      }, 5000);

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
  initRealtime();

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

  async function apiRequest(path, options = {}, withAuth = true) {
    const response = await fetch(apiUrl(path), Object.assign({}, options, {
      headers: Object.assign(apiHeaders(withAuth), options.headers || {})
    }));
    let data = null;
    try { data = await response.json(); } catch (e) {}
    if (!response.ok) {
      const error = new Error((data && (data.error || data.details)) || `Server request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
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
    CATEGORIES, CONDITIONS, DEMOGRAPHICS, CAT_CODES, TENDER_TYPES, DISPATCH_STATUSES,
    RIDER_STATUSES, STAFF_ROLES, ROLE_LABELS, LEDGER_KINDS, LEDGER_KIND_LABELS,
    ORDER_LANES: orderLanes, DEFAULT_MASTER_KEY, TENDER_LABEL: tenderLabel,

    on(table, cb) { const s = { table, cb }; subs.push(s); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); }; },
    reloadNow() { state = null; reload(); },

    /* ----- settings ----- */
    getSettings() { reload(); return Object.assign({}, state.settings); },
    updateSettings(patch) {
      return tx("settings", st => {
        Object.keys(patch).forEach(k => { st.settings[k] = patch[k]; });
        return Object.assign({}, st.settings);
      });
    },
    pullStoreSettings,
    syncStoreSettings(patch, adminCredential) {
      const cleanPatch = Object.assign({}, patch || {});
      const credential = String(adminCredential || "").trim();
      const headers = { "Content-Type": "application/json" };

      if (credential) {
        if (credential.split(".").length === 3) headers.Authorization = "Bearer " + credential;
        else headers["X-Terminal-Key"] = credential;
      } else if (typeof Auth !== "undefined" && Auth.authHeaders) {
        Object.assign(headers, Auth.authHeaders());
      }

      return fetch(apiUrl("/api/settings"), {
        method: "POST",
        headers,
        body: JSON.stringify({ settings: cleanPatch })
      }).then(async response => {
        let data = null;
        try { data = await response.json(); } catch (e) {}
        if (!response.ok || !data || !data.ok) {
          const message = data && data.error
            ? data.error
            : "Could not publish settings to the live storefront";
          throw new Error(message);
        }

        const publicSettings = normalizeRemoteSettings(data.settings || {});
        return tx("settings", st => {
          Object.keys(publicSettings).forEach(key => { st.settings[key] = publicSettings[key]; });
          // The server never returns secret values. Keep the locally verified
          // master key in the admin_key slot only after the remote save succeeds.
          if (cleanPatch.master_key) st.settings.admin_key = String(cleanPatch.master_key);
          else if (cleanPatch.admin_key) st.settings.admin_key = String(cleanPatch.admin_key);
          return Object.assign({}, st.settings);
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
      const product = data.product;
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
      const product = data.product;
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
    async removeProduct(id) {
      await apiRequest("/api/products/" + encodeURIComponent(id), {
        method: "DELETE",
        body: "{}"
      }, true);
      return tx("products", st => {
        st.products = st.products.filter(product => product.id !== id);
        return true;
      });
    },

    /* ----- sales (POS + web storefront, unified) ----- */
    async processPosSale({ items, tender, cashier, customer_name, customer_phone, customer_location, customer_email, customer_notes, lock_owner }) {
      // The POS intentionally supports open access while the local access lock
      // is off. In that mode there is no JWT to use for the protected server
      // checkout, so complete the sale against the same local DB used by the
      // catalogue. Once a cashier signs in, the existing atomic API path below
      // remains the source of truth for shared stock and accounting.
      const token = (typeof Auth !== "undefined" && Auth.token) ? Auth.token() : "";
      const accessLocked = (typeof Auth !== "undefined" && Auth.locked) ? Auth.locked() : false;
      if (!token && !accessLocked) {
        return processLocalPosSale({
          items, tender, cashier, customer_name, customer_phone,
          customer_location, customer_email, customer_notes
        });
      }

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
    async createWebOrder({ customer_name, customer_phone, delivery_type, delivery_area, delivery_address, delivery_fee, delivery_notes, items }) {
      const fee = delivery_type === "pickup" ? 0 : Number(delivery_fee != null ? delivery_fee : 7000);
      const data = await apiRequest("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          channel: "web",
          items: (items || []).map(item => ({ product_id: item.product_id, qty: item.qty })),
          customer_name: String(customer_name || "Web customer").trim(),
          customer_phone: String(customer_phone || "").trim(),
          delivery_type: delivery_type || "boda",
          delivery_area: String(delivery_area || "Kampala Central / Nakasero").trim(),
          delivery_address: String(delivery_address || "").trim(),
          delivery_fee: fee,
          delivery_notes: String(delivery_notes || "").trim(),
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
      return tx("sales", st => {
        (data.products || []).forEach(product => {
          const local = byId(st.products, product.id);
          if (local) Object.assign(local, product);
        });
        const existing = byId(st.sales, sale.id);
        if (existing) Object.assign(existing, sale);
        else st.sales.push(sale);
        return JSON.parse(JSON.stringify(sale));
      });
    },
    confirmWebOrder(id, method, by) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (s.status === "cancelled") throw new Error("Order was cancelled");
        s.tender = { type: TENDER_TYPES.includes(method) ? method : "cash", paid: true, confirmed_by: by || "admin" };
        s.status = "completed";
        s.completed_at = new Date().toISOString();
        if (!st.ledger.some(l => l.sale_id === s.id)) {
          logSaleEntry(st, s, by || "admin");
        }
        return JSON.parse(JSON.stringify(s));
      });
    },
    setPaymentStatus(id, paid, method = "cash", by = "admin") {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (s.status === "cancelled") throw new Error("Order is cancelled");
        if (paid) {
          const m = TENDER_TYPES.includes(method) ? method : "cash";
          s.tender = {
            type: m,
            paid: true,
            confirmed_by: by || "admin",
            confirmed_at: new Date().toISOString()
          };
          if (!st.ledger.some(l => l.sale_id === s.id)) {
            logSaleEntry(st, s, by || "admin");
          }
        } else {
          s.tender = { type: "whatsapp", paid: false };
          st.ledger = st.ledger.filter(l => l.sale_id !== s.id);
        }
        return JSON.parse(JSON.stringify(s));
      });
    },
    async updateOrderFulfillment(id, fulfillment_status, extra) {
      const data = await apiRequest("/api/orders/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(Object.assign({ fulfillment_status }, extra || {}))
      }, true);
      if (!data.order) throw new Error("The server did not return the updated order");
      return tx("sales", st => {
        const local = byId(st.sales, id);
        if (local) Object.assign(local, data.order, {
          delivery_address: data.order.customer_address || local.delivery_address || ""
        });
        else st.sales.push(data.order);
        return JSON.parse(JSON.stringify(data.order));
      });
    },
    cancelWebOrder(id) {
      return this.updateOrderFulfillment(id, "Cancelled");
    },
    assignRiderToOrder(orderId, riderId) {
      const rider = this.listRiders().find(r => r.id === riderId);
      return this.updateOrderFulfillment(orderId, "Dispatched", {
        rider_id: rider ? rider.id : riderId,
        rider_name: rider ? rider.name : ""
      });
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
    updateRider(id, patch) {
      return tx("riders", st => {
        const r = byId(st.riders, id); if (!r) throw new Error("Rider not found");
        ["name", "phone", "vehicle", "zone"].forEach(k => { if (patch[k] !== undefined) r[k] = shakeOn(patch[k]); });
        if (patch.status && RIDER_STATUSES.includes(patch.status)) r.status = patch.status;
        return Object.assign({}, r);
      });
    },
    addRider(r) {
      return tx("riders", st => {
        if (!shakeOn(r.name)) throw new Error("Rider name is required");
        const rec = {
          id: "RDR-" + (++st.counters.rider),
          name: shakeOn(r.name), phone: shakeOn(r.phone),
          vehicle: shakeOn(r.vehicle) || "Motorbike (Boda)", zone: shakeOn(r.zone),
          status: "Available"
        };
        st.riders.push(rec);
        return Object.assign({}, rec);
      });
    },
    removeRider(id) { return tx("riders", st => { st.riders = st.riders.filter(r => r.id !== id); return true; }); },

    /* ----- live backend financials & POS holds ----- */
    pullProducts,
    pullOperationalData,
    financeRequest(path, options) {
      const suffix = String(path || "").replace(/^\//, "");
      return apiRequest("/api/finance/" + suffix, options || { method: "GET" }, true);
    },
    acquireInventoryLock(productId, lockOwner, quantity = 1) {
      return apiRequest("/api/inventory-locks/acquire", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, lock_owner: lockOwner, quantity })
      }, true);
    },
    releaseInventoryLock(productId, lockOwner, quantity = 1) {
      return apiRequest("/api/inventory-locks/release", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, lock_owner: lockOwner, quantity })
      }, true);
    },
    releaseInventoryLockOwner(lockOwner, keepalive = false) {
      return apiRequest("/api/inventory-locks/release-owner", {
        method: "POST",
        keepalive: !!keepalive,
        body: JSON.stringify({ lock_owner: lockOwner })
      }, true);
    },
    heartbeatInventoryLocks(lockOwner) {
      return apiRequest("/api/inventory-locks/heartbeat", {
        method: "POST",
        body: JSON.stringify({ lock_owner: lockOwner })
      }, true);
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
    ugx(n) { return "UGX " + money(n).toLocaleString("en-US"); },
    laneOf: orderLanes,
    barcodeSVG: generateBarcodeSVG,
    apiUrl: apiUrl
  };
})(typeof window !== "undefined" ? window : globalThis);
