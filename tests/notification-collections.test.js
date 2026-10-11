#!/usr/bin/env node
/* Bell clean-up: one list, per-message selection, delete selected / read / all, bounded storage.
 * Run: node tests/notification-collections.test.js
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "js/notifications.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const note = (id, title) => ({ id, type: "NEW_ORDER", title, message: "UGX 1,000", timestamp: 1791660000 + Number(id.replace(/\D/g, "") || 0), area: "orders", protected: false });
const DELETED_KEY = "adonai.notifications.deleted.v1", HOLD_KEY = "adonai.notifications.hold.v1";

async function fixture(feed, storage = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="notifBellBtn"><span id="notifBadge" style="display:none"></span></button></body>', {
    runScripts: "outside-only", url: "https://preview.example/pos.html", pretendToBeVisual: true });
  const win = dom.window;
  win.EventSource = function () { throw new Error("SSE disabled"); };
  win.Auth = { authHeaders: () => ({}) };
  win.PosAccess = { headers: () => ({}) };
  win.DB = { apiUrl: value => value };
  win.confirm = () => true;
  Object.entries(storage).forEach(([k, v]) => win.localStorage.setItem(k, JSON.stringify(v)));
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, notifications: feed }) });
  win.eval(SCRIPT);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await tick(); await tick();
  const mgr = win.notificationEngine;
  return { win, doc: win.document, mgr, close: () => { mgr.stop(); win.close(); } };
}
const rowIds = doc => Array.from(doc.querySelectorAll("#notifDrawerList [data-notification-id]")).map(n => n.dataset.notificationId);
const btn = (doc, selector) => doc.querySelector(selector);
const check = (doc, id) => doc.querySelector(`[data-nd-check="${id}"]`);
function select(f, id, on = true) { const box = check(f.doc, id); box.checked = on; box.dispatchEvent(new f.win.Event("change", { bubbles: true })); }
function click(f, el) { el.dispatchEvent(new f.win.MouseEvent("click", { bubbles: true, cancelable: true })); }

(async () => {
  const feed = [note("n1", "First sale"), note("n2", "Second sale"), note("n3", "Third sale")];
  const f = await fixture(feed, { [HOLD_KEY]: ["n1"] });
  try {
    f.mgr.toggleDrawer(true); await tick();
    assert.equal(f.doc.querySelectorAll(".nd-tab").length, 0, "no Received / On hold split");
    assert.deepEqual(rowIds(f.doc), ["n3", "n2", "n1"], "one list, newest first");
    assert.equal(f.doc.querySelectorAll(".nd-row input[type=checkbox][data-nd-check]").length, 3, "each message has its own selection box");
    assert.equal(btn(f.doc, '[data-nd-action="delete"]').disabled, true, "delete is disabled until something is selected");
    assert.equal(f.win.localStorage.getItem(HOLD_KEY), null, "retired hold list is removed");

    // Select two older messages and delete just them
    select(f, "n2"); select(f, "n1");
    assert.equal(btn(f.doc, '[data-nd-action="delete"]').textContent, "Delete selected (2)");
    click(f, btn(f.doc, '[data-nd-action="delete"]'));
    assert.deepEqual(rowIds(f.doc), ["n3"], "only the selected messages were removed");
    assert.deepEqual(JSON.parse(f.win.localStorage.getItem(DELETED_KEY)).sort(), ["n1", "n2"]);

    // Deleted messages stay gone when the server repeats them
    await f.mgr.syncHistory(); await tick();
    assert.deepEqual(rowIds(f.doc), ["n3"]);

    // Select all, then toggle off
    click(f, btn(f.doc, '[data-nd-action="select-all"]'));
    assert.equal(f.mgr.selected.size, 1);
    click(f, btn(f.doc, '[data-nd-action="select-all"]'));
    assert.equal(f.mgr.selected.size, 0);
  } finally { f.close(); }

  // Delete read messages; unread count only counts what remains
  const g = await fixture([note("a1", "A"), note("a2", "B"), note("a3", "C")], { [DELETED_KEY]: ["zz-old"] });
  try {
    g.mgr.toggleDrawer(true); await tick();
    assert.deepEqual(rowIds(g.doc), ["a3", "a2", "a1"]);
    g.mgr.readIds.delete("a2");
    g.mgr.renderDrawerList();
    assert.match(btn(g.doc, '[data-nd-action="clear-read"]').textContent, /Delete read \(2\)/);
    click(g, btn(g.doc, '[data-nd-action="clear-read"]'));
    assert.deepEqual(rowIds(g.doc), ["a2"], "only the unread message remains");
    assert.equal(g.mgr.unreadCount, 1);
    click(g, btn(g.doc, '[data-nd-action="clear-all"]'));
    assert.deepEqual(rowIds(g.doc), []);
    assert.match(g.doc.querySelector("#notifDrawerList").textContent, /All notifications on this device are deleted/);
  } finally { g.close(); }

  // Local storage stays bounded
  const many = Array.from({ length: 5 }, (_, i) => note("m" + i, "M" + i));
  const h = await fixture(many, { [DELETED_KEY]: Array.from({ length: 400 }, (_, i) => "old" + i) });
  try {
    assert.equal(h.mgr.deletedIds.size, 300);
    assert.equal(JSON.parse(h.win.localStorage.getItem(DELETED_KEY)).length, 300);
  } finally { h.close(); }
  console.log("✓ one bell list with per-message selection, delete selected / read / all, bounded storage, no Received/On hold split");
})().catch(error => { console.error(error); process.exitCode = 1; });
