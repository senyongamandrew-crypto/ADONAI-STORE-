#!/usr/bin/env node
/* PIN-free terminal regressions: bootstrap, stale locks, settings publishing,
 * offline reconnect and optional server-side credential protection.
 * Run: node tests/terminal-access.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..");
const authScript = fs.readFileSync(path.join(ROOT, "js/auth.js"), "utf8");
const TOKEN = "test.signed.session";
const openSession = () => ({
  ok: true,
  requires_staff_auth: false,
  access_mode: "open",
  token: TOKEN,
  staff: { id: "OPEN-TERMINAL", name: "Store Terminal", role: "admin" }
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = data => ({ ok: true, json: async () => data });

function authWindow() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    url: "https://preview.example/admin.html?view=settings"
  });
  const win = dom.window;
  win.DB = { getSettings: () => ({ access_locked: true }), apiUrl: value => value };
  return win;
}

async function bootstrapIgnoresStaleLock() {
  const win = authWindow();
  try {
    win.localStorage.setItem("adonai-terminal-access-mode", "credential");
    win.localStorage.setItem("adonai-session-v2", JSON.stringify({
      id: "OLD-CASHIER", name: "Old Cashier", role: "cashier", token: "bad-old-token"
    }));
    win.localStorage.setItem("unrelated-data", "untouched");
    let requests = 0;
    win.fetch = async (url, options) => {
      requests++;
      assert.equal(url, "/api/auth/terminal-session", "browser bootstrap uses the same origin");
      assert.equal(options.method, "POST");
      assert.equal(options.body, "{}", "no PIN/key is sent or embedded");
      return response(openSession());
    };
    win.eval(authScript);
    await Promise.all([win.Auth.ready(), win.Auth.ready(), win.Auth.ready()]);
    assert.equal(requests, 1, "concurrent consumers share one handshake");
    assert.equal(win.Auth.locked(), false, "a stale browser PIN lock cannot overrule the server");
    assert.equal(win.Auth.suiteUnlocked(), true);
    assert.equal(win.Auth.guard().id, "OPEN-TERMINAL");
    assert.equal(win.Auth.me().access_mode, "open");
    assert.deepEqual(Object.keys(win.Auth.authHeaders()), [], "PIN-free requests omit stale or optional JWT headers");
    assert.equal(win.localStorage.getItem("unrelated-data"), "untouched");
    assert.equal(win.location.search, "?view=settings", "the settings destination is preserved");
    win.Auth.signOut();
    assert.equal(win.Auth.locked(), false, "sign-out cannot recreate a PIN wall in PIN-free mode");
    console.log("✓ PIN-free access ignores stale credentials without resetting data or routes");
  } finally { win.close(); }
}

async function optionalProtectionClearsOpenSession() {
  const win = authWindow();
  try {
    win.DB.getSettings = () => ({ access_locked: false });
    win.localStorage.setItem("adonai-session-v2", JSON.stringify({
      id: "OPEN-TERMINAL", name: "Store Terminal", role: "admin", token: TOKEN, access_mode: "open"
    }));
    win.localStorage.setItem("adonai-terminal-token", TOKEN);
    win.sessionStorage.setItem("adonai-suite-unlocked", "1");
    win.sessionStorage.setItem("adonai-master-2026", "1");
    win.fetch = async () => response({ ok: true, requires_staff_auth: true, access_mode: "credential" });
    win.eval(authScript);
    await win.Auth.ready();
    assert.equal(win.Auth.locked(), true, "only an explicit server opt-in restores credential protection");
    assert.equal(win.Auth.me(), null, "cached PIN-free identity is revoked");
    assert.equal(win.Auth.token(), "");
    assert.equal(win.Auth.suiteUnlocked(), false);
    assert.equal(win.sessionStorage.getItem("adonai-master-2026"), null);
    assert.equal(win.sessionStorage.getItem("adonai-suite-unlocked"), null);
    assert.equal(win.localStorage.getItem("adonai-terminal-access-mode"), "credential");
    win.Auth.signIn({ id: "ADMIN", name: "Admin", role: "admin", token: TOKEN });
    assert.equal(win.Auth.authHeaders().Authorization, "Bearer " + TOKEN, "opt-in protection still sends verified credentials");
    console.log("✓ optional protection clears PIN-free tokens and stale local unlock flags");
  } finally { win.close(); }
}

async function offlineBootstrapRetriesWithoutFakeCredential() {
  const win = authWindow();
  try {
    let requests = 0;
    win.fetch = async () => {
      requests++;
      if (requests === 1) throw new Error("offline");
      return response(openSession());
    };
    win.eval(authScript);
    await win.Auth.ready();
    assert.equal(win.Auth.locked(), false);
    assert.equal(win.Auth.token(), "", "offline navigation must not fabricate an API credential");
    await win.Auth.ready();
    assert.equal(requests, 2, "failed bootstraps can reconnect on a subsequent request");
    assert.equal(win.Auth.token(), TOKEN);
    win.Auth.signIn({ id: "LOCAL-STAFF", name: "Staff", role: "cashier" });
    assert.equal(win.Auth.token(), "", "signing in without a token must not inherit an old admin token");
    console.log("✓ offline bootstrap reconnects without fabricating or inheriting credentials");
  } finally { win.close(); }
}

async function nativeBootstrapUsesApiResolver() {
  const win = authWindow();
  try {
    win.DB.apiUrl = value => "https://native-api.example" + value;
    let endpoint = "";
    win.fetch = async url => { endpoint = url; return response(openSession()); };
    win.eval(authScript);
    await win.Auth.ready();
    assert.equal(endpoint, "https://native-api.example/api/auth/terminal-session");
    assert.equal(win.Auth.me().id, "OPEN-TERMINAL");
    console.log("✓ native terminals bootstrap against the configured API instead of localhost");
  } finally { win.close(); }
}

async function tokenlessTerminalDoesNotRequireJwt() {
  const win = authWindow();
  try {
    win.fetch = async () => {
      const session = openSession();
      delete session.token;
      return response(session);
    };
    win.eval(authScript);
    await win.Auth.ready();
    assert.equal(win.Auth.locked(), false);
    assert.equal(win.Auth.me().id, "OPEN-TERMINAL");
    assert.equal(win.Auth.token(), "");
    assert.deepEqual(Object.keys(win.Auth.authHeaders()), []);
    console.log("✓ PIN-free terminals accept a tokenless handshake without recreating the lock");
  } finally { win.close(); }
}

async function directSettingsSaveNeedsNeitherBootstrapNorAuthHeaders() {
  let saves = 0;
  const context = {
    console,
    Auth: {
      openAccess: () => true,
      ready: async () => { throw new Error("PIN-free saves must not need session bootstrap"); },
      authHeaders: () => { throw new Error("PIN-free saves must not send stale credentials"); }
    },
    fetch: async (url, options) => {
      assert.equal(url, "/api/settings");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers["X-Terminal-Key"], undefined);
      assert.equal(options.headers["Content-Type"], "application/json");
      const body = JSON.parse(options.body);
      assert.equal(body.settings.store_name, "Saved without a session");
      assert.equal(body.apply_base_fee_to_catalog, true);
      saves++;
      return response({ ok: true, settings: body.settings, products_updated: 0 });
    }
  };
  // No window means no background polling; exercise the real DB save method.
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/db.js"), "utf8"), context);
  const saved = await context.DB.syncStoreSettings({ store_name: "Saved without a session" }, "old.cashier.token", { applyBaseFeeToCatalog: true });
  assert.equal(saves, 1);
  assert.equal(saved.store_name, "Saved without a session");
  assert.equal(context.DB.getSettings().store_name, "Saved without a session");
  console.log("✓ real settings publishing ignores stale keys and does not depend on JWT/bootstrap");
}

async function settingsOpenAndSaveWithoutPrompts() {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "admin.html"), "utf8"), {
    runScripts: "outside-only",
    url: "https://preview.example/admin.html?view=settings",
    pretendToBeVisual: true
  });
  const win = dom.window;
  try {
    let onSync = null;
    let published = null;
    let bootstrapRequests = 0;
    const settings = { store_name: "Adonai Store", base_delivery_fee: 0, access_locked: true };
    win.DB = {
      DEMOGRAPHICS: ["Men", "Women", "Children", "Unisex"],
      CATEGORIES: ["Shoes"],
      CONDITIONS: ["Grade A — Excellent"],
      ROLE_LABELS: {},
      ugx: value => `UGX ${value}`,
      barcodeSVG: () => "",
      apiUrl: value => value,
      getSettings: () => ({ ...settings }),
      listProducts: () => [], listSales: () => [], listStaff: () => [],
      listRiders: () => [], listLedger: () => [], listGuests: () => [],
      on: (_table, callback) => { onSync = callback; },
      financeRequest: async () => ({ stock_lots: [] }),
      syncStoreSettings: async (patch, credential) => {
        assert.equal(credential, "", "PIN-free publishing does not require the automatically issued JWT");
        published = { ...patch };
        Object.assign(settings, patch);
        return { ...settings };
      }
    };
    win.Icons = { svg: () => "", icon: () => "" };
    win.Intake = { compressImage: async () => "", imageFieldHTML: () => "" };
    win.fetch = async url => {
      assert.equal(url, "/api/auth/terminal-session", "settings must never request PIN verification");
      bootstrapRequests++;
      return response(openSession());
    };
    win.HTMLCanvasElement.prototype.getContext = () => ({
      scale() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}
    });
    win.eval(authScript);
    win.eval(fs.readFileSync(path.join(ROOT, "js/garment-media.js"), "utf8"));
    win.eval(fs.readFileSync(path.join(ROOT, "js/audit-exports.js"), "utf8"));
    win.eval(fs.readFileSync(path.join(ROOT, "js/receipt-printing.js"), "utf8"));
    win.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
    await tick();
    const doc = win.document;
    assert.equal(doc.querySelector("#view-settings").classList.contains("active"), true);
    assert.equal(doc.querySelector("#suiteGate").hidden, true);
    assert.equal(doc.body.classList.contains("suite-locked"), false);
    assert.equal(doc.querySelector("#unlockChip").hidden, true);
    assert.equal(doc.querySelector("#openAccessChip").hidden, false);
    assert.equal(doc.querySelector("#setKey").closest("[data-credential-control]").hidden, true);
    assert.equal(doc.querySelector("#lockToggle"), null, "the obsolete browser PIN lock toggle is removed");
    assert.equal(doc.querySelector("#setFee").value, "0", "free delivery must not become UGX 7,000");

    const name = doc.querySelector("#setName");
    name.value = "Updated Store Name";
    name.dispatchEvent(new win.Event("input", { bubbles: true }));
    onSync("*");
    assert.equal(name.value, "Updated Store Name", "background sync must preserve unfinished settings edits");
    doc.querySelector("#setKey").value = "must-not-rotate-in-pin-free-mode";
    doc.querySelector("#btnSaveCfg").click();
    await tick();
    assert.equal(published.store_name, "Updated Store Name");
    assert.equal(published.master_key, undefined, "PIN-free publishing never rotates a hidden credential");
    assert.equal(doc.querySelector("#modalBackdrop").classList.contains("open"), false);
    assert.equal(doc.querySelector("#btnSaveCfg").disabled, false);
    assert.equal(bootstrapRequests, 1);
    assert.equal(win.location.search, "?view=settings");
    console.log("✓ settings open and publish without PIN prompts, preserving edits during sync");
  } finally { win.close(); }
}

(async () => {
  await bootstrapIgnoresStaleLock();
  await optionalProtectionClearsOpenSession();
  await offlineBootstrapRetriesWithoutFakeCredential();
  await nativeBootstrapUsesApiResolver();
  await tokenlessTerminalDoesNotRequireJwt();
  await directSettingsSaveNeedsNeitherBootstrapNorAuthHeaders();
  await settingsOpenAndSaveWithoutPrompts();
})().catch(error => { console.error(error); process.exitCode = 1; });
