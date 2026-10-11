"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const csstree = require("css-tree");
const source = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const SALE = {id:"AT-123", channel:"pos", status:"completed", payment:{status:"unpaid"}, created_at:"2026-10-10T04:00:00", total:43000, subtotal:40000, delivery_fee:3000,
  customer_name:'Sarah <script>alert(1)</script>', customer_phone:"+256700123456", cashier:{name:"Andrew"}, tender:{type:"cash"},
  items:[{name:"Saved dress", sku:"SKU-1", qty:2, unit_price:20000, line_total:40000, unit_cost:7000}]};
function fixture() {
  const dom = new JSDOM('<!doctype html><head><title>Store dashboard</title></head><body><main>Live register</main><div id="receiptSheet"></div></body>', {url:"https://store.example/admin.html?view=customers", runScripts:"outside-only"});
  const win = dom.window, state = {prints:0, locked:false, native:null, cancelled:0};
  win.PosAccess = {canUse:area => area === "orders" && !state.locked};
  win.print = () => { state.prints++; };
  win.eval(source("js/audit-exports.js")); win.eval(source("js/receipt-printing.js"));
  return {win, doc:win.document, state, close:() => win.close()};
}
const selection = {from:"2026-10-10", to:"2026-10-10", label:"2026-10-10", lastSynced:"2026-10-10T20:59:00Z"};
const settings = {store_name:"ADONAI STORE", address:"Kibuli, Kampala", hotline:"+256700000001"};

const f = fixture();
try {
  const helper = f.win.AuditExports, printer = f.win.ReceiptPrinter;
  assert.equal(helper.untilMidnight(new Date("2026-10-10T20:59:59Z")), 1050);
  assert.equal(helper.untilMidnight(new Date("2026-10-10T21:00:00Z")), 86400050);
  assert.equal(helper.dayTitle(helper.range("2026-10-10","2026-10-10"), new Date("2026-10-10T21:00:00Z")), "Yesterday's receipts");
  const before = JSON.stringify(SALE);
  const markup = printer.receipt(SALE, settings);
  assert.match(markup, /10 Oct 2026, 07:00 EAT/);
  assert.match(markup, /UGX 43,000/); assert.match(markup, /UGX 40,000/); assert.match(markup, /UGX 3,000/);
  assert.match(markup, /Completed POS checkout/); assert.doesNotMatch(markup, /UNPAID|unit_cost|7,000/);
  assert.doesNotMatch(markup, /<script>|src=|onerror=|alert\(1\)<\/script>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.equal(JSON.stringify(SALE), before, "rendering never changes historical prices/payment/stock");
  assert.throws(() => printer.receipt({...SALE,status:"cancelled"},settings), /saved, posted/);
  assert.throws(() => printer.receipt({...SALE,channel:"web",payment:{status:"unpaid"}},settings), /saved, posted/);
  console.log("✓ itemized saved invoice, 07:00 Kampala time, literal customer text, correct totals and legacy POS posting without rewriting data");

  printer.printReceipt(SALE, settings, "receipt");
  assert.equal(f.state.prints, 1); assert.equal(f.doc.body.classList.contains("rp-printing"), true);
  assert.match(f.doc.querySelector("#receiptPrintStyle").textContent, /size:80mm 297mm/);
  assert.equal(f.doc.querySelectorAll("#receiptSheet .rp-invoice").length, 1);
  assert.equal(f.doc.title,"Adonai receipt AT-123");
  csstree.parse(f.doc.querySelector("#receiptPrintStyle").textContent, {onParseError(error) { throw error; }});
  assert.throws(() => printer.printReceipt(SALE,settings,"a4"), /Finish/);
  f.win.dispatchEvent(new f.win.Event("afterprint"));
  assert.equal(f.doc.title, "Store dashboard"); assert.equal(f.doc.querySelector("#receiptSheet").textContent, "");
  assert.equal(f.doc.querySelector("#receiptPrintStyle"), null);
  const online = {...SALE,id:"AT-WEB",channel:"web",payment:{status:"paid",paid_at:"2026-10-10T20:59:59"},tender:{type:"mtn"},total:20000,subtotal:20000,delivery_fee:0};
  printer.printInvoices([SALE,online],selection,settings,"a4");
  assert.equal(f.doc.querySelectorAll("#receiptSheet .rp-invoice").length, 2);
  assert.match(f.doc.querySelector("#receiptPrintStyle").textContent, /size:A4/);
  assert.match(f.doc.querySelector("#receiptPrintStyle").textContent, /break-after:page/);
  assert.match(f.doc.querySelector("#receiptSheet").textContent, /23:59 EAT/);
  f.win.dispatchEvent(new f.win.Event("afterprint"));
  assert.throws(() => printer.printInvoices([],selection,settings,"a4"), /No posted receipts/);
  assert.throws(() => printer.printInvoices(Array(251).fill(SALE),selection,settings,"a4"), /250 invoices/);
  printer.printSummary([SALE,online],{...selection,search:"Sarah",offline:true},settings);
  const summary = f.doc.querySelector("#receiptSheet").textContent;
  assert.match(summary, /UGX 63,000/); assert.match(summary, /Cash/); assert.match(summary, /MTN MoMo/);
  assert.match(summary, /filtered summary/); assert.match(summary, /may be incomplete/);
  assert.match(summary, /Previous days remain/);
  f.state.locked = true; f.win.dispatchEvent(new f.win.CustomEvent("pos-access-change"));
  assert.equal(f.doc.querySelector("#receiptSheet").textContent, "");
  assert.throws(() => printer.printReceipt(SALE,settings,"a4"), /locked/);
  console.log("✓ single/batch A4 & receipt-roll print layouts, summary/payment totals, offline/search caveats, afterprint cleanup and scope re-lock");
} finally { f.close(); }

const native = fixture();
try {
  native.win.Android = {printReceipts:(html,title,paper) => {native.state.native={html,title,paper}; return true;}, cancelReceiptPrint:() => {native.state.cancelled++;}};
  assert.equal(native.win.ReceiptPrinter.printReceipt(SALE,settings,"a4").mode,"native");
  assert.equal(native.state.prints,0);
  assert(native.state.native.html.startsWith("<!doctype html>")); assert.equal(native.state.native.paper,"a4");
  assert.doesNotMatch(native.state.native.html, /<script|<iframe|<img|onclick=/i);
  assert.equal(native.doc.querySelector("#receiptPrintStyle"),null);
  native.state.locked=true; native.win.dispatchEvent(new native.win.CustomEvent("pos-access-change")); assert.equal(native.state.cancelled,1);
  native.state.locked=false; native.win.Android={openExternal() {}};
  assert.throws(() => native.win.ReceiptPrinter.printReceipt(SALE,settings,"a4"), /needs the receipt-print update/);
  const java = source("android/app/src/main/java/com/adonaithrift/pos/MainActivity.java");
  const section = java.slice(java.indexOf("private void printReceiptDocument"),java.indexOf("private class AndroidBridge"));
  assert.match(section,/setJavaScriptEnabled\(false\)/); assert.match(section,/setBlockNetworkLoads\(true\)/);
  assert.match(section,/setAllowFileAccess\(false\)/); assert.match(section,/setAllowContentAccess\(false\)/);
  assert.match(java,/public boolean printReceipts/); assert.match(java,/PrintAttributes.MediaSize.ISO_A4/);
  console.log("✓ trusted self-contained native system print, cancellation on lock, honest older-APK fallback and no file/network/JS access in print documents");
} finally { native.close(); }
