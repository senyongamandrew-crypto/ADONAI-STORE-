#!/usr/bin/env node
/* Bell inbox v3: clean rows by default; press-and-hold (or right-click) shows
 * selection boxes for Select all / Mark read / Delete permanently, and the
 * boxes disappear again after the action. Also covers system pop-ups (desktop
 * Notification API + Android bridge), the simple notification sound settings
 * and the unread count in the window title.
 * Run: node tests/notification-collections.test.js
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "js/notifications.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const note = (id, title, extra = {}) => Object.assign({ id, type: "NEW_ORDER", title, message: "UGX 1,000", timestamp: 1791660000 + Number(id.replace(/\D/g, "") || 0), area: "orders", protected: false }, extra);
const DELETED_KEY = "adonai.notifications.deleted.v1", HOLD_KEY = "adonai.notifications.hold.v1", PREFS_KEY = "adonai.notifications.prefs.v1";

async function fixture(feed, options = {}) {
  const dom = new JSDOM('<!doctype html><head><title>Adonai POS</title></head><body><button id="notifBellBtn"><span id="notifBadge" style="display:none"></span></button></body>', {
    runScripts: "outside-only", url: "https://preview.example/pos.html", pretendToBeVisual: true });
  const win = dom.window;
  win.EventSource = function () { throw new Error("SSE disabled"); };
  win.Auth = { authHeaders: () => ({}) };
  win.PosAccess = { headers: () => ({}) };
  win.DB = { apiUrl: value => value };
  Object.entries(options.storage || {}).forEach(([key, value]) => win.localStorage.setItem(key, JSON.stringify(value)));
  if (options.setup) options.setup(win);
  let current = feed;
  const posts = [];
  win.fetch = async (url, request = {}) => {
    if (request.method === "POST") {
      posts.push({ url, body: JSON.parse(request.body) });
      const status = options.deleteStatus || 200;
      if (status === 200) { const ids = JSON.parse(request.body).ids; current = current.filter(n => !ids.includes(n.id)); }
      return { ok: status === 200, status, json: async () => ({ ok: status === 200, deleted: 1 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, notifications: JSON.parse(JSON.stringify(current)) }) };
  };
  win.eval(SCRIPT);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await tick(); await tick();
  const manager = win.notificationEngine;
  return { win, doc: win.document, manager, posts, feed(value) { current = value; }, close: () => { manager.stop(); win.close(); } };
}
const rows = doc => Array.from(doc.querySelectorAll("#notifDrawerList .nd-row"));
const rowIds = doc => rows(doc).map(row => row.dataset.notificationRow);
const rowFor = (f, id) => rows(f.doc).find(row => row.dataset.notificationRow === id);
const boxes = doc => doc.querySelectorAll("#notifDrawerList [data-nd-select]");
const $ = (f, id) => f.doc.getElementById(id);
const click = (f, element, init = {}) => {
  assert(element, "expected the target element to exist");
  element.dispatchEvent(new f.win.MouseEvent("click", Object.assign({ bubbles: true, cancelable: true }, init)));
};
const rightClick = (f, element) => element.dispatchEvent(new f.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
function openMenu(f, id) {
  const row = rowFor(f, id);
  click(f, row && row.querySelector("[data-nd-menu-toggle]"));
  return { row, menu: row && row.querySelector(".nd-menu") };
}

async function cleanRowsAndMenu() {
  const feed = [note("n1", "First sale"), note("n2", "Second sale"), note("n3", "Third sale")];
  const f = await fixture(feed, { storage: { [HOLD_KEY]: ["n1"] } });
  try {
    f.manager.toggleDrawer(true); await tick();
    assert.deepEqual(rowIds(f.doc), ["n3", "n2", "n1"], "one list, newest first");
    assert.equal(boxes(f.doc).length, 0, "no selection boxes in the normal inbox");
    assert.equal(f.doc.querySelectorAll("#notifDrawerList input[type=checkbox]").length, 0);
    assert.equal($(f, "notifSelectBar").hidden, true, "selection toolbar hidden until a message is held");
    assert.equal($(f, "notifFeedBar").hidden, false);
    assert.equal($(f, "notifHint").hidden, false, "a short tip explains press-and-hold");
    assert.equal(f.manager.unreadCount, 3, "opening the inbox does not implicitly read notifications");
    assert.equal(f.win.localStorage.getItem(HOLD_KEY), null, "retired hold list is removed");
    assert.match(f.doc.title, /^\(3\) Adonai POS$/, "unread count shows in the window/taskbar title");

    let opened = openMenu(f, "n2");
    const labels = Array.from(opened.menu.querySelectorAll("[role=menuitem]")).map(b => b.textContent);
    assert.deepEqual(labels, ["Mark as read", "Select…", "Delete permanently"]);
    click(f, opened.menu.querySelector('[data-nd-menu-action="toggle-read"]'));
    assert.equal(f.manager.unreadCount, 2);
    assert.equal(rowFor(f, "n2").classList.contains("nd-unread"), false);
    assert.match(f.doc.title, /^\(2\) /);

    // Keyboard reachability of the row menu is unchanged.
    opened = openMenu(f, "n3");
    const toggle = opened.row.querySelector("[data-nd-menu-toggle]");
    const actions = opened.menu.querySelectorAll("[role=menuitem]");
    actions[0].dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(f.doc.activeElement, actions[1], "arrow keys move through the row menu");
    actions[1].dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(opened.menu.hidden, true, "Escape closes the menu");
    assert.equal(f.doc.activeElement, toggle);
  } finally { f.close(); }
  console.log("✓ the normal inbox stays clean: no tick boxes, a tip, per-row menu, unread count in the title");
}

async function pressAndHoldSelectAllAndDeletePermanently() {
  const feed = [note("n1", "First sale"), note("n2", "Second sale"), note("n3", "Third sale"), note("n4", "Fourth sale")];
  const f = await fixture(feed);
  try {
    f.manager.toggleDrawer(true); await tick();
    // Press and hold one message (real pointer timing).
    const held = rowFor(f, "n3").querySelector("[data-notification-open]");
    held.dispatchEvent(new f.win.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    await wait(600);
    held.dispatchEvent(new f.win.MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    assert.equal(f.manager.selecting, true, "holding a message starts selection");
    assert.equal(boxes(f.doc).length, 4, "tick boxes appear on every message");
    assert.equal($(f, "notifSelectBar").hidden, false);
    assert.equal($(f, "notifFeedBar").hidden, true);
    assert.equal($(f, "notifSelectCount").textContent, "1 selected");
    assert.equal(rowFor(f, "n3").querySelector("[data-nd-select]").getAttribute("aria-checked"), "true");
    // The click that ends the hold must not untick it again.
    click(f, rowFor(f, "n3").querySelector("[data-nd-select]"));
    assert.equal($(f, "notifSelectCount").textContent, "1 selected");

    // Tap others, Shift-click a range, then Select all.
    click(f, rowFor(f, "n1").querySelector("[data-nd-select]"));
    assert.equal($(f, "notifSelectCount").textContent, "2 selected");
    click(f, rowFor(f, "n1").querySelector("[data-nd-select]"));
    assert.equal($(f, "notifSelectCount").textContent, "1 selected");
    click(f, rowFor(f, "n1").querySelector("[data-nd-select]"), { shiftKey: true });
    assert.equal($(f, "notifSelectCount").textContent, "3 selected", "Shift-click selects the range n3..n1");
    assert.match($(f, "notifSelectAll").textContent, /Select all \(4\)/);
    click(f, $(f, "notifSelectAll"));
    assert.equal($(f, "notifSelectCount").textContent, "4 selected");
    assert.equal($(f, "notifSelectAll").textContent, "Clear all");

    // Delete asks first; Keep cancels only the question.
    click(f, $(f, "notifSelectDelete"));
    assert.equal($(f, "notifDeleteConfirm").hidden, false);
    assert.match($(f, "notifDeleteText").textContent, /Delete all 4 notifications permanently\? .*every device.*not affected/);
    click(f, $(f, "notifDeleteNo"));
    assert.equal($(f, "notifDeleteConfirm").hidden, true);
    assert.equal(f.manager.selecting, true);

    click(f, $(f, "notifSelectDelete"));
    click(f, $(f, "notifDeleteYes"));
    await tick(); await tick(); await tick();
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0].url, "/api/notifications/delete");
    assert.deepEqual(f.posts[0].body.ids.sort(), ["n1", "n2", "n3", "n4"]);
    assert.equal(rows(f.doc).length, 0, "deleted messages are gone");
    assert.equal(f.manager.selecting, false, "selection mode ends after the action");
    assert.equal($(f, "notifSelectBar").hidden, true);
    assert.equal($(f, "notifFeedBar").hidden, false);
    assert.match($(f, "notifFeedStatus").textContent, /4 notifications deleted permanently/);
    assert.equal(f.manager.unreadCount, 0);
    await f.manager.syncHistory(); await tick();
    assert.equal(rows(f.doc).length, 0, "they do not come back on refresh");
  } finally { f.close(); }
  console.log("✓ press-and-hold shows tick boxes; Select all + Delete permanently removes them store-wide, then boxes disappear");
}

async function rightClickMarkReadEscapeAndMenuSelect() {
  const feed = [note("n1", "A"), note("n2", "B"), note("n3", "C")];
  const f = await fixture(feed);
  try {
    f.manager.toggleDrawer(true); await tick();
    rightClick(f, rowFor(f, "n2").querySelector("[data-notification-open]"));
    assert.equal(f.manager.selecting, true, "right-click starts selection on a computer");
    click(f, rowFor(f, "n1").querySelector("[data-nd-select]"));
    assert.equal($(f, "notifSelectRead").textContent, "Mark read");
    click(f, $(f, "notifSelectRead"));
    assert.equal(f.manager.unreadCount, 1, "bulk mark read");
    assert.equal(f.manager.selecting, false, "boxes disappear after marking read");
    assert.equal(boxes(f.doc).length, 0);

    // Escape cancels selection without deleting anything.
    rightClick(f, rowFor(f, "n3").querySelector("[data-notification-open]"));
    assert.equal(boxes(f.doc).length, 3);
    f.doc.body.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.manager.selecting, false);
    assert.equal(rows(f.doc).length, 3);

    // Ctrl-click (mouse) and the ⋯ "Select…" item also start selection.
    click(f, rowFor(f, "n3").querySelector("[data-notification-open]"), { ctrlKey: true });
    assert.equal(f.manager.selecting, true);
    click(f, rowFor(f, "n3").querySelector("[data-nd-select]"));
    assert.equal(f.manager.selecting, false, "unticking the last box returns to the normal inbox");
    const opened = openMenu(f, "n1");
    click(f, opened.menu.querySelector('[data-nd-menu-action="select"]'));
    assert.equal(f.manager.selecting, true);
    assert.equal($(f, "notifSelectCount").textContent, "1 selected");
    f.manager.toggleDrawer(false);
    assert.equal(f.manager.selecting, false, "closing the bell clears the selection");
  } finally { f.close(); }
  console.log("✓ right-click / Ctrl-click / menu start selecting; Mark read, Escape and closing restore the clean inbox");
}

async function singleDeleteAndCashierFallback() {
  const feed = [note("n1", "A"), note("n2", "B")];
  const f = await fixture(feed, { deleteStatus: 403 });
  try {
    f.manager.toggleDrawer(true); await tick();
    const opened = openMenu(f, "n1");
    click(f, opened.menu.querySelector('[data-nd-menu-action="delete"]'));
    assert.equal($(f, "notifDeleteConfirm").hidden, false, "single delete asks for confirmation too");
    assert.match($(f, "notifDeleteText").textContent, /Delete 1 notification permanently\?/);
    click(f, $(f, "notifDeleteYes"));
    await tick(); await tick(); await tick();
    assert.deepEqual(rowIds(f.doc), ["n2"]);
    assert.deepEqual(JSON.parse(f.win.localStorage.getItem(DELETED_KEY)), ["n1"]);
    assert.match($(f, "notifFeedStatus").textContent, /Only a manager or admin can delete for everyone/);
    await f.manager.syncHistory(); await tick();
    assert.deepEqual(rowIds(f.doc), ["n2"], "still hidden on this device after refresh");
  } finally { f.close(); }

  const many = Array.from({ length: 5 }, (_, i) => note("m" + i, "M" + i));
  const h = await fixture(many, { storage: { [DELETED_KEY]: Array.from({ length: 400 }, (_, i) => "old" + i) } });
  try {
    assert.equal(h.manager.deletedIds.size, 300, "device deletion records stay bounded");
  } finally { h.close(); }
  console.log("✓ single delete confirms; cashier keys without permission still clear their own device");
}

async function systemPopupsAndSound() {
  // Desktop browser: Notification API, window not focused.
  const shown = [];
  const f = await fixture([note("n1", "Old order")], {
    setup(win) {
      function FakeNotification(title, options) { shown.push({ title, options }); this.close = () => {}; }
      FakeNotification.permission = "granted";
      FakeNotification.requestPermission = async () => "granted";
      win.Notification = FakeNotification;
      win.document.hasFocus = () => false;
    }
  });
  try {
    assert.equal(f.manager.systemSupport(), "web");
    assert.equal(f.manager.alertState().state, "on");
    f.feed([note("n2", "Website order received", { message: "Order WEB-2 · UGX 85,000" }), note("n1", "Old order")]);
    await f.manager.syncHistory(); await tick(); await tick();
    assert.equal(shown.length, 1, "a new order raises one system pop-up while the POS is not focused");
    assert.equal(shown[0].title, "Website order received");
    assert.equal(shown[0].options.body, "Order WEB-2 · UGX 85,000");
    assert.equal(shown[0].options.tag, "adonai-n2");
    assert.equal(shown[0].options.requireInteraction, true, "orders stay on screen until seen");
    assert.match(shown[0].options.data.url, /admin\.html\?view=sales$/);

    // Focused window: the in-app toast is enough unless the user opts in.
    f.win.document.hasFocus = () => true;
    f.feed([note("n3", "Stock intake saved", { type: "STOCK_ADDED", area: "stock" })]);
    await f.manager.syncHistory(); await tick(); await tick();
    assert.equal(shown.length, 1);
    f.manager.toggleDrawer(true);
    click(f, $(f, "notifSettingsToggle"));
    assert.equal($(f, "notifAlertPanel").hidden, false);
    const fg = $(f, "notifPrefForeground");
    fg.checked = true; fg.dispatchEvent(new f.win.Event("change", { bubbles: true }));
    f.feed([note("n4", "Customer note", { type: "NEW_MESSAGE" })]);
    await f.manager.syncHistory(); await tick(); await tick();
    assert.equal(shown.length, 2, "'Also while I am using the POS' shows pop-ups in the foreground");

    // Simple sound settings persist per device.
    const sound = $(f, "notifPrefSound");
    sound.checked = false; sound.dispatchEvent(new f.win.Event("change", { bubbles: true }));
    const volume = $(f, "notifPrefVolume");
    volume.value = "40"; volume.dispatchEvent(new f.win.Event("input", { bubbles: true }));
    const prefs = JSON.parse(f.win.localStorage.getItem(PREFS_KEY));
    assert.equal(prefs.sound, false);
    assert.equal(prefs.foreground, true);
    assert.equal(prefs.volume, 0.4);
    assert.equal(f.manager.ding(), false, "sound off means no ding");
    assert.equal(Object.keys(prefs).some(key => /title|message|customer/i.test(key)), false, "preferences never hold alert text");
  } finally { f.close(); }

  // Pop-ups not yet allowed: the drawer offers a one-click Turn on.
  const g = await fixture([note("n1", "A")], {
    setup(win) {
      function FakeNotification() {}
      FakeNotification.permission = "default";
      FakeNotification.requestPermission = async () => { FakeNotification.permission = "granted"; return "granted"; };
      win.Notification = FakeNotification;
    }
  });
  try {
    g.manager.toggleDrawer(true);
    assert.equal($(g, "notifAlertBar").hidden, false);
    assert.equal($(g, "notifAlertEnable").hidden, false);
    assert.equal($(g, "notifAlertEnable").textContent, "Turn on pop-ups");
    click(g, $(g, "notifAlertEnable"));
    await tick(); await tick(); await tick();
    assert.equal(g.manager.alertState().state, "on");
    assert.equal($(g, "notifAlertBar").hidden, true, "once on, the bar tucks away behind the gear");
  } finally { g.close(); }

  // Android APK: the native bridge posts to the notification shade.
  const posted = [];
  const a = await fixture([note("n1", "A")], {
    setup(win) {
      win.Android = {
        storeAlertPermission: () => "granted",
        requestStoreAlertPermission: () => {},
        storeAppVisible: () => false,
        showStoreAlert: json => { posted.push(JSON.parse(json)); return true; }
      };
    }
  });
  try {
    assert.equal(a.manager.systemSupport(), "native");
    a.feed([note("n2", "Order received", { message: "Order WEB-9 · UGX 40,000" }), note("n1", "A")]);
    await a.manager.syncHistory(); await tick();
    assert.equal(posted.length, 1);
    assert.deepEqual({ id: posted[0].id, title: posted[0].title, body: posted[0].body, view: posted[0].view, urgent: posted[0].urgent },
      { id: "n2", title: "Order received", body: "Order WEB-9 · UGX 40,000", view: "sales", urgent: true });
    assert.equal(a.manager.ding(), false, "in the background Android's own notification sound plays instead");
  } finally { a.close(); }
  console.log("✓ system pop-ups on desktop (unfocused or opted-in) and Android; simple sound on/off + volume persist");
}

(async () => {
  await cleanRowsAndMenu();
  await pressAndHoldSelectAllAndDeletePermanently();
  await rightClickMarkReadEscapeAndMenuSelect();
  await singleDeleteAndCashierFallback();
  await systemPopupsAndSound();
})().catch(error => { console.error(error); process.exitCode = 1; });
