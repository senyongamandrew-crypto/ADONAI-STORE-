/**
 * End-to-end verification of the running system (both drivers).
 *
 *   npm run dev            # in one terminal
 *   npm run verify         # in another  (BASE_URL=http://host:port npm run verify)
 *
 * Exercises the real HTTP routes and the real data driver — including the atomic
 * stock decrement, the oversell guard, the refund restock and the RBAC gates.
 */
import { createAuthenticator, rpForBaseUrl } from "./webauthn-sim.mjs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

// The order rate limiter keys off the client IP and lives in the server process,
// so each run presents its own address to stay independent of previous runs.
const RUN_IP = `198.51.100.${(Date.now() % 200) + 20}`;

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

const call = async (path, { method = "GET", body, cookie, ip, origin } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(ip ? { "x-forwarded-for": ip } : {}),
      // WebAuthn binds a ceremony to the Origin the browser sent, so the passkey
      // checks have to send one exactly as a browser would.
      ...(origin ? { origin } : {}),
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

// An absurd quantity is caught by input validation; a realistic one by the stock guard.
const absurd = await call("/api/sales", {
  method: "POST",
  cookie: cashier,
  body: { channel: "pos", tender: "Cash", lines: [{ product_id: target.sku, qty: 9999 }] },
});
check("absurd quantity is refused by validation", absurd.status === 400 && /between 1 and/i.test(absurd.json?.error ?? ""), absurd.json?.error);

const oversell = await call("/api/sales", {
  method: "POST",
  cookie: cashier,
  body: { channel: "pos", tender: "Cash", lines: [{ product_id: target.sku, qty: after + 1 }] },
});
check("oversell is refused by the stock guard", oversell.status === 400 && /insufficient stock/i.test(oversell.json?.error ?? ""), oversell.json?.error);

// -------------------------------------------------- 5. online order lifecycle
const online = await call("/api/sales", {
  ip: RUN_IP,
  method: "POST",
  body: { channel: "online", customer_name: "Verify Buyer", customer_phone: "+256700111222", lines: [{ product_id: target.sku, qty: 1 }] },
});
check("anonymous online order is accepted", online.status === 201 && online.json?.data?.status === "pending", online.json?.data?.ref);
const pendingStock = (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock;
check("pending online orders do NOT move stock", pendingStock === after, `still ${pendingStock}`);

const admin = await login("admin@adonai.ug", "adonai-admin").catch(() => null);
check("admin can sign in", !!admin);

check("online order returned an id", !!online.json?.data?.id);
if (!online.json?.data?.id) throw new Error("cannot continue without an online order");
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

// ------------------------------------------------- 7b. concurrent settlement
const raceSku = `RACE-${Date.now().toString().slice(-6)}`;
const race = await call("/api/products", {
  method: "POST",
  cookie: admin,
  body: { sku: raceSku, title: "Concurrency Tee", category: "Tops & Blouses", condition: "Good", size: "M", cost_price: 5000, price: 15000, stock: 3, min_stock: 0 },
});
check("race product created with 3 units", race.status === 201, raceSku);

const attempts = await Promise.all(
  Array.from({ length: 6 }, () =>
    call("/api/sales", { method: "POST", cookie: cashier, body: { channel: "pos", tender: "Cash", lines: [{ product_id: race.json.data.id, qty: 1 }] } }),
  ),
);
const accepted = attempts.filter((r) => r.status === 201);
const raceStock = (await call("/api/products")).json.data.find((p) => p.id === race.json.data.id).stock;
const raceRefs = accepted.map((r) => r.json.data.ref);
check("6 simultaneous buys of 3 units → exactly 3 accepted", accepted.length === 3, `${accepted.length} accepted, ${attempts.length - accepted.length} refused`);
check("concurrent settlement never oversells", raceStock === 0, `stock=${raceStock}`);
check("concurrent sales get distinct refs", new Set(raceRefs).size === raceRefs.length, raceRefs.join(" "));
await call(`/api/products/${race.json.data.id}`, { method: "DELETE", cookie: admin });

// ---------------------------------------------- 7c. anonymous order hardening
const noPhone = await call("/api/sales", { ip: RUN_IP, method: "POST", body: { channel: "online", customer_name: "No Phone", lines: [{ product_id: target.sku, qty: 1 }] } });
check("online order without a phone is rejected", noPhone.status === 400, noPhone.json?.error?.slice(0, 40));

const noLines = await call("/api/sales", { ip: RUN_IP, method: "POST", body: { channel: "online", customer_name: "Empty", customer_phone: "+256700000000", lines: [] } });
check("online order with no lines is rejected", noLines.status === 400, noLines.json?.error?.slice(0, 40));

const forced = await call("/api/sales", {
  ip: RUN_IP,
  method: "POST",
  body: { channel: "online", status: "completed", tender: "Cash", amount_received: 999999, customer_name: "Pushy", customer_phone: "+256700000001", lines: [{ product_id: target.sku, qty: 1 }] },
});
check("anonymous callers cannot force status=completed", forced.json?.data?.status === "pending", `status=${forced.json?.data?.status}`);
check("a forced order does not move stock", (await call("/api/products")).json.data.find((p) => p.sku === target.sku).stock === refundedStock, "unchanged");

// Fresh client key per run: the limiter is in-process, so a repeat run must not
// inherit the previous run's used-up bucket.
const spamIp = `203.0.113.${(Date.now() % 200) + 20}`;
const spam = await Promise.all(
  Array.from({ length: 12 }, (_, i) =>
    call("/api/sales", {
      ip: spamIp,
      method: "POST",
      body: { channel: "online", customer_name: `Spam ${i}`, customer_phone: "+256700000002", lines: [{ product_id: target.sku, qty: 1 }] },
    }),
  ),
);
const throttled = spam.filter((r) => r.status === 429).length;
const letThrough = spam.filter((r) => r.status === 201).length;
check("anonymous order endpoint rate-limits", throttled > 0, `${letThrough} through, ${throttled} throttled`);

// --------------------------------------------------- 7d. realtime stock push
const sseSku = `SSE-${Date.now().toString().slice(-6)}`;
const sseProduct = await call("/api/products", {
  method: "POST",
  cookie: admin,
  body: { sku: sseSku, title: "Realtime Probe", category: "Dresses", condition: "Good", size: "M", cost_price: 5000, price: 20000, stock: 2, min_stock: 0 },
});
check("realtime probe product created", sseProduct.status === 201, `${sseSku} stock=2`);

const frames = [];
const sseAbort = new AbortController();
const reader = await (async () => {
  const res = await fetch(`${BASE}/api/stream`, { headers: { accept: "text/event-stream" }, signal: sseAbort.signal });
  check("SSE endpoint serves an event stream", res.status === 200 && (res.headers.get("content-type") || "").includes("text/event-stream"), res.headers.get("content-type"));
  return res.body.getReader();
})();

(async () => {
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = (frame.match(/^event: (.+)$/m) || [])[1];
        const data = (frame.match(/^data: (.+)$/m) || [])[1];
        if (ev && data) frames.push({ ev, data: JSON.parse(data) });
      }
    }
  } catch {
    /* aborted */
  }
})();

await new Promise((r) => setTimeout(r, 600));
check("stream announces itself on connect", frames.some((f) => f.ev === "hello"));

await call("/api/sales", { method: "POST", cookie: cashier, body: { channel: "pos", tender: "Cash", lines: [{ product_id: sseProduct.json.data.id, qty: 1 }] } });
await call("/api/sales", { method: "POST", cookie: cashier, body: { channel: "pos", tender: "Cash", lines: [{ product_id: sseProduct.json.data.id, qty: 1 }] } });
await new Promise((r) => setTimeout(r, 1200));
sseAbort.abort();

const mine = frames.filter((f) => f.ev === "stock" && f.data.product_id === sseProduct.json.data.id);
check("counter sales push stock frames to open browsers", mine.length === 2, mine.map((f) => `stock=${f.data.stock}`).join(" "));
check("a sell-out pushes stock=0 so the site flips to Sold out", mine.some((f) => f.data.stock === 0));
const sseStockNow = (await call("/api/products")).json.data.find((p) => p.id === sseProduct.json.data.id)?.stock;
check("pushed stock matches the database", sseStockNow === 0, `db=${sseStockNow}`);
await call(`/api/products/${sseProduct.json.data.id}`, { method: "DELETE", cookie: admin });

// --------------------------------------------------------------- 8. analytics
const analytics = await call("/api/analytics?days=30", { cookie: admin });
const a = analytics.json?.data;
check("analytics report is returned", analytics.status === 200 && !!a);
check("report has both channels", Array.isArray(a?.byChannel) && a.byChannel.length > 0, (a?.byChannel ?? []).map((c) => c.channel).join("+"));
check(
  "report breaks revenue down by tender",
  Array.isArray(a?.byTender) && a.byTender.length > 0 && a.byTender.every((t) => typeof t.revenue === "number"),
  (a?.byTender ?? []).map((t) => `${t.tender}=${t.revenue}`).join(" "),
);
const tenderSum = (a?.byTender ?? []).reduce((x, t) => x + t.revenue, 0);
check("tender mix reconciles to window revenue", tenderSum === a?.window?.revenue, `${tenderSum} vs ${a?.window?.revenue}`);
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

// ------------------------------------------------- 11. trial & inspection
const manager = await login("manager@adonai.ug", "adonai-manager");
const holdSku = `HOLD-${Date.now().toString().slice(-6)}`;
const holdProduct = await call("/api/products", {
  method: "POST",
  cookie: admin,
  body: { sku: holdSku, title: "Hold Probe", category: "Shoes", condition: "Good", size: "42", cost_price: 4000, price: 18000, stock: 5, min_stock: 2 },
});
check("trial/inspection probe product created", holdProduct.status === 201, `${holdSku} stock=5`);
const holdId = holdProduct.json.data.id;

const trialSet = await call("/api/hold", { method: "POST", cookie: manager, body: { product_id: holdId, bucket: "on_trial", count: 2 } });
check("manager can put units on the trial rail", trialSet.status === 200 && trialSet.json.data.on_trial === 2, `on_trial=${trialSet.json.data?.on_trial}`);
check(
  "the trial rail is advisory — sellable stock is untouched",
  trialSet.json.data?.stock === 5,
  `stock=${trialSet.json.data?.stock} (was 5)`,
);
const inspSet = await call("/api/hold", { method: "POST", cookie: manager, body: { product_id: holdId, bucket: "in_inspection", count: 3 } });
check("units can be sent to inspection", inspSet.status === 200 && inspSet.json.data.in_inspection === 3, `in_inspection=${inspSet.json.data?.in_inspection}`);
check(
  "a piece can be on both rails at once without double-counting stock",
  inspSet.json.data?.stock === 5 && inspSet.json.data?.on_trial === 2,
  `stock=${inspSet.json.data?.stock} trial=${inspSet.json.data?.on_trial} insp=${inspSet.json.data?.in_inspection}`,
);
check(
  "cashier cannot move stock between rails",
  (await call("/api/hold", { method: "POST", cookie: cashier, body: { product_id: holdId, bucket: "on_trial", count: 1 } })).status === 401,
);
check("negative counts are refused", (await call("/api/hold", { method: "POST", cookie: manager, body: { product_id: holdId, bucket: "on_trial", count: -1 } })).status === 400);
check("unknown rails are refused", (await call("/api/hold", { method: "POST", cookie: manager, body: { product_id: holdId, bucket: "on_holiday", count: 1 } })).status === 400);

// The push must carry the advisory counters, or the tabs would need a refetch.
const holdFrames = [];
const holdAbort = new AbortController();
{
  const res = await fetch(`${BASE}/api/stream`, { headers: { accept: "text/event-stream" }, signal: holdAbort.signal });
  const r = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = (frame.match(/^event: (.+)$/m) || [])[1];
          const data = (frame.match(/^data: (.+)$/m) || [])[1];
          if (ev && data) holdFrames.push({ ev, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
}
await new Promise((r) => setTimeout(r, 500));
await call("/api/hold", { method: "POST", cookie: manager, body: { product_id: holdId, bucket: "on_trial", count: 4 } });
await new Promise((r) => setTimeout(r, 1000));
holdAbort.abort();
const holdPush = holdFrames.filter((f) => f.ev === "stock" && f.data.product_id === holdId);
check("moving a piece to trial pushes to open browsers", holdPush.length >= 1, `${holdPush.length} frame(s)`);
check(
  "the push carries the trial and inspection counts",
  holdPush.some((f) => f.data.on_trial === 4 && typeof f.data.in_inspection === "number"),
  holdPush.map((f) => `trial=${f.data.on_trial} insp=${f.data.in_inspection}`).join(" "),
);
check("the push carries min_stock so low-stock badges need no refetch", holdPush.some((f) => f.data.min_stock === 2), `min_stock=${holdPush[0]?.data?.min_stock}`);
await call(`/api/products/${holdId}`, { method: "DELETE", cookie: admin });

const stockPage = await call("/admin/stock", { cookie: manager });
check("Trial & Inspection workspace renders for a manager", stockPage.status === 200 && /Trial &amp; Inspection/.test(stockPage.text) && /Available stock/.test(stockPage.text));
check(
  "cashier is kept out of the Trial & Inspection workspace",
  (await call("/admin/stock", { cookie: cashier })).status === 307,
);

// ---------------------------------------------------------------- 12. passkeys
const rp = rpForBaseUrl(BASE);
/** Every passkey request carries the Origin a browser would send. */
const pk = (path, opts = {}) => call(path, { ...opts, origin: rp.origin });

const anon = await pk("/api/auth/passkey/register/begin", { method: "POST" });
check("passkey enrolment requires a signed-in staff member", anon.status === 401);

const regBegin = await pk("/api/auth/passkey/register/begin", { method: "POST", cookie: cashier });
check(
  "enrolment issues WebAuthn options bound to this host",
  regBegin.status === 200 && regBegin.json.data.rpID === rp.rpID && regBegin.json.data.options.rp.name === "ADONAI THRIFT",
  `rpID=${regBegin.json.data?.rpID}`,
);

// A real ceremony: software authenticator, ES256, verified cryptographically.
const device = await createAuthenticator();
const attestation = await device.register({ rpId: rp.rpID, origin: rp.origin, challenge: regBegin.json.data.options.challenge });
const regDone = await pk("/api/auth/passkey/register/verify", { method: "POST", cookie: cashier, body: { credential: attestation, name: "Counter tablet" } });
check("a genuine attestation is verified and stored", regDone.status === 200 && regDone.json.data.name === "Counter tablet", `id=${regDone.json.data?.id?.slice(0, 8)}…`);
check("the stored credential keeps its public key off the response", !("public_key" in (regDone.json?.data ?? {})));

check(
  "replaying the same attestation is refused (challenge is single-use)",
  (await pk("/api/auth/passkey/register/verify", { method: "POST", cookie: cashier, body: { credential: attestation } })).status === 400,
);
check(
  "a forged credential from an unknown device is refused",
  (await pk("/api/auth/passkey/register/verify", {
    method: "POST",
    cookie: cashier,
    body: { credential: await (await createAuthenticator()).register({ rpId: rp.rpID, origin: rp.origin, challenge: regBegin.json.data.options.challenge }) },
  })).status === 400,
);

const myKeys = await pk("/api/auth/passkey", { cookie: cashier });
check("a staff member sees their own passkeys", myKeys.status === 200 && myKeys.json.data.some((k) => k.id === device.id));

const roster = await pk("/api/admin/passkeys", { cookie: admin });
check("admin sees every registration with its owner", roster.status === 200 && roster.json.data.some((k) => k.id === device.id && k.user_email === "cashier@adonai.ug"));
check("the admin roster never exposes public keys", roster.json?.data?.every((k) => !("public_key" in k)));
check("managers cannot view the passkey roster", (await pk("/api/admin/passkeys", { cookie: manager })).status === 401);

const authBegin = await pk("/api/auth/passkey/login/begin", { method: "POST", body: { email: "cashier@adonai.ug" } });
check(
  "sign-in offers the enrolled credential",
  authBegin.status === 200 && authBegin.json.data.options.allowCredentials?.some((c) => c.id === device.id),
  `${authBegin.json.data?.options?.allowCredentials?.length} allowed`,
);

const assertion = await device.authenticate({ rpId: rp.rpID, origin: rp.origin, challenge: authBegin.json.data.options.challenge });
const pkLogin = await pk("/api/auth/passkey/login/verify", { method: "POST", body: { credential: assertion } });
check("a genuine assertion signs the user in", pkLogin.status === 200 && pkLogin.json.data.email === "cashier@adonai.ug", `via=${pkLogin.json.data?.via}`);
check("the passkey session sets the same cookie as a password login", !!pkLogin.setCookie, pkLogin.setCookie?.split("=")[0]);

const meViaPasskey = await pk("/api/auth/me", { cookie: pkLogin.setCookie });
check("the passkey session resolves to the right account", meViaPasskey.status === 200 && meViaPasskey.json.data.user.role === "cashier");

const replayBegin = await pk("/api/auth/passkey/login/begin", { method: "POST", body: { email: "cashier@adonai.ug" } });
const replay = await device.authenticate({ rpId: rp.rpID, origin: rp.origin, challenge: replayBegin.json.data.options.challenge, reuseCounter: true });
check(
  "a replayed assertion (sign count did not advance) is refused",
  (await pk("/api/auth/passkey/login/verify", { method: "POST", body: { credential: replay } })).status === 401,
);

check("a manager cannot revoke someone else's passkey", (await pk(`/api/admin/passkeys/${device.id}`, { method: "DELETE", cookie: manager, body: {} })).status === 401);
check("a cashier cannot revoke passkeys either", (await pk(`/api/admin/passkeys/${device.id}`, { method: "DELETE", cookie: cashier, body: {} })).status === 401);
check("revoking an unknown credential is a 404", (await pk("/api/admin/passkeys/not-a-real-credential", { method: "DELETE", cookie: admin, body: {} })).status === 404);

const revoked = await pk(`/api/admin/passkeys/${device.id}`, { method: "DELETE", cookie: admin, body: { invalidate_sessions: true } });
check("admin can revoke a passkey", revoked.status === 200 && !!revoked.json.data.revoked_at, `by=${revoked.json.data?.revoked_by}`);
// /api/auth/me answers 200 with a null user rather than 401.
const afterCut = await pk("/api/auth/me", { cookie: pkLogin.setCookie });
check(
  "revoking with sessions cut kills the passkey cookie immediately",
  afterCut.status === 200 && afterCut.json.data.user === null,
  `user=${JSON.stringify(afterCut.json?.data?.user)}`,
);
const afterRevoke = await pk("/api/auth/passkey/login/begin", { method: "POST", body: { email: "cashier@adonai.ug" } });
check(
  "a revoked passkey is never offered at sign-in again",
  afterRevoke.status === 404 || !(afterRevoke.json.data.options.allowCredentials ?? []).some((c) => c.id === device.id),
);
// The credential itself must be dead even if someone replays a signed assertion.
const deadBegin = await pk("/api/auth/passkey/login/begin", { method: "POST" });
const deadAssertion = await device.authenticate({ rpId: rp.rpID, origin: rp.origin, challenge: deadBegin.json.data.options.challenge });
const deadLogin = await pk("/api/auth/passkey/login/verify", { method: "POST", body: { credential: deadAssertion } });
check(
  "a validly signed assertion from a revoked passkey is refused",
  deadLogin.status === 401 && /revoked/i.test(deadLogin.json?.error ?? ""),
  deadLogin.json?.error,
);
check(
  "revoking twice is reported, not silently accepted",
  (await pk(`/api/admin/passkeys/${device.id}`, { method: "DELETE", cookie: admin, body: {} })).status === 409,
);

// The revocation above cut every cashier session by design, so sign in again.
const cashierAgain = await login("cashier@adonai.ug", "adonai-cashier");
check("the password path still works after a passkey revocation", !!cashierAgain);

// Enrol a second device so the reset flow has something to act on, whatever
// state previous runs left behind.
const secondDevice = await createAuthenticator();
const secondBegin = await pk("/api/auth/passkey/register/begin", { method: "POST", cookie: cashierAgain });
const secondDone = await pk("/api/auth/passkey/register/verify", {
  method: "POST",
  cookie: cashierAgain,
  body: { credential: await secondDevice.register({ rpId: rp.rpID, origin: rp.origin, challenge: secondBegin.json.data.options.challenge }) },
});
check("a second device can be enrolled on the same account", secondDone.status === 200);

const reset = await pk(`/api/admin/users/${meViaPasskey.json.data.user.id}/passkeys/reset`, { method: "POST", cookie: admin, body: {} });
check(
  "the reset flow revokes everything an account holds in one action",
  reset.status === 200 && reset.json.data.revoked === 1,
  `revoked=${reset.json.data?.revoked}`,
);
check("managers cannot run the reset flow", (await pk(`/api/admin/users/${meViaPasskey.json.data.user.id}/passkeys/reset`, { method: "POST", cookie: manager, body: {} })).status === 401);

const securityPage = await pk("/admin/security", { cookie: admin });
check("Security & Passkeys renders for an admin", securityPage.status === 200 && /Security &amp; Passkeys/.test(securityPage.text));
check(
  "managers are redirected away from Security & Passkeys",
  (await pk("/admin/security", { cookie: manager })).status === 307,
);
check("the login screen offers a passkey", /Continue with a passkey/.test((await pk("/login")).text));

// ------------------------------------------------------------------ summary
console.log(`\n${pass} passed, ${fail} failed${fail ? ` → ${failures.join("; ")}` : ""}\n`);
process.exit(fail ? 1 : 0);
