// Sync polling must stay quiet when nothing changed: an unchanged revision must not
// download the store, write storage, or notify subscribers (which re-render open screens).
const fs = require("fs");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://adonai-store.example/pos.html" });
const { window } = dom;
let serverRevision = "r1";
let serverProductName = "Blue shirt";
const requests = [];
window.fetch = async (url, options = {}) => {
  if (String(url).includes("/api/sync/pull")) {
    const body = JSON.parse(options.body || "{}");
    requests.push(body.if_revision || "");
    const payload = body.if_revision === serverRevision
      ? { unchanged: true, revision: serverRevision }
      : { revision: serverRevision, synced_at: "2026-10-11T10:00:00", products: [{ id: "P1", name: serverProductName, sku: "S1", in_stock_count: 1, selling_price: 20000 }], sales: [], ledger: [], settings: {}, riders: [], categories: [], inventory: [], blocked_areas: [] };
    return { ok: true, status: 200, json: async () => payload };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
window.eval(fs.readFileSync("js/db.js", "utf8"));
const DB = window.DB;

const assert = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + "  " + label); if (!cond) process.exitCode = 1; };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

(async () => {
  let notifications = 0;
  DB.on("*", () => { notifications += 1; });
  await settle(); // initial boot pull (may or may not run before we subscribe)
  notifications = 0; requests.length = 0;

  // 1. Same revision again: a tiny reply, no store download, no notifications, no writes.
  const beforeUnchanged = JSON.stringify(window.localStorage);
  const applied = await DB.refreshOperationalData();
  assert(applied === false, "unchanged revision reports nothing applied");
  assert(notifications === 0, "unchanged revision notifies no subscribers (no re-render)");
  assert(JSON.stringify(window.localStorage) === beforeUnchanged, "unchanged revision writes nothing to storage");
  assert(requests.length === 1 && requests[0] === "r1", "poll sends the stored revision (" + JSON.stringify(requests) + ")");

  // 2. The server changes: the store is applied once and subscribers are notified once.
  serverRevision = "r2"; serverProductName = "Red dress";
  requests.length = 0;
  const changed = await DB.refreshOperationalData();
  assert(changed === true, "changed revision is applied");
  assert(notifications === 1, "changed revision notifies subscribers once (" + notifications + ")");
  assert(DB.listProducts().some(p => p.name === "Red dress"), "new product data is visible locally");

  // 3. Next poll with the new revision is quiet again.
  notifications = 0;
  await DB.refreshOperationalData();
  assert(notifications === 0, "next poll after an update is quiet");

  // 4. A refresh that finds nothing new is HEALTHY, not a failure: the call
  //    reports "nothing applied" while the sync state stays online. Refresh
  //    buttons must key their error messages on online, never on this boolean.
  const appliedAgain = await DB.refreshOperationalData();
  assert(appliedAgain === false, "no-change refresh reports nothing applied");
  const freshState = DB.operationalSyncStatus();
  assert(freshState.online === true, "no-change refresh still reports the sync as online");
  assert(!!freshState.last_synced_at, "no-change refresh still stamps when the server was reached");

  // 5. A forced refresh bypasses the revision short-circuit and re-downloads
  //    even though the revision matches — what a manual Refresh button wants.
  requests.length = 0;
  serverProductName = "Green skirt";
  const forced = await DB.refreshOperationalData({ force: true });
  assert(requests.length === 1 && requests[0] === "", "forced refresh re-downloads instead of asking 'unchanged?' (" + JSON.stringify(requests) + ")");
  assert(forced === true, "forced refresh reports the applied changes");
  assert(DB.listProducts().some(p => p.name === "Green skirt"), "forced refresh replaces the local store");

  // 6. Only a request that never reached the server reports offline — the
  //    real signal behind every "Could not refresh" message.
  window.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const failed = await DB.refreshOperationalData({ force: true });
  assert(failed === false, "a failed refresh also reports nothing applied");
  assert(DB.operationalSyncStatus().online === false, "a failed refresh reports the sync as offline — the real error signal");
  window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
