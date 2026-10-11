#!/usr/bin/env node
/* Garment tag / camera regressions. Isolated fixtures only; never real stock. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const csstree = require("css-tree");
const ROOT = path.resolve(__dirname, "..");
const source = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
const PRODUCT = { id: "PRD-TAG-TEST", name: "Fixture cotton shirt", sku: "ADN-MEN-1002", barcode_id: "ADN-MEN-1002-1OF1", size: "L", color: "Green", brand: "Adonai", demographic: "Men", category: "Tops & Shirts", condition: "Grade A", item_condition: "PRE_LOVED", in_stock_count: 1, selling_price: 50000 };

// Use the real Code 128 generator without booting a server or seeding a catalog.
const dbDOM = new JSDOM("", { url: "https://unit.example/", runScripts: "outside-only" });
dbDOM.window.fetch = async () => ({ ok: true, json: async () => ({}) });
dbDOM.window.eval(source("js/db.js"));
const barcodeSVG = dbDOM.window.DB.barcodeSVG;

function fixture(page, products = []) {
  const dom = new JSDOM(source(page), { url: "https://unit.example/" + page + (page === "admin.html" ? "?view=intake" : ""), runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  win.Auth = { ready: async () => {}, guard: () => ({ id: "TEST", name: "Test", role: "cashier" }), locked: () => false, openAccess: () => true, suiteUnlocked: () => true, token: () => "", me: () => null, authHeaders: () => ({}) };
  win.Icons = { svg: () => '<svg aria-hidden="true"></svg>', icon: () => "" };
  win.Intake = { compressImage: async () => "", imageFieldHTML: () => "" };
  const stats = { saves: 0, prints: 0, holds: 0, stopped: 0, constraints: null, rejectSave: false };
  win.DB = {
    DEMOGRAPHICS: ["Men", "Women", "Children", "Unisex"], CATEGORIES: ["Tops & Shirts", "Shoes"], CONDITIONS: ["Grade A"], ROLE_LABELS: {},
    listProducts: () => products, getProduct: id => products.find(p => p.id === id),
    listSales: () => [], listStaff: () => [], listRiders: () => [], listLedger: () => [], listGuests: () => [], on: () => {},
    barcodeSVG, ugx: n => "UGX " + Number(n).toLocaleString("en-US"), getSettings: () => ({ store_name: "Adonai Store", base_delivery_fee: 7000 }),
    financeRequest: async () => ({ stock_lots: [] }),
    addProduct: async values => {
      stats.saves++;
      if (stats.rejectSave) throw new Error("Save denied by server");
      const product = { ...values, id: PRODUCT.id, selling_price: values.base_price + values.total_transport_cost * 0.5 };
      products.push(product); return product;
    },
    findByBarcode: code => products.find(p => [p.sku, p.barcode_id].some(c => String(c).toUpperCase() === code.toUpperCase())) || null,
    acquireInventoryLock: async () => { stats.holds++; }, releaseInventoryLockOwner: async () => {}, pullProducts: () => {}
  };
  win.print = () => { stats.prints++; };
  win.HTMLMediaElement.prototype.play = async () => {};
  win.HTMLMediaElement.prototype.pause = () => {};
  Object.defineProperty(win.HTMLMediaElement.prototype, "readyState", { get: () => 4 });
  win.HTMLCanvasElement.prototype.getContext = () => ({ scale() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} });
  Object.defineProperty(win, "isSecureContext", { value: true });
  const track = { stop: () => { stats.stopped++; }, getCapabilities: () => ({ torch: true }), applyConstraints: async () => {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  Object.defineProperty(win.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async constraints => { stats.constraints = constraints; return stream; } } });
  win.eval(source("js/garment-media.js"));
  win.eval(source("js/garment-tools.js"));
  win.eval(source("js/audit-exports.js")); win.eval(source("js/receipt-printing.js"));
  return { dom, win, doc: win.document, stats, products, stream, close: () => win.close() };
}
function fillIntake(f) {
  f.doc.querySelector('[data-intake-condition="PRE_LOVED"]').click();
  Object.entries({ inTitle: PRODUCT.name, inSku: PRODUCT.sku, inSize: PRODUCT.size, inColor: PRODUCT.color, inSell: "46500", inTransport: "7000" }).forEach(([id, value]) => { const node = f.doc.getElementById(id); node.value = value; node.dispatchEvent(new f.win.Event("input", { bubbles: true })); });
}
function nativeDecoder(f, code) {
  f.win.BarcodeDetector = class {
    static async getSupportedFormats() { return ["code_128"]; }
    async detect() { return code ? [{ rawValue: code }] : []; }
  };
}
async function cameraFixture(products = [Object.assign({}, PRODUCT)]) {
  const f = fixture("pos.html", products);
  f.win.eval(source("js/pos-camera.js"));
  f.win.eval(source("js/pos.js"));
  await settle(); return f;
}

async function main() {
  const intake = fixture("admin.html");
  try {
    intake.win.eval(source("app.js")); await settle();
    fillIntake(intake);
    assert.equal(intake.doc.querySelector("#tagCode").textContent, PRODUCT.sku, "draft uses the saved-SKU alias without condition markers");
    assert.equal(intake.doc.querySelector(".gt-draft-tag-stage .gt-tag-price"), null);
    assert.equal(intake.doc.querySelector("#btnPrintLastTag").disabled, true, "cannot print an unsaved garment");
    intake.doc.querySelector("#btnIntakePrint").click();
    intake.doc.querySelector("#btnIntakePrint").click();
    await settle();
    assert.equal(intake.stats.saves, 1, "double tap cannot register two garments");
    assert.equal(intake.products.length, 1);
    assert.equal(intake.doc.querySelector("#garmentTagDialog .gt-tag-code").textContent, PRODUCT.sku);
    assert.equal(intake.products[0].selling_price, 50000, "final transport-inclusive price remains in the catalog");
    assert.equal(intake.doc.querySelector("#garmentTagDialog .gt-tag-price"), null, "no price is shown on the physical tag");
    const cleanTag = intake.doc.querySelector("#garmentTagDialog .gt-hangtag");
    assert.equal(cleanTag.children.length, 5, "only business, garment, barcode, readable code and website");
    assert.equal(cleanTag.querySelector(".gt-tag-website").textContent, "adonai-store.onrender.com");
    assert.doesNotMatch(cleanTag.textContent, /UGX|1OF1|one.of.one|pre.loved|vintage|sample|not for sale|printer test|no catalog item|Size|Green/i);
    assert(intake.doc.querySelector("#garmentTagDialog .gt-tag-bars svg rect"));
    assert(intake.doc.querySelector("#recentTagged [data-print-tag]"));
    assert.equal(intake.stats.prints, 0, "saving opens a review, never prints automatically");
    // Unsaved changes cannot leak onto an existing garment's physical tag.
    intake.doc.querySelector("#inTitle").value = "Unsaved replacement";
    intake.doc.querySelector("#inSell").value = "1";
    intake.doc.querySelector("#gtPrintButton").click();
    assert.equal(intake.stats.prints, 1);
    assert.match(intake.doc.querySelector("#garmentPrintSheet").textContent, /Fixture cotton shirt/);
    assert(!intake.doc.querySelector("#garmentPrintSheet").textContent.includes("Unsaved replacement"));
    assert.match(intake.doc.querySelector("#garmentPrintStyle").textContent, /size: 80mm 50mm/);
    assert(intake.doc.body.classList.contains("gt-printing"));
    intake.win.dispatchEvent(new intake.win.Event("afterprint"));
    assert.equal(intake.doc.querySelector("#garmentPrintSheet"), null);
    assert(!intake.doc.body.classList.contains("gt-printing"));
    // Prices remain in the catalog, never the label. Short SKUs fit compact tags.
    intake.products[0].selling_price = 54000;
    const paper = intake.doc.querySelector("#gtPaper"); paper.value = "compact"; paper.dispatchEvent(new intake.win.Event("change"));
    assert.equal(intake.doc.querySelector("#gtPrintButton").disabled, false, "the shorter saved SKU fits compact labels");
    paper.value = "a4"; paper.dispatchEvent(new intake.win.Event("change"));
    const copies = intake.doc.querySelector("#gtCopies"); copies.value = "2.5";
    intake.doc.querySelector("#gtPrintButton").click();
    assert.equal(intake.stats.prints, 1, "fractional copies are rejected");
    copies.value = "3"; intake.doc.querySelector("#gtPrintButton").click();
    assert.equal(intake.doc.querySelectorAll("#garmentPrintSheet .gt-hangtag").length, 3);
    assert.doesNotMatch(intake.doc.querySelector("#garmentPrintSheet").textContent, /UGX|54,000|54000/);
    assert.equal(intake.products[0].selling_price, 54000);
    assert.match(intake.doc.querySelector("#garmentPrintStyle").textContent, /size: A4/);
    intake.win.dispatchEvent(new intake.win.Event("afterprint"));
    intake.doc.querySelector("#garmentTagDialog [data-gt-close]").click();
    intake.doc.querySelector("#btnPrintLastTag").click(); await settle();
    assert.equal(intake.doc.querySelector("#garmentTagDialog .gt-tag-code").textContent, PRODUCT.sku);
    // Optional area protections also apply to open print previews.
    intake.win.PosAccess = { canUse: () => false, ensure: async () => false, areaForView: () => null };
    intake.win.dispatchEvent(new intake.win.Event("pos-access-change"));
    assert.equal(intake.doc.querySelector("#garmentTagDialog"), null);
    await intake.win.GarmentTools.openTag(PRODUCT.id);
    assert.equal(intake.doc.querySelector("#garmentTagDialog"), null);
    console.log("✓ clean price-free saved-SKU tags, catalog prices preserved, reprints, copies, paper sizes and stock protection");
  } finally { intake.close(); }

  const failed = fixture("admin.html");
  try {
    failed.win.eval(source("app.js")); await settle(); fillIntake(failed);
    failed.stats.rejectSave = true; failed.doc.querySelector("#btnIntakePrint").click(); await settle();
    assert.equal(failed.doc.querySelector("#garmentTagDialog"), null);
    assert.equal(failed.stats.prints, 0);
    assert.match(failed.doc.querySelector("#toast").textContent, /Save denied/);
    assert.equal(failed.doc.querySelector("#btnIntakePrint").disabled, false);
    failed.doc.querySelector("[data-sample-tag]").click(); await settle();
    assert.match(failed.doc.querySelector("#garmentTagDialog .gt-description").textContent, /example, not a saved catalog item/);
    assert.equal(failed.doc.querySelector("#garmentTagDialog .gt-tag-name").textContent, "Cotton Shirt");
    assert.equal(failed.doc.querySelector("#garmentTagDialog .gt-tag-code").textContent, "ADN-000000");
    assert.equal(failed.products.length, 0, "sample tag never becomes real stock");
    failed.doc.querySelector("#gtPrintButton").click();
    assert.doesNotMatch(failed.doc.querySelector("#garmentPrintSheet").textContent, /sample|not for sale|printer test|no catalog item|UGX|pre.loved|one.of.one/i);
    console.log("✓ clean layout preview has no operational text on its tag; failed saves never print and preview never seeds stock");
  } finally { failed.close(); }

  const directPreview = fixture("admin.html");
  try {
    directPreview.win.history.replaceState({}, "", "admin.html?view=intake&tagPreview=1");
    directPreview.win.eval(source("app.js")); await settle();
    assert(directPreview.doc.querySelector("#garmentTagDialog"), "direct preview link opens the clean layout");
    assert.equal(directPreview.doc.querySelector("#garmentTagDialog .gt-tag-name").textContent, "Cotton Shirt");
    assert.equal(directPreview.products.length, 0);
    assert.equal(directPreview.stats.saves, 0);
  } finally { directPreview.close(); }

  const layout = fixture("admin.html", [{ ...PRODUCT, sku: "ADN-" + "A".repeat(30) }]);
  try {
    const website = layout.win.GarmentTools.websiteLabel;
    assert.equal(website({ website_url: "https://www.adonaistore.com/" }), "adonaistore.com");
    assert.equal(website({ app_url: "https://shop.example/ug/" }), "shop.example/ug");
    for (const url of ["https://10000-sandbox.e2b.app/", "http://localhost:10000/", "https://appassets.androidplatform.net/", "https://user:secret@shop.example/", "javascript:alert(1)"]) {
      assert.equal(website({ website_url: url }), "adonai-store.onrender.com", "never print native, preview, credential or invalid URLs");
    }
    await layout.win.GarmentTools.openTag(PRODUCT.id);
    assert.equal(layout.doc.querySelector("#gtPrintButton").disabled, true, "long codes cannot be squeezed into unreadable small labels");
    const paper = layout.doc.querySelector("#gtPaper"); paper.value = "wide"; paper.dispatchEvent(new layout.win.Event("change"));
    assert.equal(layout.doc.querySelector("#gtPrintButton").disabled, false);
    layout.products[0].name = "Updated garment name";
    layout.win.DB.getSettings = () => ({ store_name: "Adonai Store", website_url: "https://www.adonaistore.com/" });
    layout.doc.querySelector("#gtPrintButton").click();
    assert.match(layout.doc.querySelector("#garmentPrintSheet").textContent, /Updated garment name/);
    assert.match(layout.doc.querySelector("#garmentPrintSheet").textContent, /adonaistore.com/);
    console.log("✓ configured storefront, saved garment changes, safe website fallback and long-code readability check");
  } finally { layout.close(); }

  const scanned = await cameraFixture();
  try {
    nativeDecoder(scanned, PRODUCT.barcode_id);
    scanned.doc.querySelector("#btnScanTag").click(); await settle();
    assert.equal(scanned.stats.holds, 1);
    assert.equal(scanned.doc.querySelector("#sumItems").textContent, "1");
    assert.equal(scanned.doc.querySelector("#btnCharge").disabled, false);
    assert.equal(scanned.doc.querySelector("#posCameraDialog"), null);
    assert.equal(scanned.stats.stopped, 1, "camera stops immediately after one valid scan");
    assert.equal(scanned.stats.constraints.audio, false);
    assert.equal(scanned.stats.constraints.video.facingMode.ideal, "environment");
    assert.equal(scanned.doc.querySelector("#receiptBackdrop").classList.contains("open"), false, "scanning does not auto-charge / complete a sale");
    console.log("✓ rear-camera scan uses existing stock reservation and current-price cart; one scan, no automatic payment");
  } finally { scanned.close(); }

  const fallback = await cameraFixture();
  try {
    let decoderStops = 0;
    fallback.win.ZXingBrowser = {
      BarcodeFormat: { CODE_128: 1 },
      BrowserMultiFormatReader: class {
        async decodeFromVideoElement(video, callback) {
          assert.equal(video.srcObject, fallback.stream);
          callback({ getText: () => PRODUCT.barcode_id }); callback({ getText: () => PRODUCT.barcode_id });
          return { stop: () => { decoderStops++; } };
        }
      }
    };
    fallback.doc.querySelector("#btnScanTag").click(); await settle();
    assert.equal(fallback.stats.holds, 1, "repeated decoder frames never double-add stock");
    assert.equal(fallback.stats.stopped, 1);
    assert.equal(decoderStops, 1);
    console.log("✓ bundled fallback decoder and duplicate-frame suppression work without BarcodeDetector");
  } finally { fallback.close(); }

  const denied = await cameraFixture();
  try {
    denied.win.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error("Denied"), { name: "NotAllowedError" }); };
    denied.doc.querySelector("#btnScanTag").click(); await settle();
    assert.match(denied.doc.querySelector("#cameraStatus").textContent, /permission was not granted/);
    assert.equal(denied.stats.holds, 0);
    assert(denied.doc.querySelector("#cameraPhotoInput[capture=environment]"));
    denied.doc.querySelector("#cameraManualCode").value = "UNKNOWN";
    denied.doc.querySelector("#cameraManualForm").dispatchEvent(new denied.win.Event("submit", { bubbles: true, cancelable: true })); await settle();
    assert.equal(denied.stats.holds, 0);
    assert.match(denied.doc.querySelector("#cameraStatus").textContent, /Could not add/);
    denied.doc.querySelector("#cameraManualCode").value = PRODUCT.sku;
    denied.doc.querySelector("#cameraManualForm").dispatchEvent(new denied.win.Event("submit", { bubbles: true, cancelable: true })); await settle();
    assert.equal(denied.stats.holds, 1);
    assert.equal(denied.doc.querySelector("#posCameraDialog"), null);
    console.log("✓ denied camera and unknown barcode errors stay useful; manual SKU fallback remains available");
  } finally { denied.close(); }

  const late = await cameraFixture();
  try {
    let resolve;
    late.win.navigator.mediaDevices.getUserMedia = () => new Promise(r => { resolve = r; });
    late.doc.querySelector("#btnScanTag").focus();
    late.doc.querySelector("#btnScanTag").click();
    assert(late.doc.querySelector("#posCameraDialog"));
    late.win.PosCamera.close(); resolve(late.stream); await settle();
    assert.equal(late.stats.stopped, 1, "camera resolved after cancellation is still released");
    assert.equal(late.stats.holds, 0);
    assert.equal(late.doc.querySelector("#btnScanTag"), late.doc.activeElement, "focus returns to trigger");
    console.log("✓ cancellation releases late camera streams and returns focus");
  } finally { late.close(); }

  for (const [code, stock] of [[PRODUCT.barcode_id, 0], ["ADN-000000", 1], ["ADONAI-SAMPLE", 1]]) {
    const f = await cameraFixture([{ ...PRODUCT, in_stock_count: stock }]);
    try {
      nativeDecoder(f, code); f.doc.querySelector("#btnScanTag").click(); await settle();
      assert.equal(f.stats.holds, 0);
      assert.equal(f.doc.querySelector("#sumItems").textContent, "0");
      assert(f.doc.querySelector("#posCameraDialog"));
    } finally { f.close(); }
  }
  console.log("✓ sold-out items and printer-test tags cannot enter a sale");

  const native = fixture("admin.html", [{ ...PRODUCT }]);
  try {
    let args;
    native.win.Android = { printTags: (...a) => { args = a; } };
    await native.win.GarmentTools.openTag(PRODUCT.id);
    native.doc.querySelector("#gtPrintButton").click();
    assert.equal(native.stats.prints, 0);
    assert.equal(args[1], "label");
    assert.match(args[0], /ADN-MEN-1002/);
    assert.doesNotMatch(args[0], /1OF1|UGX|pre.loved|one.of.one|sample|not for sale|printer test|no catalog item/i);
    assert(!/<script|javascript:/i.test(args[0]));
    assert.equal(native.doc.querySelector("#garmentPrintSheet"), null);
    console.log("✓ native print bridge receives a self-contained, script-free tag document");
  } finally { native.close(); }

  csstree.parse(source("css/garment-tools.css"));
  const server = source("serve.py");
  assert.match(server, /camera=\(self\), microphone=\(\)/);
  assert.match(server, /media-src 'self' blob:/);
  const java = source("android/app/src/main/java/com/adonaithrift/pos/MainActivity.java");
  assert.match(java, /onPermissionRequest\(PermissionRequest request\)/);
  assert.match(java, /isTrustedAppUri\(request.getOrigin\(\)\)/);
  assert.match(java, /requestPermissions/);
  assert.match(java, /setBlockNetworkLoads\(true\)/);
  assert.match(java, /setJavaScriptEnabled\(false\)/);
  assert(fs.statSync(path.join(ROOT, "js/vendor/zxing-browser.min.js")).size > 100000);
  console.log("✓ local decoder asset, CSS, HTTPS camera policy and native permission / print safety guards validate");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => dbDOM.window.close());
