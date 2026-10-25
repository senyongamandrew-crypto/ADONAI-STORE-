"use strict";
/* Adonai Delivery — the third application.
   Drives the real delivery.html + js/delivery-app.js against an in-memory API
   that mirrors the server's rules, proving the rider journey:
     sign in (phone + password) -> selfie & signature check-in -> dispatch
     connection code -> one-tap accept -> collect -> deliver with proof,
     plus the daily check-in gate, separation from the storefront and cashier,
     safe literal customer text, consented GPS and offline queueing. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const css = require("css-tree");

const source = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const settle = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0)); };
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOKEN_ACCOUNT = "A".repeat(43);
const TOKEN_DEVICE = "D".repeat(43);

function response(status, data) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(data) });
}

/* Browser APIs jsdom lacks: canvas, image decoding, object URLs. */
class FakeImage {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
  set src(value) {
    this._src = value;
    setTimeout(() => {
      this.naturalWidth = 1200; this.naturalHeight = 1600;
      if (this.onload) this.onload();
    }, 0);
  }
  get src() { return this._src; }
}
function stubBrowser(win, state) {
  win.Image = FakeImage;
  win.URL.createObjectURL = () => "blob:adonai-test";
  win.URL.revokeObjectURL = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", lineJoin: "",
    fillRect() {}, drawImage() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}
  };
  win.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
  win.HTMLCanvasElement.prototype.toDataURL = function (type) {
    if (type === "image/png") return "data:image/png;base64," + Buffer.concat([PNG_MAGIC, Buffer.alloc(300)]).toString("base64");
    const size = state.bigSelfie ? 420 * 1024 : 900;
    return "data:image/jpeg;base64," + Buffer.concat([JPEG_MAGIC, Buffer.alloc(size)]).toString("base64");
  };
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
    created_at: new Date().toISOString(),
    progress: { stage: "assigned", id: "E0", note: "", received_by: "", created_at: new Date().toISOString(), order_id: id, rider_id: "R1" }
  });
  const db = {
    account: { id: "RAC-DEMO01", name: "Kato Brian", phone: "256772555010", password: "rider-demo-1", linked: false },
    accountToken: null, attendance: null, linked: false, token: null,
    rider, orders: [order("AT-1")], history: [], calls: [], duty: false, demo: options.demo !== false, gpsPolicy: true
  };
  if (options.signedIn) db.accountToken = TOKEN_ACCOUNT;
  if (options.checkedIn) db.attendance = { id: "ATT-0", day: "2026-10-25", taken_at: new Date().toISOString(), signed: true, selfie_type: "jpeg" };
  if (options.linked) { db.linked = true; db.token = TOKEN_DEVICE; db.accountToken = TOKEN_ACCOUNT; db.attendance = db.attendance || { id: "ATT-0", day: "2026-10-25", signed: true, selfie_type: "jpeg", taken_at: new Date().toISOString() }; }
  const stub = { bigSelfie: false };
  stubBrowser(win, stub);
  win.fetch = (url, opts) => {
    opts = opts || {};
    const p = new URL(url, "https://store.example").pathname;
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : {};
    const auth = (opts.headers || {}).Authorization || "";
    db.calls.push({ path: p, method, body, auth });

    if (p === "/api/rider/demo-status" && method === "GET") return response(200, { ok: true, demo: db.demo });

    /* ---------- rider account (sign in, check-in, connect) ---------- */
    if (p === "/api/rider-account/login" && method === "POST") {
      let phone = String(body.phone || "").replace(/\D/g, "");
      if (phone.length === 10 && phone[0] === "0") phone = "256" + phone.slice(1);
      if (phone !== db.account.phone || body.password !== db.account.password) {
        return response(401, { ok: false, error: "Phone number or password is not correct.", code: "BAD_CREDENTIALS" });
      }
      db.accountToken = TOKEN_ACCOUNT;
      return response(200, { ok: true, session_token: TOKEN_ACCOUNT, account: { id: db.account.id, name: db.account.name, phone: db.account.phone, linked: db.linked } });
    }
    if (p === "/api/rider-account/signup" && method === "POST") {
      let phone = String(body.phone || "").replace(/\D/g, "");
      if (phone.length === 10 && phone[0] === "0") phone = "256" + phone.slice(1);
      if (String(body.password || "").length < 8) return response(400, { ok: false, error: "Choose a password of at least 8 characters.", code: "PASSWORD_INVALID" });
      db.account = { id: "RAC-NEW", name: body.name, phone, password: body.password, linked: false };
      db.accountToken = TOKEN_ACCOUNT;
      return response(201, { ok: true, session_token: TOKEN_ACCOUNT, account: { id: "RAC-NEW", name: body.name, phone, linked: false } });
    }
    if (p.indexOf("/api/rider-account/") === 0) {
      if (auth !== "Bearer " + db.accountToken || !db.accountToken) {
        return response(401, { ok: false, error: "Sign in to your Adonai Delivery account.", code: "SIGN_IN_REQUIRED" });
      }
      if (p === "/api/rider-account/me" && method === "GET") {
        return response(200, { ok: true, account: { id: db.account.id, name: db.account.name, phone: db.account.phone, linked: db.linked, rider_id: db.linked ? "R1" : "" }, day: "2026-10-25", attendance: db.attendance });
      }
      if (p === "/api/rider-account/attendance" && method === "POST") {
        if (body.consent !== true) return response(400, { ok: false, error: "Confirm that this selfie and signature are your attendance for today.", code: "CONSENT_REQUIRED" });
        if (!String(body.selfie).startsWith("data:image/jpeg;base64,")) return response(400, { ok: false, error: "The selfie picture is not in a supported format.", code: "IMAGE_INVALID" });
        if (!String(body.signature).startsWith("data:image/png;base64,")) return response(400, { ok: false, error: "The signature picture is not in a supported format.", code: "IMAGE_INVALID" });
        if (db.attendance) return response(200, { ok: true, already: true, attendance: db.attendance });
        db.attendance = { id: "ATT-1", day: "2026-10-25", taken_at: new Date().toISOString(), signed: true, selfie_type: "jpeg" };
        return response(201, { ok: true, already: false, attendance: db.attendance });
      }
      if (p === "/api/rider-account/connect" && method === "POST") {
        if (!db.attendance) return response(409, { ok: false, error: "Check in for today first: take your selfie and sign.", code: "ATTENDANCE_REQUIRED" });
        if (body.code !== "DEMORIDERS") return response(403, { ok: false, error: "That connection code is not valid. Ask dispatch for a fresh one." });
        db.linked = true; db.token = TOKEN_DEVICE;
        return response(201, { ok: true, session_token: TOKEN_DEVICE, rider: db.rider, device_id: "RDP-1", expires_at: new Date(Date.now() + 86400000).toISOString(), gps_policy: db.gpsPolicy, demo: db.demo });
      }
      if (p === "/api/rider-account/logout" && method === "POST") {
        db.accountToken = null; db.token = null; db.linked = false;
        return response(200, { ok: true });
      }
      return response(404, { ok: false, error: "Account route not found." });
    }
    if (p === "/api/rider/connect") return response(410, { ok: false, error: "Sign in to your Adonai Delivery account first, then enter the connection code.", code: "CONNECT_MOVED" });

    /* ---------- linked rider device ---------- */
    if (!auth) return response(401, { ok: false, error: "Pair this phone again." });
    if (auth !== "Bearer " + db.token) return response(401, { ok: false, error: "This phone's connection expired. Enter a new App code from dispatch." });
    if (p === "/api/rider/me" && method === "GET") {
      return response(200, {
        ok: true, rider: db.rider, tracking: { state: db.duty ? "waiting" : "paused", sharing: db.duty, point: null },
        orders: db.orders.map(o => ({ ...o })), server_time: new Date().toISOString(),
        gps_policy: db.gpsPolicy, attendance_required: db.linked, checked_in_today: !!db.attendance, demo: db.demo
      });
    }
    let match = p.match(/^\/api\/rider\/orders\/([^/]+)\/progress$/);
    if (match && method === "POST") {
      const o = db.orders.find(x => x.id === match[1]);
      if (!o) return response(404, { ok: false, error: "This delivery is not assigned to you." });
      if (body.stage === "accepted" && db.linked && !db.attendance) {
        return response(409, { ok: false, error: "Check in for today first: take your selfie and sign.", code: "ATTENDANCE_REQUIRED" });
      }
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
      return response(200, { ok: true, event: { stage: "declined" }, rider: db.rider });
    }
    match = p.match(/^\/api\/rider\/orders\/([^/]+)$/);
    if (match && method === "GET") {
      const o = db.orders.find(x => x.id === match[1]);
      if (!o) return response(404, { ok: false, error: "This delivery is not assigned to you." });
      return response(200, { ok: true, order: { ...o, items: [{ name: "Denim jacket", qty: 1, unit_price: 85000, barcode_id: "ADN-1", category: "Jackets" }], timeline: [o.progress], subtotal: 85000, payment_status: "paid", payment_method: "momo" } });
    }
    if (p === "/api/rider/history" && method === "GET") {
      return response(200, { ok: true, history: db.history, rider: db.rider,
        earnings: { all: db.history.reduce((n, h) => n + h.delivery_fee, 0), week: 5000, today: 5000, jobs: db.history.length }, server_time: new Date().toISOString() });
    }
    if (p === "/api/rider/status" && method === "POST") { db.rider.status = body.status; return response(200, { ok: true, rider: db.rider }); }
    if (p === "/api/rider/duty/start" && method === "POST") { db.duty = true; return response(200, { ok: true }); }
    if (p === "/api/rider/duty/stop" && method === "POST") { db.duty = false; return response(200, { ok: true, tracking: { state: "paused" } }); }
    if (p === "/api/rider/location" && method === "POST") return response(200, { ok: true, state: "simulated" });
    if (p === "/api/rider/demo/order" && method === "POST") {
      db.orders.push(order("AT-2"));
      return response(201, { ok: true, order_id: "AT-2" });
    }
    return response(404, { ok: false, error: "Dispatch route not found." });
  };
  if (options.linked) {
    // A phone that finished onboarding earlier: both sessions are on the device.
    win.localStorage.setItem("adonai.delivery.account.v1", JSON.stringify({
      token: TOKEN_ACCOUNT, account: { id: "RAC-DEMO01", name: "Kato Brian", phone: "256772555010", linked: true },
      attendance: db.attendance, day: "2026-10-25", base: "https://store.example"
    }));
    win.localStorage.setItem("adonai.delivery.session.v1", JSON.stringify({
      token: TOKEN_DEVICE, base: "https://store.example", label: "My delivery phone", rider,
      accountId: "RAC-DEMO01", connectedAt: new Date().toISOString()
    }));
  }
  win.eval(source("js/delivery-app.js"));
  win.document.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  return { dom, win, doc: win.document, db, stub, close: () => dom.window.close() };
}

function submit(win, form) {
  form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
}
function selectFile(win, input, file) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
}
function draw(win, canvas) {
  const down = new win.MouseEvent("pointerdown", { clientX: 20, clientY: 40, bubbles: true, cancelable: true });
  const move = new win.MouseEvent("pointermove", { clientX: 160, clientY: 90, bubbles: true, cancelable: true });
  const up = new win.MouseEvent("pointerup", { clientX: 160, clientY: 90, bubbles: true, cancelable: true });
  canvas.dispatchEvent(down); canvas.dispatchEvent(move); canvas.dispatchEvent(up);
}
function visible(doc, id) { return !doc.getElementById(id).hidden; }

(async () => {
  /* ---------- static separation / PWA assets ---------- */
  const html = source("delivery.html");
  assert.match(html, /manifest-delivery\.json/);
  assert.doesNotMatch(html, /js\/(app|pos|admin|storefront|db|auth)\.js/, "rider app must not load storefront or cashier scripts");
  assert.match(html, /js\/delivery-app\.js/);
  assert.match(html, /id="checkinScreen"[\s\S]*id="signPad"/, "signature pad lives on the check-in step");
  assert.match(html, /capture="user"/, "selfie opens the front camera");
  const manifest = JSON.parse(source("manifest-delivery.json"));
  assert.equal(manifest.start_url, "/delivery#jobs");
  assert.equal(manifest.scope, "/delivery");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 3);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(__dirname, "..", icon.src)), icon.src);
  const sw = source("sw-delivery.js");
  assert.match(sw, /\/api\//, "service worker must explicitly skip API caching");
  css.parse(source("css/delivery.css"), { onParseError(error) { throw error; } });
  const routes = source("serve.py");
  assert.match(routes, /"\/delivery": "delivery\.html"/);
  assert.match(routes, /"\/manifest-delivery\.json"/);
  const dispatch = source("dispatch.py");
  for (const route of ["/api/rider/demo-status", "/decline", "/rider/status", "/rider/history", "/rider/demo/order", "/app-code", "/api/dispatch/attendance"]) {
    assert.ok(dispatch.includes(route), "missing rider API route " + route);
  }
  assert.ok(dispatch.includes("ATTENDANCE_REQUIRED"), "accepting is gated by today's check-in");
  assert.ok(dispatch.includes("CONNECT_MOVED"), "/api/rider/connect is retired with a 410 response");
  assert.match(source("api.py"), /\/api\/rider-account\//, "rider account routes are wired into the API");
  assert.match(dispatch, /os\.environ\.get\("ADONAI_DELIVERY_DEMO"\)/, "demo order endpoint must be env-gated");
  assert.match(source("scripts/demo_seed.py"), /0772555010/, "demo seed provides the demo sign-in");
  assert.match(source("js/db.js"), /deliveryAppCode/, "dispatch DB helper for app codes");
  assert.match(source("js/dispatch-center.js"), /data-app-code-rider/, "dispatch console app-code button");
  console.log("✓ separate installable app, own routes, sign-in + check-in + connect routes, no cashier scripts");

  /* ---------- sign in -> selfie & signature -> code -> one-tap accept ---------- */
  const f = fixture({ url: "https://store.example/delivery?demo=1#jobs" });
  try {
    const doc = f.doc, win = f.win;
    await settle(8);
    assert.ok(visible(doc, "authScreen"), "a new phone starts at sign-in");
    assert.equal(doc.getElementById("authPhone").value, "0772555010", "demo flag pre-fills the demo phone");
    assert.equal(doc.getElementById("authPassword").value, "rider-demo-1", "demo flag pre-fills the demo password");
    assert.equal(visible(doc, "appScreen"), false, "no jobs before sign-in");

    // A wrong password is refused without leaving sign-in.
    doc.getElementById("authPassword").value = "wrong-pass";
    submit(win, doc.getElementById("authForm"));
    await settle(6);
    assert.match(doc.getElementById("authError").textContent, /not correct/i);
    assert.ok(visible(doc, "authScreen"));

    // Correct password: account is signed in; the phone still needs check-in.
    doc.getElementById("authPassword").value = "rider-demo-1";
    submit(win, doc.getElementById("authForm"));
    await settle(8);
    assert.ok(visible(doc, "checkinScreen"));
    assert.equal(visible(doc, "connectScreen"), false, "no connection code before check-in");
    const stored = win.localStorage.getItem("adonai.delivery.account.v1");
    assert.ok(stored && stored.includes(TOKEN_ACCOUNT), "account session is kept on the phone");
    assert.ok(!stored.includes("rider-demo-1"), "the password is never stored on the phone");

    // Check-in needs a selfie, a signature and consent, in that order.
    submit(win, doc.getElementById("checkinForm"));
    await settle(4);
    assert.match(doc.getElementById("checkinError").textContent, /Take a selfie/);
    selectFile(win, doc.getElementById("selfieInput"), new win.File(["x"], "me.jpg", { type: "image/jpeg" }));
    await settle(8);
    assert.equal(doc.getElementById("selfiePreview").hidden, false, "selfie preview is shown");
    assert.match(doc.getElementById("selfiePreview").getAttribute("src"), /^data:image\/jpeg;base64,/, "selfie is compressed to a JPEG");
    submit(win, doc.getElementById("checkinForm"));
    await settle(4);
    assert.match(doc.getElementById("checkinError").textContent, /Sign in the box/);
    draw(win, doc.getElementById("signPad"));
    submit(win, doc.getElementById("checkinForm"));
    await settle(4);
    assert.match(doc.getElementById("checkinError").textContent, /consent box/);
    doc.getElementById("checkinConsent").checked = true;
    submit(win, doc.getElementById("checkinForm"));
    await settle(8);
    const attendanceCall = f.db.calls.find(c => c.path === "/api/rider-account/attendance");
    assert.ok(attendanceCall, "check-in is sent to the server");
    assert.equal(attendanceCall.body.consent, true);
    assert.ok(attendanceCall.body.selfie.startsWith("data:image/jpeg;base64,"));
    assert.ok(attendanceCall.body.signature.startsWith("data:image/png;base64,"));
    assert.ok(visible(doc, "connectScreen"), "after check-in the connection code is requested");

    // A wrong code is refused; the right one links the phone.
    doc.getElementById("connectCode").value = "WRONGCODE";
    submit(win, doc.getElementById("connectForm"));
    await settle(6);
    assert.match(doc.getElementById("connectError").textContent, /not valid/i);
    assert.ok(visible(doc, "connectScreen"));
    doc.getElementById("connectCode").value = "DEMORIDERS";
    submit(win, doc.getElementById("connectForm"));
    await settle(10);
    assert.ok(visible(doc, "appScreen"), "linked phone opens the job inbox");
    assert.match(doc.getElementById("topRider").textContent, /Kato/);
    assert.equal(doc.querySelectorAll("#view img").length, 0, "customer/rider names stay literal text");
    assert.ok(doc.getElementById("view").textContent.includes("Sarah <img"), "literal customer text preserved");

    // One tap accepts an assigned order: no confirmation sheet, a real call.
    const accept = doc.querySelector('[data-progress="AT-1"][data-stage="accepted"]');
    assert.match(accept.textContent, /Accept/, "assigned order offers a single Accept button");
    accept.click();
    await settle(8);
    assert.ok(f.db.calls.some(c => c.path.endsWith("/AT-1/progress") && c.body.stage === "accepted"), "one tap posts acceptance");
    assert.equal(doc.getElementById("sheetHost").hidden, true, "accepting needs no extra sheet");
    assert.match(doc.getElementById("view").textContent, /Accepted/);
    assert.match(doc.getElementById("view").textContent, /Collected from store/);

    // Parcel details sheet (items + timeline).
    doc.querySelector("[data-detail]").click();
    await settle(6);
    assert.match(doc.getElementById("sheetHost").textContent, /Denim jacket/);
    assert.equal(doc.querySelectorAll("#sheetHost img").length, 0);
    doc.querySelector("[data-close]").click();

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

    // Decline with a reason: it leaves the list and returns to dispatch.
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

    // Availability is rider-scoped.
    doc.querySelector('[data-tab="jobs"]').click(); await settle(3);
    doc.querySelector('[data-status="Offline"]').click(); await settle(7);
    assert.ok(f.db.calls.some(c => c.path === "/api/rider/status" && c.body.status === "Offline"));

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

    // Sign out clears the account and device sessions.
    doc.querySelector('[data-tab="profile"]').click(); await settle(3);
    doc.querySelector('[data-profile="demo"]').click(); await settle(8);
    assert.ok(f.db.calls.some(c => c.path === "/api/rider/demo/order"));
    doc.querySelector('[data-profile="signout"]').click(); await settle(6);
    assert.ok(visible(doc, "authScreen"), "signing out returns to sign-in");
    assert.equal(win.localStorage.getItem("adonai.delivery.account.v1"), null);
    assert.equal(win.localStorage.getItem("adonai.delivery.session.v1"), null);
    console.log("✓ sign in, selfie + signature check-in, code link, one-tap accept, decline, deliver with proof, history, consented GPS, sign out");
  } finally { f.close(); }

  /* ---------- the daily check-in gate ---------- */
  const gate = fixture({ url: "https://store.example/delivery#jobs", demo: false, linked: true, checkedIn: true });
  try {
    const doc = gate.doc, win = gate.win;
    await settle(10);
    assert.ok(visible(doc, "appScreen"), "a linked, checked-in rider opens the inbox");
    assert.match(doc.querySelector('[data-progress="AT-1"][data-stage="accepted"]').textContent, /Accept/);

    // The day rolls over on the server while this screen is still open. The
    // server refuses the accept and the app routes the rider to check-in.
    gate.db.attendance = null;
    doc.querySelector('[data-progress="AT-1"][data-stage="accepted"]').click();
    await settle(8);
    assert.ok(gate.db.calls.some(c => c.path.endsWith("/AT-1/progress") && c.body.stage === "accepted"), "the accept was sent");
    assert.ok(visible(doc, "checkinScreen"), "a refused accept opens today's check-in");
    assert.equal(doc.getElementById("checkinBack").hidden, false, "in-app check-in can return to jobs");
    assert.match(doc.getElementById("checkinError").textContent, /Check in for today/);
    assert.equal(gate.db.orders[0].progress.stage, "assigned", "the job is not accepted");

    // Back to jobs: the banner explains the gate and accept routes to check-in.
    doc.getElementById("checkinBack").click(); await settle(4);
    assert.ok(visible(doc, "appScreen"));
    win.dispatchEvent(new win.Event("online"));
    await settle(8);
    assert.match(doc.getElementById("view").textContent, /Check in for today to accept jobs/);
    const blocked = doc.querySelector('[data-progress="AT-1"][data-stage="accepted"]');
    assert.match(blocked.textContent, /Check in to accept/, "accept button explains the gate");
    const before = gate.db.calls.length;
    blocked.click(); await settle(6);
    assert.ok(visible(doc, "checkinScreen"), "tapping accept opens today's check-in");
    assert.ok(!gate.db.calls.slice(before).some(c => c.path.endsWith("/progress")), "no accept call while not checked in");

    // Complete the check-in, return to jobs, and accept with one tap.
    selectFile(win, doc.getElementById("selfieInput"), new win.File(["x"], "me.jpg", { type: "image/jpeg" }));
    await settle(8);
    draw(win, doc.getElementById("signPad"));
    doc.getElementById("checkinConsent").checked = true;
    submit(win, doc.getElementById("checkinForm"));
    await settle(10);
    assert.ok(visible(doc, "appScreen"), "a completed check-in returns the rider to the jobs");
    assert.equal(doc.getElementById("checkinBack").hidden, true);
    assert.equal(doc.querySelector("#checkinScreen .dl-onboard").hidden, true, "in-app check-in hides the setup steps");
    const accepted = doc.querySelector('[data-progress="AT-1"][data-stage="accepted"]');
    assert.match(accepted.textContent, /Accept/);
    accepted.click(); await settle(8);
    assert.equal(gate.db.orders[0].progress.stage, "accepted", "accepting works after check-in");
    console.log("✓ the daily check-in gate blocks accepting until today's selfie and signature are done");
  } finally { gate.close(); }

  /* ---------- demo self-configuration without a query flag ---------- */
  const plain = fixture({ url: "https://store.example/delivery#jobs" });
  try {
    await settle(8);
    assert.equal(plain.doc.getElementById("demoChip").hidden, false, "public capability flag reveals the demo hint");
    assert.equal(plain.doc.getElementById("authPhone").value, "0772555010");
    assert.equal(plain.doc.getElementById("deskDemo").hidden, false);
    assert.ok(plain.db.calls.some(c => c.path === "/api/rider/demo-status"));
    console.log("✓ review-sandbox capability flag sets up the demo sign-in without a query parameter");
  } finally { plain.close(); }

  /* ---------- a new account needs its own check-in, and the device is not shared ---------- */
  const second = fixture({ url: "https://store.example/delivery#jobs", linked: true });
  try {
    const doc = second.doc, win = second.win;
    await settle(8);
    assert.ok(visible(doc, "appScreen"));
    // Sign out of the old account; sign in as someone else. The old phone link must not carry over.
    second.db.account = { id: "RAC-OTHER", name: "Other Rider", phone: "256700111222", password: "other-pass-1", linked: false };
    second.db.attendance = null; // check-in belongs to the previous account, not this one
    doc.querySelector('[data-tab="profile"]').click(); await settle(3);
    doc.querySelector('[data-profile="signout"]').click(); await settle(6);
    assert.ok(visible(doc, "authScreen"));
    doc.getElementById("authPhone").value = "0700 111 222";
    doc.getElementById("authPassword").value = "other-pass-1";
    submit(win, doc.getElementById("authForm"));
    await settle(8);
    assert.ok(visible(doc, "checkinScreen"), "a new rider starts with check-in, not the inbox");
    assert.equal(win.localStorage.getItem("adonai.delivery.session.v1"), null, "no device session survives a sign-out");
    console.log("✓ a new rider cannot inherit a previous rider's device link");
  } finally { second.close(); }

  /* ---------- camera image too big even after compression ---------- */
  const big = fixture({ url: "https://store.example/delivery#jobs" });
  try {
    const doc = big.doc, win = big.win;
    await settle(8);
    submit(win, doc.getElementById("authForm"));
    await settle(8);
    big.stub.bigSelfie = true;
    selectFile(win, doc.getElementById("selfieInput"), new win.File(["x"], "huge.jpg", { type: "image/jpeg" }));
    await settle(10);
    assert.match(doc.getElementById("checkinError").textContent, /too large even when compressed/i, "selfie over 300 KB is refused on the phone");
    assert.equal(doc.getElementById("selfiePreview").hidden, true);
    console.log("✓ selfies are compressed to the 300 KB limit and oversized photos are refused");
  } finally { big.close(); }

  /* ---------- the device session expires cleanly ---------- */
  const expired = fixture({ url: "https://store.example/delivery#jobs", linked: true });
  try {
    expired.db.token = "X".repeat(43);
    expired.win.dispatchEvent(new expired.win.Event("online"));
    await settle(8);
    assert.ok(visible(expired.doc, "connectScreen"), "an expired phone session returns to the connection code step");
    assert.match(expired.doc.getElementById("connectError").textContent, /expired/i);
    assert.ok(visible(expired.doc, "checkinScreen") === false, "the check-in is not asked again for a device expiry");
    console.log("✓ an expired phone link asks only for a fresh App code");
  } finally { expired.close(); }

  /* ---------- offline queue ---------- */
  const off = fixture({ url: "https://store.example/delivery#jobs", linked: true });
  try {
    const doc = off.doc, win = off.win;
    await settle(10);
    assert.ok(visible(doc, "appScreen"));
    off.win.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    doc.querySelector('[data-progress="AT-1"][data-stage="accepted"]').click();
    await settle(8);
    assert.match(doc.getElementById("toastHost").textContent, /saved on this phone/i);
    const queued = JSON.parse(win.localStorage.getItem("adonai.delivery.pending.v1"));
    assert.equal(queued.length, 1, "one progress update is queued offline");
    assert.equal(queued[0].body.stage, "accepted");
    console.log("✓ offline updates are queued on the device instead of being lost");
  } finally { off.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
