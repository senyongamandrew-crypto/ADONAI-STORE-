"use strict";
/* Adonai Delivery — the third application.
   Exercises the real app shell/logic against an in-memory rider API, proving:
   connect -> receive -> accept/decline -> deliver -> history, plus separation
   from the storefront and cashier register and safe literal customer text. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const css = require("css-tree");

const source = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const settle = async (times = 5) => { for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0)); };

function response(status, data) {
  return Promise.resolve({
    status, ok: status >= 200 && status < 300,
    json: () => Promise.resolve(data)
  });
}

function fixture(options) {
  options = options || {};
  const dom = new JSDOM(source("delivery.html"), {
    url: options.url || "https://store.example/delivery?demo=1#jobs",
    runScripts: "outside-only", pretendToBeVisual: true
  });
  const win = dom.window;
  const rider = {
    id: "R1", name: "Kato <script>alert(1)</script>", phone: "0772555010",
    status: "Available", vehicle: "Motorbike (Boda)", plate: "UEP 442X", zone: "Kololo"
  };
  const order = id => ({
    id, customer_name: "Sarah <img src=x onerror=alert(1)>", customer_phone: "+256772123456",
    address: "Plot 12 Kololo Terrace", area: "Kololo", notes: "Leave with the gatekeeper",
    total: 90000, delivery_fee: 5000, dispatch_status: "Dispatched", paid: true,
    created_at: new Date().toISOString(), progress: { stage: "assigned", id: "E0", note: "", received_by: "", created_at: new Date().toISOString(), order_id: id, rider_id: "R1" }
  });
  const db = {
    token: null, rider, orders: [order("AT-1")], history: [], calls: [],
    duty: false, demo: true, gpsPolicy: true, status: 200
  };
  win.fetch = (url, options) => {
    options = options || {};
    const p = new URL(url, "https://store.example").pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};
    db.calls.push({ path: p, method, body, auth: (options.headers || {}).Authorization || "" });
    if (p === "/api/rider/demo-status" && method === "GET") {
      return response(200, { ok: true, demo: options.demoStatus !== false });
    }
    if (p === "/api/rider/connect" && method === "POST") {
      if (body.code !== "DEMORIDERS") return response(403, { ok: false, error: "That connection code is not valid. Ask dispatch for a fresh one." });
      db.token = "T".repeat(43);
      return response(201, { ok: true, session_token: db.token, rider, device_id: "RDP-1", expires_at: new Date(Date.now() + 86400000).toISOString(), gps_policy: db.gpsPolicy, demo: db.demo });
    }
    if (!(options.headers || {}).Authorization) return response(401, { ok: false, error: "Pair this phone again." });
    if (p === "/api/rider/me" && method === "GET") {
      return response(200, {
        ok: true, rider: rider, tracking: { state: db.duty ? "waiting" : "paused", sharing: db.duty, point: null },
        orders: db.orders.map(o => ({ ...o })), server_time: new Date().toISOString(),
        gps_policy: db.gpsPolicy, demo: db.demo
      });
    }
    let match = p.match(/^\/api\/rider\/orders\/([^/]+)\/progress$/);
    if (match && method === "POST") {
      const o = db.orders.find(x => x.id === match[1]);
      if (!o) return response(404, { ok: false, error: "This delivery is not assigned to you." });
      o.progress = { ...o.progress, stage: body.stage, note: body.note || "", received_by: body.received_by || "" };
      if (body.stage === "delivered") {
        db.history.unshift({ id: o.id, customer_name: o.customer_name, area: o.area, total: o.total, delivery_fee: o.delivery_fee, received_by: body.received_by, delivered_at: new Date().toISOString(), note: body.note || "" });
        db.orders = db.orders.filter(x => x.id !== o.id);
      }
      return response(200, { ok: true, event: o.progress, order: o });
    }
    match = p.match(/^\/api\/rider\/orders\/([^/]+)\/decline$/);
    if (match && method === "POST") {
      db.orders = db.orders.filter(x => x.id !== match[1]);
      return response(200, { ok: true, event: { stage: "declined" }, rider });
    }
    match = p.match(/^\/api\/rider\/orders\/([^/]+)$/);
    if (match && method === "GET") {
      const o = db.orders.find(x => x.id === match[1]);
      if (!o) return response(404, { ok: false, error: "This delivery is not assigned to you." });
      return response(200, { ok: true, order: { ...o, items: [{ name: "Denim jacket", qty: 1, unit_price: 85000, barcode_id: "ADN-1", category: "Jackets" }], timeline: [o.progress], subtotal: 85000, payment_status: "paid", payment_method: "momo" } });
    }
    if (p === "/api/rider/history" && method === "GET") {
      return response(200, { ok: true, history: db.history, rider,
        earnings: { all: db.history.reduce((n, h) => n + h.delivery_fee, 0), week: 5000, today: 5000, jobs: db.history.length }, server_time: new Date().toISOString() });
    }
    if (p === "/api/rider/status" && method === "POST") {
      rider.status = body.status;
      return response(200, { ok: true, rider });
    }
    if (p === "/api/rider/duty/start" && method === "POST") { db.duty = true; return response(200, { ok: true, duty_until: new Date(Date.now() + 3600000).toISOString() }); }
    if (p === "/api/rider/duty/stop" && method === "POST") { db.duty = false; return response(200, { ok: true, tracking: { state: "paused" } }); }
    if (p === "/api/rider/location" && method === "POST") return response(200, { ok: true, state: "simulated" });
    if (p === "/api/rider/demo/order" && method === "POST") {
      const fresh = order("AT-2"); db.orders.push(fresh);
      return response(201, { ok: true, order_id: "AT-2" });
    }
    return response(404, { ok: false, error: "Dispatch route not found." });
  };
  win.eval(source("js/delivery-app.js"));
  win.document.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  return { dom, win, doc: win.document, db, close: () => dom.window.close() };
}

(async () => {
  /* ---------- static separation / PWA assets ---------- */
  const html = source("delivery.html");
  assert.match(html, /manifest-delivery\.json/);
  assert.doesNotMatch(html, /js\/(app|pos|admin|storefront|db|auth)\.js/, "rider app must not load storefront or cashier scripts");
  assert.match(html, /js\/delivery-app\.js/);
  const manifest = JSON.parse(source("manifest-delivery.json"));
  assert.equal(manifest.start_url, "/delivery#jobs");
  assert.equal(manifest.scope, "/delivery");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 3);
  assert.ok(manifest.icons.some(i => i.purpose === "maskable"));
  assert.ok(manifest.shortcuts.length >= 2);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(__dirname, "..", icon.src)), icon.src);
  const sw = source("sw-delivery.js");
  assert.match(sw, /\/api\//, "service worker must explicitly skip API caching");
  assert.match(sw, /scope|delivery/);
  css.parse(source("css/delivery.css"), { onParseError(error) { throw error; } });
  const routes = source("serve.py");
  assert.match(routes, /"\/delivery": "delivery\.html"/);
  assert.match(routes, /"\/manifest-delivery\.json"/);
  const dispatch = source("dispatch.py");
  for (const route of ["/api/rider/connect", "/api/rider/demo-status", "/decline", "/rider/status", "/rider/history", "/rider/demo/order", "/app-code"]) {
    assert.ok(dispatch.includes(route), "missing rider API route " + route);
  }
  assert.match(dispatch, /os\.environ\.get\("ADONAI_DELIVERY_DEMO"\)/, "demo order endpoint must be env-gated");
  assert.match(source("js/db.js"), /deliveryAppCode/, "dispatch DB helper for app codes");
  assert.match(source("js/dispatch-center.js"), /data-app-code-rider/, "dispatch console app-code button");
  assert.match(source("admin.html"), /dispatchPairKicker/);
  console.log("✓ separate installable app shell, own icons/manifest/worker, own routes, no cashier scripts");

  /* ---------- connect -> jobs -> accept -> deliver ---------- */
  const f = fixture();
  try {
    const doc = f.doc, win = f.win;
    assert.equal(doc.getElementById("appScreen").hidden, true, "connect screen first");
    assert.equal(doc.getElementById("connectCode").value, "DEMORIDERS", "demo param pre-fills the demo code");

    // A wrong code is refused without leaving the connect screen.
    doc.getElementById("connectCode").value = "WRONGCODE";
    doc.getElementById("connectForm").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle(6);
    assert.match(doc.getElementById("connectError").textContent, /not valid/i);
    assert.equal(doc.getElementById("appScreen").hidden, true);

    doc.getElementById("connectCode").value = "DEMORIDERS";
    doc.getElementById("connectForm").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle(8);
    assert.equal(doc.getElementById("appScreen").hidden, false, "connected app screen visible");
    assert.equal(doc.getElementById("connectScreen").hidden, true);
    assert.match(doc.getElementById("topRider").textContent, /Kato/);
    assert.equal(doc.querySelectorAll("#view img").length, 0, "customer/rider names stay literal text");
    assert.ok(doc.getElementById("view").textContent.includes("Sarah <img"), "literal customer text preserved");
    assert.match(doc.getElementById("view").textContent, /Accept delivery/);

    // Parcel details sheet (items + timeline).
    doc.querySelector("[data-detail]").click();
    await settle(6);
    assert.match(doc.getElementById("sheetHost").textContent, /Denim jacket/);
    assert.match(doc.getElementById("sheetHost").textContent, /PARCEL CONTENTS/);
    assert.equal(doc.querySelectorAll("#sheetHost img").length, 0);
    doc.querySelector("[data-close]").click();

    // Accept the job — real progress call.
    doc.querySelector('[data-stage="accepted"]').click();
    await settle(8);
    assert.ok(f.db.calls.some(c => c.path.endsWith("/progress") && c.body.stage === "accepted"));
    assert.match(doc.getElementById("view").textContent, /Accepted/);
    assert.match(doc.getElementById("view").textContent, /Collected from store/);

    // A newly assigned order arriving on a later sync raises a banner + badge.
    f.db.orders.push({
      id: "AT-3", customer_name: "Moses", customer_phone: "0755111222", address: "Nakawa", area: "Nakawa",
      notes: "", total: 65000, delivery_fee: 5000, dispatch_status: "Dispatched", paid: true,
      created_at: new Date().toISOString(), progress: { stage: "assigned", id: "E3", note: "", received_by: "", created_at: new Date().toISOString(), order_id: "AT-3", rider_id: "R1" }
    });
    win.dispatchEvent(new win.Event("online"));
    await settle(8);
    assert.match(doc.getElementById("bannerHost").textContent, /new delivery is waiting/i);
    assert.equal(doc.getElementById("tabBadge").hidden, false);

    // Decline that new job with a reason — it disappears and returns to dispatch.
    const declineBtn = Array.from(doc.querySelectorAll("[data-decline]")).find(b => b.getAttribute("data-decline") === "AT-3");
    assert.ok(declineBtn, "new job has a Decline action");
    declineBtn.click();
    await settle(3);
    assert.match(doc.getElementById("sheetHost").textContent, /Decline this delivery/);
    doc.querySelector('[data-reason="Vehicle problem"]').click();
    doc.getElementById("sheetGo").click();
    await settle(8);
    assert.ok(f.db.calls.some(c => c.path.endsWith("/AT-3/decline") && c.body.reason === "Vehicle problem"));
    assert.ok(!doc.getElementById("view").textContent.includes("AT-3"), "declined job leaves the rider's list");

    // Finish AT-1: collected -> arrived -> delivered (proof required).
    doc.querySelector('[data-stage="collected"]').click(); await settle(7);
    doc.querySelector('[data-stage="arrived"]').click(); await settle(7);
    const delivered = Array.from(doc.querySelectorAll("[data-progress]")).find(b => b.getAttribute("data-stage") === "delivered");
    assert.ok(delivered, "arrived job offers Confirm delivered");
    delivered.click(); await settle(3);
    assert.match(doc.getElementById("sheetHost").textContent, /Confirm delivery/);
    doc.getElementById("sheetGo").click(); await settle(3);
    assert.match(doc.getElementById("sheetError").textContent, /name of the person/i, "recipient name is required");
    doc.getElementById("proofName").value = "Sarah Nansubuga";
    doc.getElementById("sheetGo").click(); await settle(3);
    assert.match(doc.getElementById("sheetError").textContent, /handed over the parcel/i, "hand-over confirmation is required");
    doc.getElementById("proofConfirm").checked = true;
    doc.getElementById("sheetGo").click(); await settle(9);
    assert.ok(f.db.calls.some(c => c.path.endsWith("/progress") && c.body.stage === "delivered" && c.body.received_by === "Sarah Nansubuga"));

    // History shows the completed job and the fee.
    doc.querySelector('[data-tab="history"]').click(); await settle(8);
    assert.match(doc.getElementById("view").textContent, /Sarah Nansubuga/);
    assert.match(doc.getElementById("view").textContent, /5,000/);
    assert.match(doc.getElementById("view").textContent, /not a payout statement/i);

    // Availability is rider-scoped (never a staff endpoint).
    doc.querySelector('[data-tab="jobs"]').click(); await settle(3);
    doc.querySelector('[data-status="Offline"]').click(); await settle(7);
    assert.ok(f.db.calls.some(c => c.path === "/api/rider/status" && c.body.status === "Offline"));
    assert.equal(f.db.rider.status, "Offline");

    // GPS duty requires explicit consent.
    doc.querySelector('[data-duty="start"]').click(); await settle(3);
    assert.match(doc.getElementById("sheetHost").textContent, /agree to share/i);
    doc.getElementById("dutyReal").click(); await settle(3);
    assert.match(doc.getElementById("sheetError").textContent, /consent box/i);
    assert.ok(!f.db.calls.some(c => c.path === "/api/rider/duty/start"), "no duty without consent");
    doc.getElementById("dutyConsent").checked = true;
    doc.getElementById("dutyMock").click(); await settle(8);
    assert.ok(f.db.calls.some(c => c.path === "/api/rider/duty/start" && c.body.consent === true));
    assert.ok(f.db.calls.some(c => c.path === "/api/rider/location" && c.body.mock === true), "simulated fixes are honestly flagged");

    // Demo order button creates a fresh assignment.
    doc.querySelector('[data-tab="profile"]').click(); await settle(3);
    doc.querySelector('[data-profile="demo"]').click(); await settle(8);
    assert.ok(f.db.calls.some(c => c.path === "/api/rider/demo/order"));

    // Sign out clears the device session.
    doc.querySelector('[data-profile="signout"]').click(); await settle(5);
    assert.equal(doc.getElementById("connectScreen").hidden, false);
    assert.equal(doc.getElementById("appScreen").hidden, true);
    assert.equal(win.localStorage.getItem("adonai.delivery.session.v1"), null);
    console.log("✓ connect, receive, accept, decline, deliver with proof, history, availability, consented GPS, sign out");
  } finally { f.close(); }

  /* ---------- demo self-configuration without a query flag ---------- */
  const plain = fixture({ url: "https://store.example/delivery#jobs" });
  try {
    await settle(6);
    assert.equal(plain.doc.getElementById("demoChip").hidden, false, "public capability flag reveals the demo hint");
    assert.equal(plain.doc.getElementById("connectCode").value, "DEMORIDERS");
    assert.equal(plain.doc.getElementById("deskDemo").hidden, false);
    assert.ok(plain.db.calls.some(c => c.path === "/api/rider/demo-status"));
    console.log("✓ review-sandbox capability flag sets up the demo without a query parameter");
  } finally { plain.close(); }

  /* ---------- offline queue ---------- */
  const off = fixture();
  try {
    const doc = off.doc, win = off.win;
    doc.getElementById("connectForm").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle(8);
    assert.equal(doc.getElementById("appScreen").hidden, false);
    off.win.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    doc.querySelector('[data-stage="accepted"]').click();
    await settle(8);
    assert.match(doc.getElementById("toastHost").textContent, /saved on this phone/i);
    const queued = JSON.parse(win.localStorage.getItem("adonai.delivery.pending.v1"));
    assert.equal(queued.length, 1, "one progress update is queued offline");
    assert.equal(queued[0].body.stage, "accepted");
    console.log("✓ offline updates are queued on the device instead of being lost");
  } finally { off.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
