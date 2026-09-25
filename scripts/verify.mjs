/**
 * End-to-end verification of the running system (both drivers).
 *
 *   npm run dev            # in one terminal
 *   npm run verify         # in another  (BASE_URL=http://host:port npm run verify)
 *
 * Exercises the real HTTP routes and the real data driver — including the atomic
 * stock decrement, the oversell guard, the refund restock and the RBAC gates.
 */
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

let pass = 0;
let fail = 0;
const failures = [];

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const call = async (path, { method = "GET", body, cookie } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.()[0]?.split(";")[0];
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (SVG, HTML) */
  }
  return {
    status: res.status,
    json,
    text,
    setCookie,
    type: res.headers.get("content-type") || "",
    location: res.headers.get("location") || "",
  };
};

const login = async (email, password) => {
  const r = await call("/api/auth/login", { method: "POST", body: { email, password } });
  if (!r.json?.ok) throw new Error(`login failed for ${email}: ${r.json?.error ?? r.status}`);
  return r.setCookie;
};

console.log(`\nAdonai Thrift verification → ${BASE}\n`);

// ---------------------------------------------------------------- 1. health
const health = await call("/api/health");
check("GET /api/health responds", health.status === 200 && health.json?.ok === true);
const mode = health.json?.data?.mode;
check("driver reports a mode", mode === "local" || mode === "supabase", `mode=${mode}`);
check("catalog is seeded", (health.json?.data?.products ?? 0) > 0, `${health.json?.data?.products} products`);

// --------------------------------------------------------------- 2. catalog
const cat = await call("/api/products");
const products = cat.json?.data ?? [];
check("GET /api/products returns the catalog", cat.status === 200 && products.length > 0, `${products.length} products`);
check(
  "barcodes are EAN-13 length",
  products.every((p) => /^\d{13}$/.test(p.barcode)),
  `sample ${products[0]?.barcode}`,
);
check(
  "money fields are whole shillings",
  products.every((p) => Number.isInteger(p.price) && Number.isInteger(p.cost_price)),
);

const inStock = products.filter((p) => p.stock >= 3 && p.active);
const target = inStock[0];
check("an in-stock product exists to transact against", !!target, target?.sku);

// ------------------------------------------------------------------ 3. RBAC
const anonSale = await call("/api/sales", { method: "POST", body: { channel: "pos", lines: [{ product_id: target.sku, qty: 1 }] } });
check("anonymous POS sale is rejected", anonSale.status === 401, `${anonSale.status}`);

const anonAnalytics = await call("/api/analytics");
check("anonymous analytics is rejected", anonAnalytics.status === 401, `${anonAnalytics.status}`);

const anonWrite = await call("/api/products", { method: "POST", body: { title: "x", price: 1, cost_price: 1, stock: 1, category: "Bags", condition: "Good", size: "M" } });
check("anonymous product write is rejected", anonWrite.status === 401, `${anonWrite.status}`);

// ------------------------------------------------------------- 4. cashier POS
const cashier = await login("cashier@adonai.ug", "adonai-cashier").catch(() => null);
check("cashier can sign in", !!cashier);

const cashierAnalytics = await call("/api/analytics", { cookie: cashier });
check("cashier is blocked from the analytics report", cashierAnalytics.status === 401, `${cashierAnalytics.status}`);

const before = (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock;
const qty = 2;
const unit = target.price;
const cash = unit * qty + 12000;

const sale = await call("/api/sales", {
  method: "POST",
  cookie: cashier,
  body: { channel: "pos", tender: "Cash", status: "completed", amount_received: cash, lines: [{ product_id: target.sku, qty }] },
});
check("POS sale is accepted", sale.status === 201 && sale.json?.ok === true, sale.json?.data?.ref);
check(
  "sale totals and change are computed correctly",
  sale.json?.data?.total === unit * qty && sale.json?.data?.change_due === cash - unit * qty,
  `total=${sale.json?.data?.total} change=${sale.json?.data?.change_due}`,
);

const after = (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock;
check("stock is decremented atomically on settlement", after === before - qty, `${before} → ${after}`);

const oversell = await call("/api/sales", {
  method: "POST",
  cookie: cashier,
  body: { channel: "pos", tender: "Cash", lines: [{ product_id: target.sku, qty: 9999 }] },
});
check("oversell is refused", oversell.status === 400 && /insufficient stock/i.test(oversell.json?.error ?? ""), oversell.json?.error);

// -------------------------------------------------- 5. online order lifecycle
const online = await call("/api/sales", {
  method: "POST",
  body: { channel: "online", customer_name: "Verify Buyer", customer_phone: "+256700111222", lines: [{ product_id: target.sku, qty: 1 }] },
});
check("anonymous online order is accepted", online.status === 201 && online.json?.data?.status === "pending", online.json?.data?.ref);
const pendingStock = (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock;
check("pending online orders do NOT move stock", pendingStock === after, `still ${pendingStock}`);

const admin = await login("admin@adonai.ug", "adonai-admin").catch(() => null);
check("admin can sign in", !!admin);

const approve = await call(`/api/sales/${online.json.data.id}`, { method: "PATCH", cookie: admin, body: { status: "completed" } });
check("admin can approve an online order", approve.status === 200 && approve.json?.data?.status === "completed");
const approvedStock = (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock;
check("approving decrements stock", approvedStock === after - 1, `${after} → ${approvedStock}`);

// ------------------------------------------------------------- 6. refund path
const refund = await call(`/api/sales/${sale.json.data.id}`, { method: "PATCH", cookie: admin, body: { status: "refunded" } });
check("refund is accepted", refund.status === 200 && refund.json?.data?.status === "refunded");
const refundedStock = (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock;
check("refunding returns the units to the rail", refundedStock === approvedStock + qty, `${approvedStock} → ${refundedStock}`);

// -------------------------------------------------------- 7. inventory admin
const sku = `TST-${Date.now().toString().slice(-6)}`;
const created = await call("/api/products", {
  method: "POST",
  cookie: admin,
  body: { sku, title: "Verification Tee", category: "Tops & Blouses", condition: "New with tags", size: "M", cost_price: 5000, price: 15000, stock: 4, min_stock: 2 },
});
check("admin can create a product", created.status === 201 && created.json?.data?.sku === sku, sku);
check("created product gets an EAN-13 barcode", /^\d{13}$/.test(created.json?.data?.barcode ?? ""), created.json?.data?.barcode);

const dup = await call("/api/products", {
  method: "POST",
  cookie: admin,
  body: { sku, title: "Duplicate", category: "Bags", condition: "Good", size: "M", cost_price: 1, price: 1, stock: 1 },
});
check("duplicate SKU is rejected", dup.status === 400 && /already/i.test(dup.json?.error ?? ""), dup.json?.error);

const edited = await call(`/api/products/${created.json.data.id}`, { method: "PATCH", cookie: admin, body: { price: 18000, stock: 9 } });
check(
  "inline edits persist",
  edited.json?.data?.price === 18000 && edited.json?.data?.stock === 9,
  `price=${edited.json?.data?.price} stock=${edited.json?.data?.stock}`,
);

const adjusted = await call("/api/stock", { method: "POST", cookie: admin, body: { product_id: created.json.data.id, delta: -3, reason: "verify" } });
check("manual stock adjustment works", adjusted.json?.data?.stock === 6, `stock=${adjusted.json?.data?.stock}`);

const deleted = await call(`/api/products/${created.json.data.id}`, { method: "DELETE", cookie: admin });
check("admin can delete a product", deleted.status === 200 && deleted.json?.ok === true);

// --------------------------------------------------------------- 8. analytics
const analytics = await call("/api/analytics?days=30", { cookie: admin });
const a = analytics.json?.data;
check("analytics report is returned", analytics.status === 200 && !!a);
check("report has both channels", Array.isArray(a?.byChannel) && a.byChannel.length > 0, (a?.byChannel ?? []).map((c) => c.channel).join("+"));
check("report has 14 daily points", a?.daily?.length === 14, `${a?.daily?.length}`);
check("report values revenue", (a?.window?.revenue ?? 0) > 0, `UGX ${a?.window?.revenue}`);
check("low-stock flags are computed", Array.isArray(a?.lowStock), `${a?.lowStock?.length} flagged`);

// ---------------------------------------------------------------- 9. barcode
const code = await call(`/api/barcode?value=${encodeURIComponent(target.sku)}&kind=code128`);
check("barcode endpoint renders SVG", code.status === 200 && code.type.includes("svg") && code.text.startsWith("<svg"), `${code.text.length}B`);
const qr = await call(`/api/barcode?value=${encodeURIComponent(target.sku)}&kind=qrcode`);
check("QR endpoint renders SVG", qr.status === 200 && qr.text.startsWith("<svg"));

// ------------------------------------------------------------------ 10. UI
const home = await call("/");
check("showroom renders", home.status === 200 && /ADONAI THRIFT/.test(home.text));
const posUnauth = await call("/pos");
check(
  "POS redirects anonymous visitors to sign-in",
  posUnauth.status === 307 && /\/login/.test(posUnauth.location),
  `${posUnauth.status} → ${posUnauth.location}`,
);
const adminAsCashier = await call("/admin", { cookie: cashier });
check("cashier is redirected away from the back office", adminAsCashier.status === 307, `${adminAsCashier.status} → ${adminAsCashier.location}`);
const posAuth = await call("/pos", { cookie: cashier });
check("POS renders for a signed-in cashier", posAuth.status === 200 && /Current ticket/.test(posAuth.text));
const adminPage = await call("/admin", { cookie: admin });
check("dashboard renders for admin", adminPage.status === 200 && /Business performance/.test(adminPage.text));

// ------------------------------------------------------------------ summary
console.log(`\n${pass} passed, ${fail} failed${fail ? ` → ${failures.join("; ")}` : ""}\n`);
process.exit(fail ? 1 : 0);
