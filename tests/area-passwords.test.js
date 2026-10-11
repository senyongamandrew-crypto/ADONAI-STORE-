#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(ROOT, "js/pos-access.js"), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const TOKEN = "A".repeat(43);
const PASSWORD = "Test-Area-Password-369!";
function makeWindow(protectedArea = false) {
  const dom = new JSDOM('<!doctype html><body><div id="toast"></div></body>', { runScripts: "outside-only", url: "https://preview.example/admin.html?view=payments", pretendToBeVisual: true });
  const win = dom.window;
  let unlocked = false, revoked = false, unlockCalls = 0;
  const areas = [
    { id: "finance", label: "Finance & sales analytics", views: ["overview", "payments"] },
    { id: "stock", label: "Stock management & intake", views: ["inventory", "intake"] },
    { id: "orders", label: "Orders, dispatch & audit", views: ["sales", "customers", "dispatch"] },
    { id: "settings", label: "Store settings", views: ["settings"] }
  ];
  win.DB = { apiUrl: value => value, refreshOperationalData: () => Promise.resolve(true) };
  win.Auth = { authHeaders: () => ({}) };
  win.fetch = async (url, options) => {
    let data, status = 200;
    if (url.endsWith('/policy')) {
      const granted = unlocked && !revoked && options.headers['X-Pos-Access'] === TOKEN;
      data = { ok: true, admin_configured: protectedArea, admin_unlocked: false, protected_areas: protectedArea ? ['finance', 'stock'] : [], session_seconds: 1800,
        areas: areas.map(area => ({ ...area, protected: protectedArea && ['finance', 'stock'].includes(area.id), unlocked: !protectedArea || (area.id === 'finance' && granted) || !['finance', 'stock'].includes(area.id), password_count: 1 })) };
    } else if (url.endsWith('/unlock')) {
      unlockCalls++;
      const body = JSON.parse(options.body);
      if (body.password !== PASSWORD || body.area !== 'finance') { status = 403; data = { ok: false, error: 'Incorrect password for this area. Try again.' }; }
      else { unlocked = true; revoked = false; data = { ok: true, session: { token: TOKEN, key_id: 'fixture-key', key_name: 'Accounts', is_admin: false, areas: ['finance'], expires_at: new Date(Date.now() + 1800000).toISOString() } }; }
    } else if (url.endsWith('/lock')) { revoked = true; data = { ok: true }; }
    else throw new Error('Unexpected request ' + url);
    return { ok: status === 200, status, json: async () => data };
  };
  win.eval(script);
  return { win, calls: () => unlockCalls };
}
(async () => {
  let fixture = makeWindow(false);
  try {
    assert.equal(await fixture.win.PosAccess.ensure('finance'), true);
    assert.equal(fixture.win.document.querySelector('.pos-access-overlay'), null);
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.win.PosAccess.areaForView('pos'), null, 'checkout is never a protectable area');
    console.log('✓ unconfigured passwords do not prompt or lock checkout');
  } finally { fixture.win.close(); }
  fixture = makeWindow(true);
  const { win } = fixture;
  try {
    const access = win.PosAccess.ensure('finance');
    await tick();
    const input = win.document.querySelector('#areaPassword');
    assert(input, 'a protected area should ask for the admin-configured password');
    input.value = 'Wrong-Password-123!';
    win.document.querySelector('#areaPasswordForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.match(win.document.querySelector('#areaPasswordError').textContent, /Incorrect/);
    input.value = PASSWORD;
    win.document.querySelector('#areaPasswordForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(await access, true);
    assert.equal(win.document.querySelector('.pos-access-overlay'), null);
    assert.equal(win.PosAccess.headers()['X-Pos-Access'], TOKEN);
    assert.equal(win.PosAccess.canUse('finance'), true);
    assert.equal(win.PosAccess.canUse('stock'), false, 'a finance password cannot unlock stock');
    assert.equal(win.localStorage.length, 0, 'area sessions are not shared across browser tabs');
    assert.equal(win.sessionStorage.getItem('adonai-area-sessions-v1').includes(PASSWORD), false, 'password text is never persisted');
    console.log('✓ wrong passwords stay inline; correct passwords grant only assigned areas');
    const stock = win.PosAccess.ensure('stock');
    await tick();
    win.document.querySelector('[data-pa-cancel]').click();
    assert.equal(await stock, false);
    await win.PosAccess.lock();
    assert.equal(win.PosAccess.canUse('finance'), false);
    assert.equal(win.sessionStorage.getItem('adonai-area-sessions-v1'), null);
    console.log('✓ cancelling does not grant access; relocking revokes the server session');
  } finally { win.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
