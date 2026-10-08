const fs = require("fs");
const { JSDOM } = require("jsdom");

// Simulate a device with STALE factory-reset-era browser state:
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://adonai-store.example/pos.html" });
const { window } = dom;
const ls = window.localStorage, ss = window.sessionStorage;
ls.setItem("adonai-db-v6", JSON.stringify({ version: 3, products: [{ id: "PRD-1001", name: "OLD DEMO JACKET" }], sales: [{ id: "AT-1841" }], staff: [{ id: "STF-01" }, { id: "STF-02" }], ledger: [{ id: "LED-1001" }], guests: [{ id: "GUS-1001" }], riders: [{ id: "RDR-1001" }], settings: {}, counters: { product: 1018, sale_seq: 1861 } }));
ls.setItem("adonai-cart-v1", JSON.stringify([{ product_id: "PRD-1001", qty: 2 }]));
ls.setItem("adonai-session-v2", JSON.stringify({ id: "STF-03", name: "Old Cashier", token: "jwt-old" }));
ls.setItem("adonai-terminal-token", "jwt-old");
ls.setItem("adonai-suite-unlocked", "1");
ls.setItem("adonai.notifications.log", JSON.stringify([{ id: 1 }]));
ls.setItem("adonai_analytics_queue", JSON.stringify([{ evt: 1 }]));
ls.setItem("adonai-measure-unit", "cm");
ss.setItem("adonai-pos-lock-owner", "POS-OLD-LOCK");
ss.setItem("adonai-suite-unlocked", "1");

window.eval(fs.readFileSync("js/db.js", "utf8"));
const DB = window.DB;

const keysAfter = [...Array(ls.length)].map((_, i) => ls.key(i)).concat([...Array(ss.length)].map((_, i) => ss.key(i)));

// The offline engine seeds lazily on first API call — exactly what the POS /
// admin / storefront UIs do on load:
const catalog = window.DB.listProducts();
const st = JSON.parse(ls.getItem("adonai-db-v7"));

const assert = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + "  " + label); if (!cond) process.exitCode = 1; };

assert(ls.getItem("adonai-db-v6") === null, "old adonai-db-v6 cache removed");
assert(ls.getItem("adonai-cart-v1") === null, "web cart removed");
assert(ls.getItem("adonai-session-v2") === null, "stale staff session removed");
assert(ls.getItem("adonai-terminal-token") === null, "stale JWT token removed");
assert(ls.getItem("adonai-suite-unlocked") === null, "stale admin-suite unlock removed");
assert(ls.getItem("adonai.notifications.log") === null, "notification history removed");
assert(ls.getItem("adonai_analytics_queue") === null, "analytics queue removed");
assert(ss.getItem("adonai-pos-lock-owner") === null, "sessionStorage lock owner removed");
assert(Array.isArray(st.products) && st.products.length === 0, "offline catalog EMPTY (0 items)");
assert(st.sales.length === 0 && st.ledger.length === 0, "offline sales + ledger EMPTY");
assert(st.guests.length === 0 && st.riders.length === 0, "offline guests + riders EMPTY");
assert(st.staff.length === 1 && st.staff[0].id === "STF-01" && st.staff[0].role === "admin", "exactly ONE admin staff (STF-01)");
assert(st.counters.sale_pos === 1000 && st.counters.product === 1000, "receipt/product counters reset to factory baseline (next: 1001)");
assert(st.settings.store_name === "Adonai Store" && st.settings.currency === "UGX", "store settings preserved in offline seed");
assert(st.version === 4, "offline DB version bumped to 4 (v7 store)");
assert(Array.isArray(catalog) && catalog.length === 0, "AdonaiDB API serves the clean catalog");
assert(keysAfter.every(k => /^adonai/i.test(k)), "no non-adonai keys touched");

console.log("\nOffline factory purge verification:", process.exitCode ? "FAILURES FOUND" : "ALL CHECKS PASSED");

// jsdom keeps the event loop alive (realtime polling timers installed by the
// DB engine) — exit explicitly once assertions are done.
process.exit(process.exitCode || 0);
