#!/usr/bin/env node
/* Bell delivery, read-state, retry, permission and mobile/native regressions.
 * Run: node tests/notifications.test.js
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "js/notifications.js"), "utf8");
const READ_KEY = "adonai.notifications.read-ids.v2";
const tick = () => new Promise(resolve => setImmediate(resolve));
const notification = (id, options = {}) => Object.assign({ id, type: "NEW_ORDER", title: "Checkout recorded", message: "UGX 40,000 · cash", timestamp: 1791660000, area: "orders", protected: false, payload: { order_id: "ORDER-" + id } }, options);

async function fixture(feed = [], options = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="notifBellBtn"><span id="notifBadge" style="display:none"></span></button></body>', {
    runScripts: "outside-only", url: "https://preview.example/pos.html", pretendToBeVisual: true
  });
  const win = dom.window;
  const timers = new Map();
  let timerId = 0;
  win.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  win.clearTimeout = id => timers.delete(id);
  let currentFeed = feed;
  let transport;
  const calls = [];
  let streamCalls = 0;
  win.EventSource = function () { streamCalls++; throw new Error("SSE disabled"); };
  win.Auth = { openAccess: () => true, ready: async () => { throw new Error("open bell must not depend on bootstrap"); }, authHeaders: () => ({}) };
  win.PosAccess = { headers: () => options.areaHeaders || {} };
  win.DB = { apiUrl: value => (options.native ? "https://native-api.example" : "") + value };
  if (options.readIds) win.sessionStorage.setItem(READ_KEY, JSON.stringify(options.readIds));
  win.localStorage.setItem("adonai.notifications.log", JSON.stringify([notification("stale", { message: "Old private customer note" })]));
  win.localStorage.setItem("other-application-data", "keep");
  win.fetch = async (url, request) => {
    calls.push({ url, request });
    if (transport) return transport(url, request);
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify({ ok: true, notifications: currentFeed })) };
  };
  win.eval(SCRIPT);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await tick();
  await win.notificationEngine.inFlight;
  return {
    win, engine: win.notificationEngine, calls, timers, streams: () => streamCalls,
    feed(value) { currentFeed = value; }, transport(value) { transport = value; },
    async runTimer(delay) {
      const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay);
      assert(entry, "expected a scheduled " + delay + "ms timer");
      timers.delete(entry[0]); entry[1].callback(); await tick();
      await win.notificationEngine.inFlight;
    },
    close() { win.notificationEngine.stop(); timers.clear(); win.close(); }
  };
}

async function immediateHistoryWithoutSSE() {
  const f = await fixture([notification("first"), notification("second", { type: "STOCK_ADDED", area: "stock" })]);
  try {
    assert.equal(f.calls.length, 1, "boot fetches history immediately");
    assert.match(f.calls[0].url, /^\/api\/notifications\?limit=100$/);
    assert.equal(f.calls[0].request.cache, "no-store");
    assert.equal(f.calls[0].request.headers.Authorization, undefined, "cashier bell needs no login");
    assert.equal(f.streams(), 0, "a disabled/worker-starved SSE connection cannot silence the bell");
    assert.equal(f.engine.unreadCount, 2);
    assert.equal(f.win.document.querySelector("#notifBadge").textContent, "2");
    assert.equal(f.win.document.querySelector("#notifBadge").style.display, "inline-flex");
    assert.equal(f.win.document.querySelectorAll(".nd-item").length, 2);
    assert.equal(f.win.document.querySelector("#notifFeedStatus").dataset.state, "live");
    assert.equal(f.win.document.querySelectorAll(".toast-card").length, 0, "initial history is not a flood of old toasts");
    assert.equal(f.win.localStorage.getItem("adonai.notifications.log"), null, "legacy shared private history removed");
    assert.equal(f.win.localStorage.getItem("other-application-data"), "keep");
    assert.equal(f.win.sessionStorage.length, 0, "notification payloads are never persisted");
    console.log("✓ bell fetches and displays real history immediately without SSE, JWT or bootstrap");
  } finally { f.close(); }
}

async function pollingReadAndSameSecondEvents() {
  const first = notification("read-first");
  const f = await fixture([first]);
  try {
    const doc = f.win.document;
    doc.querySelector("#notifBellBtn").click();
    await f.engine.inFlight;
    assert.equal(f.engine.drawerOpen(), true);
    assert.equal(f.engine.unreadCount, 0);
    assert.equal(doc.querySelector("#notifBellBtn").getAttribute("aria-expanded"), "true");
    doc.querySelector("#notifDrawerClose").click();
    const second = notification("same-second", { timestamp: first.timestamp });
    f.feed([second, first]);
    await f.runTimer(5000);
    assert.equal(f.engine.unreadCount, 1, "reading an earlier event must not hide a new event in the same second");
    assert.equal(doc.querySelectorAll(".nd-item").length, 2);
    assert.equal(doc.querySelectorAll(".nd-unread").length, 1);
    assert.equal(doc.querySelectorAll(".toast-card").length, 1);
    await f.engine.syncHistory();
    f.engine.handleNotification(second); // duplicate delivery from any adapter
    assert.equal(f.engine.unreadCount, 1);
    assert.equal(doc.querySelectorAll(".toast-card").length, 1);
    assert.equal(doc.querySelectorAll(".nd-item").length, 2);
    const ids = JSON.parse(f.win.sessionStorage.getItem(READ_KEY));
    assert.deepEqual(ids, [first.id]);
    const reloaded = await fixture([second, first], { readIds: ids });
    try { assert.equal(reloaded.engine.unreadCount, 1, "read IDs survive navigation/reload in the same operator tab"); }
    finally { reloaded.close(); }
    console.log("✓ polling updates the badge; same-second events and duplicate delivery preserve correct unread counts");
  } finally { f.close(); }
}

async function checkoutHasPriorityOverItsBasketStockWarnings() {
  const f = await fixture();
  try {
    let chimes = 0;
    f.engine.playChime = () => chimes++;
    const sale = notification("sale-priority", { timestamp: 1791660000 });
    f.feed([1, 2, 3, 4].map(index => notification("stock-warning-" + index, { type: "LOW_STOCK", area: "stock", timestamp: 1791660001 + index })).concat(sale));
    await f.engine.syncHistory();
    assert.equal(f.engine.unreadCount, 5);
    assert.equal(chimes, 1, "checkout must still chime when the basket emits more than three warnings");
    assert.equal(f.win.document.querySelectorAll(".toast-new_order").length, 1);
    assert.equal(f.win.document.querySelectorAll(".toast-card").length, 3, "toast stack stays bounded");
    console.log("✓ checkout alerts take priority over multiple stock warnings from the same basket");
  } finally { f.close(); }
}

async function actionWakeupAndMobileLinks() {
  const f = await fixture();
  try {
    f.feed([notification("local-checkout")]);
    f.win.dispatchEvent(new f.win.CustomEvent("adonai-store-activity", { detail: { path: "/api/orders" } }));
    await f.runTimer(150);
    assert.equal(f.engine.unreadCount, 1);
    assert.equal(f.win.document.querySelector(".nd-item").getAttribute("href"), "admin.html?view=sales");
    assert.equal(f.win.document.querySelector(".toast-view").getAttribute("href"), "admin.html?view=sales");
    f.win.document.querySelector("#notifBellBtn").click();
    await f.engine.inFlight;
    f.feed([notification("stock-intake", { type: "STOCK_ADDED", area: "stock" }), notification("local-checkout")]);
    f.win.document.querySelector("#notifRefresh").click();
    await f.engine.inFlight;
    assert.equal(f.win.document.querySelectorAll(".nd-item").length, 2);
    assert.equal(f.engine.unreadCount, 0, "new items visible in an open drawer are read");
    assert.equal(f.win.document.querySelector('.nd-stock_added').getAttribute("href"), "admin.html?view=inventory");
    console.log("✓ checkout actions wake the bell promptly; drawer refresh and links open the relevant workspaces");
  } finally { f.close(); }
}

async function disconnectRetryAndTimeout() {
  const f = await fixture([notification("cached-in-memory")]);
  try {
    f.transport(async () => { throw new Error("Network disconnected"); });
    assert.equal(await f.engine.syncHistory(), false);
    assert.equal(f.win.document.querySelector("#notifFeedStatus").dataset.state, "offline");
    assert.equal(f.engine.history.length, 1, "a temporary disconnection retains the current tab's received information");
    f.transport(null);
    f.feed([notification("received-after-reconnect"), notification("cached-in-memory")]);
    f.win.dispatchEvent(new f.win.Event("online"));
    await f.runTimer(0);
    assert.equal(f.engine.unreadCount, 2);
    assert.equal(f.win.document.querySelector("#notifFeedStatus").dataset.state, "live");
    f.transport((url, request) => new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new f.win.DOMException("Timed out", "AbortError")));
    }));
    const pending = f.engine.syncHistory();
    await tick();
    await f.runTimer(10000);
    assert.equal(await pending, false);
    assert.equal(f.win.document.querySelector("#notifFeedStatus").dataset.state, "offline");
    assert(Array.from(f.timers.values()).some(timer => timer.delay === 5000), "timeout schedules automatic recovery");
    console.log("✓ failures are visible, online/manual retries recover, and a hanging request cannot stall the feed forever");
  } finally { f.close(); }
}

async function permissionRedactionAndSlowResponse() {
  const secret = notification("private", { title: "Private customer name", message: "Private order note", payload: { customer: "Private customer name" } });
  const locked = notification("private", { title: "Checkout recorded", message: "Unlock Orders to view details.", payload: {}, protected: true });
  const f = await fixture([secret]);
  try {
    const doc = f.win.document;
    f.engine.renderToast(secret);
    assert(doc.querySelector("#notifDrawerList").textContent.includes("Private order note"));
    let resolveSlow;
    f.transport(() => new Promise(resolve => { resolveSlow = resolve; }));
    const slow = f.engine.syncHistory();
    await tick();
    f.win.dispatchEvent(new f.win.CustomEvent("pos-access-change"));
    assert(!doc.querySelector("#notifDrawerList").textContent.includes("Private order note"));
    assert.equal(doc.querySelectorAll(".toast-card").length, 0, "relocking also removes private toasts");
    resolveSlow({ ok: true, status: 200, json: async () => ({ ok: true, notifications: [secret] }) });
    await slow;
    assert.equal(f.engine.history.length, 0, "a late privileged response cannot undo a lock");
    f.transport(null); f.feed([locked]);
    await f.runTimer(0);
    assert.equal(f.engine.unreadCount, 1, "locked areas still provide safe checkout activity alerts");
    assert(!doc.querySelector("#notifDrawerList").textContent.includes("Private order note"));
    assert(doc.querySelector("#notifDrawerList").textContent.includes("Details protected"));
    f.feed([secret]);
    await f.engine.syncHistory();
    assert(doc.querySelector("#notifDrawerList").textContent.includes("Private order note"), "unlock updates the same notification's details");
    assert.equal(doc.querySelectorAll(".nd-item").length, 1);
    assert.equal(doc.querySelectorAll(".toast-card").length, 0, "an access change is not a duplicate business event");
    assert.equal(f.win.localStorage.getItem("adonai.notifications.log"), null);
    assert.equal(f.win.sessionStorage.getItem(READ_KEY), null);
    console.log("✓ relocking clears private details; late responses are discarded; safe summaries remain without duplicates");
  } finally { f.close(); }
}

async function nativeHeadersAndUntrustedContent() {
  const f = await fixture([notification("escaped", { title: '<img src=x onerror="alert(1)">', message: '<script>alert(2)</script>' })], { native: true, areaHeaders: { "X-Pos-Access": "opaque-session" } });
  try {
    assert.equal(f.calls[0].url, "https://native-api.example/api/notifications?limit=100");
    assert.equal(f.calls[0].request.headers["X-Pos-Access"], "opaque-session");
    assert.equal(f.win.document.querySelectorAll("#notifDrawerList img, #notifDrawerList script").length, 0);
    assert(f.win.document.querySelector("#notifDrawerList").textContent.includes("<script>"));
    assert.equal(f.calls[0].url.includes("opaque-session"), false);
    f.transport(async () => ({ ok: false, status: 401 }));
    await f.engine.syncHistory();
    assert.equal(f.engine.history.length, 0);
    assert.equal(f.engine.unreadCount, 0);
    assert.match(f.win.document.querySelector("#notifFeedStatus").textContent, /Sign in/);
    console.log("✓ native URLs and area headers work; notification text is escaped and authorization failures clear history");
  } finally { f.close(); }
}

async function fullSyncBroadcastReachesProductAndSalesSubscribers() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: "outside-only", url: "https://preview.example/pos.html" });
  const win = dom.window;
  try {
    win.Auth = { openAccess: () => true, ready: async () => {}, authHeaders: () => ({}) };
    win.fetch = async url => ({ ok: true, status: 200, json: async () => url.includes("/sync/pull")
      ? { products: [], sales: [], ledger: [], settings: {} }
      : { settings: {} } });
    win.eval(fs.readFileSync(path.join(ROOT, "js/db.js"), "utf8"));
    let productUpdates = 0, saleUpdates = 0;
    win.DB.on("products", () => productUpdates++);
    win.DB.on("sales", () => saleUpdates++);
    await win.DB.refreshOperationalData();
    assert(productUpdates >= 1, "a full operational sync must repaint the register's product subscriber");
    assert(saleUpdates >= 1, "a full operational sync must notify sales subscribers as well as wildcard subscribers");
    console.log("✓ full-state refreshes reach register/checkout subscribers, not only wildcard navigation handlers");
  } finally { win.close(); }
}

async function successfulStoreActionsWakeTheBellButFailuresDoNot() {
  const events = [];
  let status = 200;
  const context = {
    console,
    Auth: { openAccess: () => true, authHeaders: () => ({}) },
    CustomEvent: function (type, options) { this.type = type; this.detail = options.detail; },
    dispatchEvent: event => events.push(event),
    fetch: async () => ({ ok: status === 200, status, json: async () => status === 200
      ? { ok: true, settings: { store_name: "Published store" }, products_updated: 0 }
      : { ok: false, error: "Save failed" } })
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/db.js"), "utf8"), context);
  await context.DB.syncStoreSettings({ store_name: "Published store" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "adonai-store-activity");
  assert.equal(events[0].detail.path, "/api/settings");
  status = 400;
  await assert.rejects(context.DB.syncStoreSettings({ store_name: "Not saved" }), /Save failed/);
  assert.equal(events.length, 1, "a rejected save must not wake the bell as a successful action");
  console.log("✓ real store API calls wake the bell only after successful server responses");
}

(async () => {
  await immediateHistoryWithoutSSE();
  await pollingReadAndSameSecondEvents();
  await actionWakeupAndMobileLinks();
  await checkoutHasPriorityOverItsBasketStockWarnings();
  await disconnectRetryAndTimeout();
  await permissionRedactionAndSlowResponse();
  await nativeHeadersAndUntrustedContent();
  await successfulStoreActionsWakeTheBellButFailuresDoNot();
  await fullSyncBroadcastReachesProductAndSalesSubscribers();
})().catch(error => { console.error(error); process.exitCode = 1; });
