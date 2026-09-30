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
  const DEMO_CODES    = { "Men": "MEN", "Women": "WOM", "Children": "KID" };
  const CONDITIONS    = ["Grade A — Excellent", "Grade B — Good", "Vintage / Collector"];
  const DEMOGRAPHICS  = ["Men", "Women", "Children"];
  const CAT_CODES     = { "Outerwear & Jackets": "JKT", "Tops & Shirts": "TOP", "Dresses & Skirts": "DRS", "Pants & Jeans": "PNT", "Shoes": "SHO", "Accessories": "ACC", "Children Wear": "CHD" };
  const TENDER_TYPES  = ["cash", "mtn", "airtel"];
  const DISPATCH_STATUSES = ["Pending", "Packed", "With rider", "Handed over", "Delivered"];
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
    if (s.status === "cancelled") return "completed";
    if (s.status === "completed" && s.channel === "pos") return "completed";
    const d = s.dispatch_status || "Pending";
    if (d === "With rider") return "rider";
    if (d === "Handed over") return "handed";
    if (d === "Delivered") return "completed";
    if (d === "Incoming") return "incoming";
    return "fulfillment";
  };
  const DEFAULT_MASTER_KEY = "ADONAI-MASTER-2026";  // sandbox default per onboarding sheet — rotate in System Parameters

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
        admin_key: DEFAULT_MASTER_KEY       // rotate in System Parameters after onboarding
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

  /* BroadcastChannel + storage event — every tab re-renders when any tab writes. */
  let bc = null;
  function broadcast(table) {
    subs.filter(s => s.table === table || s.table === "*").forEach(s => { try { s.cb(table); } catch (e) {} });
    if (bc) { try { bc.postMessage({ table }); } catch (e) {} }
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
      document.addEventListener("visibilitychange", () => { if (!document.hidden) { state = null; reload(); subs.filter(s => s.table === "*").forEach(s => s.cb("reload")); } });
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
      label: `${sale.channel === "web" ? "WhatsApp order" : "Register sale"} ${sale.id} · ${sale.items[0] ? sale.items[0].name : "items"}${sale.items.length > 1 ? " +" + (sale.items.length - 1) + " more" : ""}`,
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

    /* ----- staff & access (roster seeded; passkeys EMPTY until admin sets them) ----- */
    listStaff() { reload(); return state.staff.map(s => Object.assign({}, s)); },
    addStaff({ name, email, phone, role, pin }) {
      return tx("staff", st => {
        name = shakeOn(name); if (!name) throw new Error("Full name is required");
        const r = STAFF_ROLES.includes(role) ? role : "cashier";
        const rec = {
          id: "STF-" + String(st.staff.length + 1).padStart(2, "0"),
          name, email: shakeOn(email), phone: shakeOn(phone), role: r,
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
        ["name", "email", "phone", "role"].forEach(k => { if (patch[k] !== undefined) s[k] = patch[k]; });
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
    verifyMasterKey(k) { reload(); return String(k || "").trim() === String(state.settings.admin_key || "").trim(); },
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
    addProduct(input) {
      return tx("products", st => {
        const n = ++st.counters.product;
        const id = "PRD-" + n;
        const demo = DEMOGRAPHICS.includes(input.demographic) ? input.demographic : "Men";
        const cat = CATEGORIES.includes(input.category) ? input.category : "Accessories";
        let barcode = String(input.barcode_id || "").trim() || ("ADT-" + (10000 + n - 1000));
        if (st.products.some(p => p.barcode_id.toUpperCase() === barcode.toUpperCase()))
          barcode = "ADT-" + n + "-" + String(Date.now()).slice(-4);
        const p = {
          id, barcode_id: barcode,
          sku: String(input.sku || "").trim() || ("ADN-" + (CAT_CODES[cat] || "GEN") + "-" + n),
          name: String(input.name || "Untitled item").trim(),
          brand: String(input.brand || "Unbranded").trim(),
          color: String(input.color || "").trim(),
          demographic: demo, category: cat,
          size: String(input.size || "-"),
          condition: CONDITIONS.includes(input.condition) ? input.condition : CONDITIONS[1],
          cost_price: money(input.cost_price), selling_price: money(input.selling_price),
          compare_price: money(input.compare_price),
          desc: String(input.desc || "").trim(),
          staff_notes: String(input.staff_notes || "").trim(),
          visibility: String(input.visibility || "Online WhatsApp & In-Store POS").trim(),
          image_url: String(input.image_url || "").trim(),
          images: Array.isArray(input.images) ? input.images.filter(Boolean) : [],
          in_stock_count: Math.max(0, money(input.in_stock_count)),
          created_at: new Date().toISOString()
        };
        st.products.push(p);
        return Object.assign({}, p);
      });
    },
    updateProduct(id, patch) {
      return tx("products", st => {
        const p = byId(st.products, id); if (!p) throw new Error("Product not found");
        ["name", "brand", "color", "demographic", "category", "size", "condition", "desc", "staff_notes", "visibility", "image_url"].forEach(k => {
          if (patch[k] !== undefined) p[k] = patch[k];
        });
        if (patch.images !== undefined && Array.isArray(patch.images)) p.images = patch.images.filter(Boolean);
        ["cost_price", "selling_price", "compare_price", "in_stock_count"].forEach(k => {
          if (patch[k] !== undefined) p[k] = money(patch[k]);
        });
        return Object.assign({}, p);
      });
    },
    setProductImage(id, imageUrl) {
      return tx("products", st => {
        const p = byId(st.products, id); if (!p) throw new Error("Product not found");
        p.image_url = String(imageUrl || "");
        return Object.assign({}, p);
      });
    },
    adjustStock(id, delta) {
      return tx("products", st => {
        const p = byId(st.products, id); if (!p) throw new Error("Product not found");
        p.in_stock_count = Math.max(0, p.in_stock_count + money(delta));
        return Object.assign({}, p);
      });
    },
    removeProduct(id) {
      return tx("products", st => { st.products = st.products.filter(p => p.id !== id); return true; });
    },

    /* ----- sales (POS + WhatsApp, unified) ----- */
    processPosSale({ items, tender, cashier, customer_name, customer_phone, customer_notes }) {
      return tx("sales", st => {
        const { items: finalItems, total } = saleFromItems(st, items);
        if (!st.counters.sale_seq) st.counters.sale_seq = Math.max(1861, st.counters.sale_pos || 1841);
        const seq = ++st.counters.sale_seq;
        const sale = {
          id: "AT-" + seq,
          channel: "pos", status: "completed",
          created_at: new Date().toISOString(),
          customer_name: String(customer_name || "Walk-in Guest").trim(),
          customer_phone: String(customer_phone || "").trim(),
          customer_notes: String(customer_notes || "").trim(),
          delivery_area: "In-Store POS (Walk-in)",
          delivery_address: "",
          delivery_fee: 0,
          subtotal: total,
          total,
          cashier: cashier || null,
          items: finalItems,
          tender: Object.assign({ type: "cash", paid: true }, tender || {}),
          dispatch_status: "Delivered",
          assigned_rider_id: null,
          assigned_rider_name: null
        };
        st.sales.push(sale);
        logSaleEntry(st, sale, cashier && cashier.name);
        return JSON.parse(JSON.stringify(sale));
      });
    },
    createWebOrder({ customer_name, customer_phone, delivery_type, delivery_area, delivery_address, delivery_fee, delivery_notes, items }) {
      return tx("sales", st => {
        const { items: finalItems, total: subtotal } = saleFromItems(st, items);
        const fee = delivery_type === "pickup" ? 0 : Number(delivery_fee != null ? delivery_fee : 7000);
        const finalTotal = subtotal + fee;
        if (!st.counters.sale_seq) st.counters.sale_seq = Math.max(1861, st.counters.sale_pos || 1841);
        const seq = ++st.counters.sale_seq;
        const sale = {
          id: "AT-" + seq,
          channel: "web",
          status: "pending",
          created_at: new Date().toISOString(),
          customer_name: String(customer_name || "Web customer").trim(),
          customer_phone: String(customer_phone || "").trim(),
          delivery_type: delivery_type || "boda",
          delivery_area: String(delivery_area || "Kampala Central / Nakasero").trim(),
          delivery_address: String(delivery_address || "").trim(),
          delivery_fee: fee,
          delivery_notes: String(delivery_notes || "").trim(),
          subtotal,
          total: finalTotal,
          cashier: null,
          items: finalItems,
          tender: { type: "whatsapp", paid: false },
          dispatch_status: "Pending",
          assigned_rider_id: null,
          assigned_rider_name: null
        };
        st.sales.push(sale);
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
    cancelWebOrder(id) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (s.status === "cancelled") return JSON.parse(JSON.stringify(s));
        s.items.forEach(it => { const p = byId(st.products, it.product_id); if (p) p.in_stock_count += it.qty; });
        s.status = "cancelled";
        s.dispatch_status = "Cancelled";
        if (s.assigned_rider_id) {
          const r = byId(st.riders, s.assigned_rider_id);
          if (r && r.status === "On delivery") r.status = "Available";
        }
        return JSON.parse(JSON.stringify(s));
      });
    },
    assignRiderToOrder(orderId, riderId) {
      return tx("sales", st => {
        const s = byId(st.sales, orderId); if (!s) throw new Error("Order not found");
        const r = byId(st.riders, riderId);
        if (r) {
          s.assigned_rider_id = r.id;
          s.assigned_rider_name = r.name;
          s.dispatch_status = "With rider";
          r.status = "On delivery";
        }
        return JSON.parse(JSON.stringify(s));
      });
    },
    listSales() { reload(); return state.sales.map(s => JSON.parse(JSON.stringify(s))).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    getSale(id) { reload(); const s = byId(state.sales, id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    setDispatchStatus(id, dispatch_status) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (!DISPATCH_STATUSES.includes(dispatch_status) && dispatch_status !== "Cancelled") throw new Error("Unknown dispatch stage");
        s.dispatch_status = dispatch_status;
        if (dispatch_status === "Delivered" && s.assigned_rider_id) {
          const r = byId(st.riders, s.assigned_rider_id);
          if (r && r.status === "On delivery") r.status = "Available";
        }
        return JSON.parse(JSON.stringify(s));
      });
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

    /* ----- financial ledger ----- */
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
    barcodeSVG: generateBarcodeSVG
  };
})(typeof window !== "undefined" ? window : globalThis);
