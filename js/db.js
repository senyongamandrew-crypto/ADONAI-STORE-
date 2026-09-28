/* ============================================================
   ADONAI THRIFT STORE — CENTRAL REAL-TIME DB ENGINE (DB)
   The single source of truth for ALL interfaces:
     /           public storefront
     /pos        cashier terminal
     /admin      operations dashboard
   - localStorage persistence (shared by every tab/interface)
   - BroadcastChannel + storage-event real-time sync across tabs
   - Web Locks (where supported) for atomic cross-tab transactions
   All UIs only talk to the DB.* API — swap this file for a
   Supabase-backed implementation later without touching the UIs.
   ============================================================ */
(function (global) {
  "use strict";

  const LS_KEY   = "adonai-db-v5";   // v5: local curated product photography + full store profile
  const CHANNEL  = "adonai-db-v5-sync";
  const LOCK     = "adonai-thrift-db-tx";
  const TAB_ID   = Math.random().toString(36).slice(2) + Date.now().toString(36);

  /* ---------- storage (localStorage, in-memory fallback for tests) ---------- */
  const _mem = {};
  const storage = (typeof localStorage !== "undefined") ? localStorage : {
    getItem: k => (Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null),
    setItem: (k, v) => { _mem[k] = String(v); },
    removeItem: k => { delete _mem[k]; }
  };

  /* ---------- domain constants ---------- */
  const CATEGORIES  = ["Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories", "Children Wear"];
  const CONDITIONS  = ["Grade A — Excellent", "Grade B — Good", "Vintage / Collector"];
  const DEMOGRAPHICS = ["Men", "Women", "Children"];
  const CAT_CODES   = { "Outerwear & Jackets": "JKT", "Tops & Shirts": "TOP", "Dresses & Skirts": "DRS", "Pants & Jeans": "PNT", "Shoes": "SHO", "Accessories": "ACC", "Children Wear": "CHD" };
  const TENDER_TYPES = ["cash", "mtn", "airtel"];
  const DISPATCH_STATUSES = ["Pending", "Packed", "With rider", "Delivered"];

  /* ---------- seed data ---------- */
  function seedProducts() {
    // [name, brand, color, demographic, category, size, condition, cost, selling, compare, stock, description, image keywords]
    const A = "Grade A — Excellent", B = "Grade B — Good", V = "Vintage / Collector";
    const raw = [
      ["Indigo Type III Trucker Jacket", "Levi's", "Indigo", "Men", "Outerwear & Jackets", "L", A, 40000, 68000, 120000, 1, "1980s trucker jacket. Authentic vintage wash with whiskers and brass buttons intact.", "denim,jacket"],
      ["Olive Waxed Field Jacket", "Barbour Style", "Olive", "Men", "Outerwear & Jackets", "XL", B, 55000, 85000, 150000, 1, "Matte waxed cotton with a corduroy collar. Windproof and rain-resistant.", "field,jacket"],
      ["Cream Silk Slip Dress", "Unbranded", "Cream", "Women", "Dresses & Skirts", "S", V, 45000, 78000, 130000, 1, "Bias-cut silk slip from the 90s — fluid drape, adjustable straps.", "silk,dress"],
      ["Black Leather Chelsea Boots", "Clarks", "Black", "Men", "Shoes", "43", B, 60000, 95000, 170000, 1, "Polished leather uppers with elastic gussets. Resoled once — plenty of life left.", "chelsea,boots"],
      ["White Oxford Button-Down", "Ralph Lauren", "White", "Men", "Tops & Shirts", "L", A, 20000, 38000, 75000, 2, "Crisp cotton oxford with single-needle stitching. Lightly worn.", "oxford,shirt"],
      ["Band Graphic Tee", "Vintage Anvil", "Black", "Men", "Tops & Shirts", "M", V, 22000, 42000, 70000, 1, "Single-stitch 90s tour tee with the original chest print and a soft fade.", "band,tshirt"],
      ["Pleated Midi Skirt", "Unbranded", "Rust", "Women", "Dresses & Skirts", "M", A, 18000, 35000, 65000, 1, "Satin pleats with a comfortable elastic waist — moves beautifully.", "pleated,skirt"],
      ["Ankara Print Wrap Dress", "Hand-made", "Multi", "Women", "Dresses & Skirts", "M", A, 32000, 55000, 95000, 1, "Kitenge wax-print wrap tailored in Kampala. Wears like new.", "ankara,dress"],
      ["High-Waist 501 Jeans", "Levi's", "Mid-wash", "Women", "Pants & Jeans", "30", B, 26000, 48000, 85000, 2, "Classic straight leg with button fly. Honest fade at the knees.", "levis,jeans"],
      ["Khaki Pleated Chinos", "Dockers", "Khaki", "Men", "Pants & Jeans", "32", B, 15000, 30000, 55000, 1, "Relaxed pleat-front, freshly hemmed. Office-ready.", "chinos"],
      ["Canvas Field Tote", "Unbranded", "Natural", "Women", "Accessories", "-", A, 10000, 22000, 40000, 1, "Heavy canvas tote with leather handles and a spotless interior.", "tote,bag"],
      ["Tan Leather Belt", "Unbranded", "Tan", "Men", "Accessories", "34", B, 9000, 18000, 32000, 2, "Full-grain leather with a brass buckle — broken in just right.", "leather,belt"],
      ["Kids' Denim Jacket", "OshKosh", "Light wash", "Children", "Children Wear", "8y", B, 13000, 25000, 45000, 1, "Sturdy kids' denim with room to grow. All snaps working.", "kids,denim"],
      ["Silk Printed Scarf", "Unbranded", "Paisley", "Women", "Accessories", "-", V, 13000, 26000, 48000, 1, "Hand-rolled 70s silk square. No pulls, no stains.", "silk,scarf"],
      ["Retro Running Trainers", "Nike", "White / Gum", "Men", "Shoes", "44", B, 30000, 55000, 98000, 1, "Retro runner on a gum sole. Cleaned and disinfected.", "nike,sneakers"],
      ["Floral Summer Blouse", "Unbranded", "Floral", "Women", "Tops & Shirts", "S", A, 14000, 28000, 50000, 1, "Airy rayon blouse with covered buttons. Zero pilling.", "floral,blouse"]
    ];
    const IMGS = Array.from({ length: 16 }, (_, i) => `assets/products/p${1001 + i}.jpg`);
    return raw.map((r, i) => ({
      id: "PRD-" + String(1001 + i),
      sku: "ADN-" + (CAT_CODES[r[4]] || "GEN") + "-" + String(1001 + i),
      barcode_id: "ADT-" + String(10001 + i),
      name: r[0], brand: r[1], color: r[2], demographic: r[3],
      category: r[4], size: r[5], condition: r[6],
      cost_price: r[7], selling_price: r[8], compare_price: r[9],
      in_stock_count: r[10],
      desc: r[11],
      // Curated local photography (daylight, hanger) — staff replace with the real photo at intake.
      image_url: IMGS[i],
      created_at: new Date(Date.now() - (30 - i) * 86400000).toISOString()
    }));
  }

  function seedSales(products) {
    const sales = [];
    const webCustomers = [
      ["Nakato Sarah", "+256772001234"], ["Muwonge David", "+256701442890"],
      ["Achieng Grace", "+256753908112"], ["Okello Brian", "+256784330556"],
      ["Nanyonga Ruth", "+256709112004"]
    ];
    let posN = 1000, webN = 1000;
    const now = Date.now();
    for (let d = 13; d >= 0; d--) {
      const dayCount = 2 + (d % 3);                 // 2–4 sales per day
      for (let i = 0; i < dayCount; i++) {
        const p1 = products[(d * 5 + i * 7) % products.length];
        const p2 = products[(d * 3 + i * 11 + 5) % products.length];
        const items = [{ product_id: p1.id, barcode_id: p1.barcode_id, name: p1.name, qty: 1, unit_price: p1.selling_price, line_total: p1.selling_price }];
        if ((d + i) % 3 === 0) items.push({ product_id: p2.id, barcode_id: p2.barcode_id, name: p2.name, qty: 1, unit_price: p2.selling_price, line_total: p2.selling_price });
        const total = items.reduce((s, it) => s + it.line_total, 0);
        const when = new Date(now - d * 86400000 - (2 + i) * 3600000).toISOString();
        const isWeb = ((d + i) % 4 === 0);
        if (isWeb) {
          const c = webCustomers[(d + i) % webCustomers.length];
          const pending = d === 0 || (d === 1 && i === 0);
          sales.push({
            id: "WEB-" + (++webN), channel: "web", status: pending ? "pending" : "completed",
            created_at: when,
            customer_name: c[0], customer_phone: c[1], cashier: null,
            items, total,
            tender: pending ? { type: "whatsapp" } : { type: (i % 2 ? "mtn" : "cash") }
          });
        } else {
          const momo = ((d + i) % 3 === 0);
          const tendered = Math.ceil(total / 10000) * 10000;
          sales.push({
            id: "POS-" + (++posN), channel: "pos", status: "completed", created_at: when,
            customer_name: "Walk-in customer", cashier: { name: "Staff", id: null },
            items, total,
            tender: momo
              ? { type: (i % 2 ? "mtn" : "airtel"), sender_name: "Walk-in", sender_phone: "+2567****", ref: "MOM" + (88000000 + posN * 37), verified: true, verified_by: "Staff" }
              : { type: "cash", tendered, change: tendered - total }
          });
        }
      }
    }
    return { sales, posN, webN };
  }

  function seedState() {
    const products = seedProducts();
    const { sales, posN, webN } = seedSales(products);
    return {
      version: 2,
      settings: {
        store_name: "Adonai Thrift Store",
        tagline: "An independent Kampala boutique curating pre-loved vintage garments. Every piece is laundered, photographed in daylight, and sold once.",
        address: "Plot 14 Kampala Road / Mercer Hub, Kampala, Uganda",
        whatsapp: "256758873398",
        hotline: "+256 7656 52403",
        email: "adonaithriftstore@gmail.com",
        hours: "Mon–Sat 8:30 AM – 7:30 PM · Sun 10:00 AM – 6:00 PM",
        tiktok: "@adonai.thrift256",
        instagram: "@adonaithrift256",
        currency: "UGX",
        access_locked: false                // OPEN ACCESS MODE until admin adds staff & enables lock
      },
      products,
      sales,
      staff: [],                            // EMPTY by design — admin creates accounts & passkeys
      counters: { product: 1016, sale_pos: posN, sale_web: webN }
    };
  }

  /* ---------- state & realtime plumbing ---------- */
  let state = null;
  const subs = []; // {table, cb}

  function reload() {
    let ok = false;
    try {
      const raw = storage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (rawValid(parsed)) { state = parsed; ok = true; }
    } catch (e) { ok = false; }
    if (!ok) { state = seedState(); save(); }
  }
  function rawValid(s) {
    return s && Array.isArray(s.products) && Array.isArray(s.sales) && Array.isArray(s.staff) && s.settings && s.counters;
  }
  function save() { storage.setItem(LS_KEY, JSON.stringify(state)); }

  let bc = null;
  try { if (typeof BroadcastChannel !== "undefined") { bc = new BroadcastChannel(CHANNEL); bc.onmessage = e => { const m = e.data || {}; if (m.src === TAB_ID) return; reload(); emit(m.table || "*"); }; } } catch (e) {}
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", e => { if (e.key === LS_KEY) { reload(); emit("*"); } });
  }

  function emit(table) {
    subs.forEach(s => {
      if (s.table === table || s.table === "*" || table === "*") {
        try { s.cb(table); } catch (e) { /* listener errors must not break engine */ }
      }
    });
  }
  function broadcast(table) { emit(table); if (bc) { try { bc.postMessage({ src: TAB_ID, table }); } catch (e) {} } }

  /* Atomic transaction: reload → mutate → save, synchronously, under a
     cross-tab Web Lock where available. fn throwing = nothing is saved. */
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

  function saleFromItems(st, items) {
    const lines = items.map(it => {
      const p = byId(st.products, it.product_id);
      if (!p) throw new Error("Unknown product: " + it.product_id);
      const qty = Math.max(1, money(it.qty));
      return { p, qty };
    });
    // atomic stock pre-check for ALL lines before any mutation
    lines.forEach(({ p, qty }) => { if (p.in_stock_count < qty) throw stockError(p.name, p.in_stock_count); });
    lines.forEach(({ p, qty }) => { p.in_stock_count -= qty; });
    const finalItems = lines.map(({ p, qty }) => ({
      product_id: p.id, barcode_id: p.barcode_id, name: p.name, qty,
      unit_price: p.selling_price, line_total: p.selling_price * qty
    }));
    return { items: finalItems, total: finalItems.reduce((s, l) => s + l.line_total, 0) };
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */
  const DB = {
    CATEGORIES, CONDITIONS, DEMOGRAPHICS, TENDER_TYPES, DISPATCH_STATUSES,

    on(table, cb) { const s = { table, cb }; subs.push(s); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); }; },
    reloadNow() { reload(); },

    /* ----- settings ----- */
    getSettings() { reload(); return Object.assign({}, state.settings); },
    updateSettings(patch) {
      return tx("settings", st => { Object.assign(st.settings, patch || {}); return Object.assign({}, st.settings); });
    },

    /* ----- staff & access (starts EMPTY — admin sets up after publish) ----- */
    listStaff() { reload(); return state.staff.map(s => Object.assign({}, s)); },
    addStaff({ name, role, pin }) {
      return tx("staff", st => {
        name = String(name || "").trim();
        role = role === "admin" ? "admin" : "cashier";
        pin = String(pin || "").trim();
        if (!name) throw new Error("Staff name is required");
        if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN must be 4–8 digits");
        if (st.staff.some(s => s.pin === pin)) throw new Error("That PIN is already in use");
        const rec = { id: "STF-" + String(st.staff.length + 1).padStart(2, "0"), name, role, pin, created_at: new Date().toISOString() };
        st.staff.push(rec);
        return Object.assign({}, rec);
      });
    },
    removeStaff(id) {
      return tx("staff", st => { st.staff = st.staff.filter(s => s.id !== id); return true; });
    },
    resetStaffPin(id, newPin) {
      return tx("staff", st => {
        if (!/^\d{4,8}$/.test(String(newPin || ""))) throw new Error("PIN must be 4–8 digits");
        if (st.staff.some(s => s.pin === newPin && s.id !== id)) throw new Error("That PIN is already in use");
        const s = byId(st.staff, id); if (!s) throw new Error("Staff not found");
        s.pin = String(newPin);
        return true;
      });
    },
    verifyPin(pin) { reload(); const s = state.staff.find(x => x.pin === String(pin || "").trim()); return s ? { id: s.id, name: s.name, role: s.role } : null; },

    /* ----- products ----- */
    listProducts() { reload(); return state.products.map(p => Object.assign({}, p)); },
    getProduct(id) { reload(); const p = byId(state.products, id); return p ? Object.assign({}, p) : null; },
    findByBarcode(code) {
      reload();
      const c = String(code || "").trim().toUpperCase();
      const p = state.products.find(x => x.barcode_id.toUpperCase() === c);
      return p ? Object.assign({}, p) : null;
    },
    addProduct(input) {
      return tx("products", st => {
        const n = ++st.counters.product;
        const id = "PRD-" + n;
        let barcode = String(input.barcode_id || "").trim() || ("ADT-" + (10000 + n - 1000));
        if (st.products.some(p => p.barcode_id.toUpperCase() === barcode.toUpperCase()))
          barcode = "ADT-" + n + "-" + String(Date.now()).slice(-4); // guaranteed unique fallback
        const cat = CATEGORIES.includes(input.category) ? input.category : "Accessories";
        const p = {
          id, barcode_id: barcode,
          sku: "ADN-" + (CAT_CODES[cat] || "GEN") + "-" + n,
          name: String(input.name || "Untitled item").trim(),
          brand: String(input.brand || "Unbranded").trim(),
          color: String(input.color || "").trim(),
          demographic: DEMOGRAPHICS.includes(input.demographic) ? input.demographic : "Men",
          category: cat,
          size: String(input.size || "-"), condition: CONDITIONS.includes(input.condition) ? input.condition : CONDITIONS[1],
          cost_price: money(input.cost_price), selling_price: money(input.selling_price),
          compare_price: money(input.compare_price),
          desc: String(input.desc || "").trim(),
          image_url: String(input.image_url || "").trim(),
          in_stock_count: Math.max(0, money(input.in_stock_count)),
          created_at: new Date().toISOString()
        };
        st.products.push(p);
        return Object.assign({}, p);
      });
    },
    updateProduct(id, patch) {
      return tx("products", st => {
        const p = byId(st.products, id); if (!p) throw new Error("Product not found: " + id);
        if (patch.barcode_id) {
          const clash = st.products.find(x => x.id !== id && x.barcode_id.toUpperCase() === String(patch.barcode_id).toUpperCase());
          if (clash) throw new Error("Barcode already assigned to " + clash.name);
        }
        ["name", "category", "size", "condition", "barcode_id", "image_url", "brand", "color", "demographic", "desc", "sku"].forEach(k => { if (patch[k] !== undefined) p[k] = String(patch[k]); });
        ["cost_price", "selling_price", "compare_price"].forEach(k => { if (patch[k] !== undefined) p[k] = money(patch[k]); });
        if (patch.in_stock_count !== undefined) p.in_stock_count = Math.max(0, money(patch.in_stock_count));
        return Object.assign({}, p);
      });
    },
    /** Swap a product's photo — used by POS/admin intake (real-time to every interface). */
    setProductImage(id, imageUrl) {
      return tx("products", st => {
        const p = byId(st.products, id); if (!p) throw new Error("Product not found: " + id);
        p.image_url = String(imageUrl || "");
        return Object.assign({}, p);
      });
    },
    adjustStock(id, delta) {
      return tx("products", st => {
        const p = byId(st.products, id); if (!p) throw new Error("Product not found: " + id);
        p.in_stock_count = Math.max(0, p.in_stock_count + money(delta));
        return Object.assign({}, p);
      });
    },

    /* ----- POS counter sales (atomic, race-safe) ----- */
    processPosSale({ items, tender, cashier }) {
      return tx("sales", st => {
        const { items: finalItems, total } = saleFromItems(st, items);
        tender = Object.assign({}, tender || { type: "cash", tendered: total, change: 0 });
        if (tender.type === "cash") {
          tender.tendered = money(tender.tendered);
          if (tender.tendered < total) throw new Error("Cash tendered is less than the total due");
          tender.change = tender.tendered - total;
        } else if (tender.type === "mtn" || tender.type === "airtel") {
          if (!tender.verified) throw new Error("Mobile Money payment must be verified before completing");
          if (!tender.ref) throw new Error("Mobile Money transaction reference is required");
        } else {
          throw new Error("Unsupported tender type for POS: " + tender.type);
        }
        const sale = {
          id: "POS-" + (++st.counters.sale_pos),
          channel: "pos", status: "completed",
          created_at: new Date().toISOString(),
          customer_name: "Walk-in customer",
          cashier: cashier ? { id: cashier.id || null, name: cashier.name || "Staff" } : { id: null, name: "Staff" },
          items: finalItems, total, tender
        };
        st.sales.push(sale);
        return JSON.parse(JSON.stringify(sale));
      });
    },

    /* ----- web (WhatsApp) orders ----- */
    createWebOrder({ customer_name, customer_phone, items }) {
      return tx("sales", st => {
        const { items: finalItems, total } = saleFromItems(st, items); // reserves stock atomically
        const sale = {
          id: "WEB-" + (++st.counters.sale_web),
          channel: "web", status: "pending",
          created_at: new Date().toISOString(),
          customer_name: String(customer_name || "Web customer").trim(),
          customer_phone: String(customer_phone || "").trim(),
          cashier: null,
          items: finalItems, total,
          tender: { type: "whatsapp" }
        };
        st.sales.push(sale);
        return JSON.parse(JSON.stringify(sale));
      });
    },
    confirmWebOrder(id, method) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (s.channel !== "web" || s.status !== "pending") throw new Error("Order is not pending");
        s.tender = { type: TENDER_TYPES.includes(method) ? method : "cash", confirmed_by: "admin" };
        s.status = "completed";
        s.completed_at = new Date().toISOString();
        return JSON.parse(JSON.stringify(s));
      });
    },
    cancelWebOrder(id) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        if (s.status !== "pending") throw new Error("Only pending orders can be cancelled");
        s.items.forEach(l => { const p = byId(st.products, l.product_id); if (p) p.in_stock_count += l.qty; });
        s.status = "cancelled";
        return JSON.parse(JSON.stringify(s));
      });
    },

    /* ----- sales read ----- */
    listSales() { reload(); return state.sales.map(s => JSON.parse(JSON.stringify(s))).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    getSale(id) { reload(); const s = byId(state.sales, id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    /** Track fulfilment of an order through dispatch (boda riders etc.). */
    setDispatchStatus(id, dispatchStatus) {
      return tx("sales", st => {
        const s = byId(st.sales, id); if (!s) throw new Error("Order not found");
        s.dispatch_status = DISPATCH_STATUSES.includes(dispatchStatus) ? dispatchStatus : "Pending";
        return JSON.parse(JSON.stringify(s));
      });
    },

    /* ----- dev ----- */
    resetToSeed() {
      return tx("*", st => { const fresh = seedState(); Object.keys(st).forEach(k => delete st[k]); Object.assign(st, fresh); return true; });
    },

    ugx(n) { return "UGX " + money(n).toLocaleString("en-US"); }
  };

  reload();
  global.DB = DB;
})(typeof window !== "undefined" ? window : globalThis);
