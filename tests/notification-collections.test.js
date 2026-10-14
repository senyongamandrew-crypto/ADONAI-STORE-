#!/usr/bin/env node
/* Bell inbox polish: per-notification overflow actions replace selection boxes.
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
  Object.entries(storage).forEach(([key, value]) => win.localStorage.setItem(key, JSON.stringify(value)));
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, notifications: feed }) });
  win.eval(SCRIPT);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await tick(); await tick();
  const manager = win.notificationEngine;
  return { win, doc: win.document, manager, close: () => { manager.stop(); win.close(); } };
}
const rows = doc => Array.from(doc.querySelectorAll("#notifDrawerList .nd-row"));
const rowIds = doc => rows(doc).map(row => row.dataset.notificationRow);
const click = (f, element) => {
  assert(element, "expected the target element to exist");
  element.dispatchEvent(new f.win.MouseEvent("click", { bubbles: true, cancelable: true }));
};
const rowFor = (f, id) => rows(f.doc).find(row => row.dataset.notificationRow === id);
function openMenu(f, id) {
  const row = rowFor(f, id);
  click(f, row && row.querySelector("[data-nd-menu-toggle]"));
  return { row, menu: row && row.querySelector(".nd-menu") };
}

(async () => {
  const feed = [note("n1", "First sale"), note("n2", "Second sale"), note("n3", "Third sale")];
  const f = await fixture(feed, { [HOLD_KEY]: ["n1"] });
  try {
    f.manager.toggleDrawer(true); await tick();
    assert.equal(f.doc.querySelectorAll(".nd-tab").length, 0, "one inbox, no Received / On hold split");
    assert.deepEqual(rowIds(f.doc), ["n3", "n2", "n1"], "one list, newest first");
    assert.equal(f.doc.querySelectorAll("#notifDrawerList input[type=checkbox]").length, 0, "no selection checkboxes in the notification list");
    assert.equal(f.doc.querySelector("#notifToolbar"), null, "no bulk-selection toolbar");
    assert.equal(f.doc.querySelectorAll(".nd-row [data-nd-menu-toggle]").length, 3, "every row has its own overflow menu");
    assert.equal(f.manager.unreadCount, 3, "opening the inbox does not implicitly read notifications");
    assert.equal(f.win.localStorage.getItem(HOLD_KEY), null, "retired hold list is removed");

    // A row's three-dot menu can mark that message read or unread independently.
    let opened = openMenu(f, "n2");
    assert.equal(opened.menu.hidden, false);
    assert.equal(opened.row.querySelector("[data-nd-menu-toggle]").getAttribute("aria-haspopup"), "menu");
    assert.equal(opened.menu.querySelectorAll("[role=menuitem]").length, 2);
    assert.equal(opened.menu.querySelector('[data-nd-menu-action="toggle-read"]').textContent, "Mark as read");
    click(f, opened.menu.querySelector('[data-nd-menu-action="toggle-read"]'));
    assert.equal(f.manager.unreadCount, 2);
    assert.equal(rowFor(f, "n2").classList.contains("nd-unread"), false);
    assert.deepEqual(JSON.parse(f.win.sessionStorage.getItem("adonai.notifications.read-ids.v2")), ["n2"]);

    opened = openMenu(f, "n2");
    assert.equal(opened.menu.querySelector('[data-nd-menu-action="toggle-read"]').textContent, "Mark as unread");
    click(f, opened.menu.querySelector('[data-nd-menu-action="toggle-read"]'));
    assert.equal(f.manager.unreadCount, 3);
    assert.equal(rowFor(f, "n2").classList.contains("nd-unread"), true);

    // Menu keyboard behavior keeps the controls reachable without a mouse.
    opened = openMenu(f, "n3");
    const toggle = opened.row.querySelector("[data-nd-menu-toggle]");
    const actions = opened.menu.querySelectorAll("[role=menuitem]");
    actions[0].dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(f.doc.activeElement, actions[1], "arrow keys move through the row menu");
    actions[1].dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(opened.menu.hidden, true, "Escape closes the menu");
    assert.equal(f.doc.activeElement, toggle, "Escape returns focus to the three-dot control");

    // Deleting one item only hides it on this device; other messages stay put.
    opened = openMenu(f, "n1");
    assert.equal(opened.menu.querySelector('[data-nd-menu-action="delete"]').textContent, "Remove from this device");
    click(f, opened.menu.querySelector('[data-nd-menu-action="delete"]'));
    assert.deepEqual(rowIds(f.doc), ["n3", "n2"]);
    assert.deepEqual(JSON.parse(f.win.localStorage.getItem(DELETED_KEY)), ["n1"]);
    assert.equal(f.manager.history.length, 3, "the store keeps its notification history");
    await f.manager.syncHistory(); await tick();
    assert.deepEqual(rowIds(f.doc), ["n3", "n2"], "deleted messages stay hidden when server history refreshes");
  } finally { f.close(); }

  // The existing single bulk action remains available in the drawer header.
  const g = await fixture([note("a1", "A"), note("a2", "B"), note("a3", "C")]);
  try {
    g.manager.toggleDrawer(true); await tick();
    assert.equal(g.manager.unreadCount, 3);
    const markAll = g.doc.querySelector("#notifMarkAllRead");
    assert.equal(markAll.disabled, false);
    click(g, markAll);
    assert.equal(g.manager.unreadCount, 0);
    assert.equal(g.doc.querySelectorAll(".nd-row.nd-unread").length, 0);
    assert.equal(markAll.disabled, true, "bulk read action disables once all are read");
  } finally { g.close(); }

  // Local deletion records stay bounded.
  const many = Array.from({ length: 5 }, (_, i) => note("m" + i, "M" + i));
  const h = await fixture(many, { [DELETED_KEY]: Array.from({ length: 400 }, (_, i) => "old" + i) });
  try {
    assert.equal(h.manager.deletedIds.size, 300);
    assert.equal(JSON.parse(h.win.localStorage.getItem(DELETED_KEY)).length, 300);
  } finally { h.close(); }
  console.log("✓ clean inbox rows use per-message three-dot actions for read/unread and delete, with no checkboxes");
})().catch(error => { console.error(error); process.exitCode = 1; });
