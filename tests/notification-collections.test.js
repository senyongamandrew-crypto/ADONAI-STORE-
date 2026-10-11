#!/usr/bin/env node
/* Bell collections: Received / On hold, selection, bulk actions and storage limits.
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
const HOLD_KEY = "adonai.notifications.hold.v1", DELETED_KEY = "adonai.notifications.deleted.v1";

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
const tabText = doc => Array.from(doc.querySelectorAll(".nd-tab")).map(t => t.textContent);
const check = (doc, id) => doc.querySelector(`[data-nd-check="${id}"]`);
function select(f, id, on = true) { const box = check(f.doc, id); box.checked = on; box.dispatchEvent(new f.win.Event("change", { bubbles: true })); }
function click(f, el) { el.dispatchEvent(new f.win.MouseEvent("click", { bubbles: true, cancelable: true })); }

(async () => {
  const feed = [note("n1", "First sale"), note("n2", "Second sale"), note("n3", "Third sale")];
  const f = await fixture(feed);
  try {
    f.mgr.toggleDrawer(true); await tick();
    assert.deepEqual(tabText(f.doc).map(t => t.replace(/\s+/g, " ").trim()), ["Received (3)", "On hold (0)"]);
    assert.deepEqual(rowIds(f.doc), ["n3", "n2", "n1"]);
    assert.equal(f.doc.querySelectorAll(".nd-row input[type=checkbox]").length, 3, "every message has a selection box");
    assert.equal(btn(f.doc, '[data-nd-action="hold"]').disabled, true, "hold is disabled until something is selected");

    // 1. Select two Received messages and put them on hold
    select(f, "n3"); select(f, "n1");
    assert.equal(btn(f.doc, '[data-nd-action="hold"]').textContent, "Put on hold (2)");
    click(f, btn(f.doc, '[data-nd-action="hold"]'));
    assert.deepEqual(rowIds(f.doc), ["n2"], "held items leave Received");
    assert.match(tabText(f.doc).join("|"), /On hold \(2\)/);
    assert.deepEqual(JSON.parse(f.win.localStorage.getItem(HOLD_KEY)).sort(), ["n1", "n3"]);

    // 2. Switch to On hold: selection resets, held items shown; restore one
    click(f, btn(f.doc, '[data-nd-tab="hold"]'));
    assert.deepEqual(rowIds(f.doc), ["n3", "n1"]);
    select(f, "n1");
    click(f, btn(f.doc, '[data-nd-action="restore"]'));
    assert.deepEqual(rowIds(f.doc), ["n3"], "restored message left On hold");
    assert.deepEqual(f.mgr.holdIds.has("n1"), false);
    click(f, btn(f.doc, '[data-nd-tab="received"]'));
    assert.deepEqual(rowIds(f.doc), ["n2", "n1"], "restored message is back in Received");

    // 3. Delete a held message from On hold
    click(f, btn(f.doc, '[data-nd-tab="hold"]'));
    select(f, "n3");
    click(f, btn(f.doc, '[data-nd-action="delete"]'));
    assert.deepEqual(rowIds(f.doc), []);
    assert.equal(JSON.parse(f.win.localStorage.getItem(DELETED_KEY)).includes("n3"), true);

    // 4. Select all in Received, delete; a server refresh that repeats them must not bring them back
    click(f, btn(f.doc, '[data-nd-tab="received"]'));
    click(f, btn(f.doc, '[data-nd-action="select-all"]'));
    assert.equal(f.mgr.selected.size, 2, "select-all picks the visible Received rows");
    assert.equal(btn(f.doc, '[data-nd-action="delete"]').textContent.trim(), "Delete (2)");
    click(f, btn(f.doc, '[data-nd-action="delete"]'));
    await f.mgr.syncHistory(); await tick();
    assert.deepEqual(rowIds(f.doc), [], "deleted messages do not return when the server feed repeats them");
    assert.match(f.doc.querySelector("#notifDrawerList").textContent, /Everything here is on hold or deleted/);
  } finally { f.close(); }

  // Unread count and "Delete read" only consider Received items; deleted/held ones never count.
  const g = await fixture([note("a1", "A"), note("a2", "B"), note("a3", "C")], { [HOLD_KEY]: ["a1", "zz-old"], [DELETED_KEY]: ["a3"] });
  try {
    assert.equal(g.mgr.unreadCount, 1, "only a2 is unread in Received");
    g.mgr.toggleDrawer(true); await tick();
    assert.deepEqual(rowIds(g.doc), ["a2"]);
    assert.match(g.doc.querySelector('[data-nd-action="clear-read"]').textContent, /Delete read \(1\)/);
    click(g, g.doc.querySelector('[data-nd-action="clear-read"]'));
    assert.deepEqual(rowIds(g.doc), [], "read Received items are removed from this device");
    assert.equal(JSON.parse(g.win.localStorage.getItem(DELETED_KEY)).includes("a2"), true);
    assert.deepEqual(rowIds(g.doc), []);
    // Held-but-no-longer-in-server-window items are explained, never silently shown
    click(g, btn(g.doc, '[data-nd-tab="hold"]'));
    assert.deepEqual(rowIds(g.doc), ["a1"], "held message still in the feed is shown");
    assert.match(g.doc.querySelector("#notifDrawerList").textContent, /1 held message is older than the latest 100 alerts/);
  } finally { g.close(); }

  // Storage stays bounded: collections keep only the newest IDs.
  const many = Array.from({ length: 5 }, (_, i) => note("m" + i, "M" + i));
  const h = await fixture(many, { [DELETED_KEY]: Array.from({ length: 400 }, (_, i) => "old" + i) });
  try {
    assert.equal(h.mgr.deletedIds.size, 300, "deleted list is capped at 300 IDs");
    assert.equal(JSON.parse(h.win.localStorage.getItem(DELETED_KEY)).length, 300);
  } finally { h.close(); }
  console.log("✓ Received and On hold collections, per-item selection, select-all, hold/restore/delete, bounded local storage, honest old-hold note");
})().catch(error => { console.error(error); process.exitCode = 1; });
