#!/usr/bin/env node
/* Regression coverage for Catalog Intake's lot and graded-tier selections.
 * Background DB syncs fire every two seconds; they must not rebuild the form
 * or repeatedly fetch/repaint the stock-lot selector while staff are tagging.
 * Run: node tests/intake-lot-selection.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "admin.html"), "utf8"), {
  runScripts: "outside-only",
  url: "http://localhost/admin.html?view=intake",
  pretendToBeVisual: true
});
const { window } = dom;

let renderFromSync = null;
let stockLotRequests = 0;
const stockLots = [{
  id: "LOT-TEST-1",
  lot_code: "BALE-TEST-1",
  supplier: "Regression Supplier",
  remaining_count: 5,
  unit_cost: 12000,
  grades: [{
    id: "GRADE-TEST-1",
    grade_name: "Premium",
    remaining_count: 5,
    unit_cogs: 12000,
    target_selling_price: 30000
  }]
}];

window.Auth = {
  guard: () => null,
  locked: () => false,
  suiteUnlocked: () => true,
  me: () => null,
  token: () => "",
  authHeaders: () => ({}),
  unlockSuite() {}
};
window.DB = {
  DEMOGRAPHICS: ["Men", "Women", "Children", "Unisex"],
  CATEGORIES: ["Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories", "Children Wear"],
  CONDITIONS: ["Grade A — Excellent"],
  ROLE_LABELS: {},
  ugx: value => `UGX ${value}`,
  barcodeSVG: () => "",
  getSettings: () => ({ base_delivery_fee: 7000 }),
  listProducts: () => [],
  listSales: () => [],
  listStaff: () => [],
  listRiders: () => [],
  listLedger: () => [],
  listGuests: () => [],
  on: (_table, callback) => { renderFromSync = callback; },
  financeRequest: async pathName => {
    if (pathName !== "stock-lots") throw new Error(`Unexpected finance request: ${pathName}`);
    stockLotRequests++;
    return { stock_lots: stockLots };
  },
  addProduct: async values => ({ id: "PRD-TEST-1", name: values.name, sku: values.sku })
};
window.Icons = { svg: () => "", icon: () => "" };
window.Intake = { compressImage: async () => "", imageFieldHTML: () => "" };
window.setIntakeCondition = () => {};
window.intakeCondition = () => "BRAND_NEW";
window.fetch = async () => ({ ok: false, json: async () => ({}) });
window.HTMLCanvasElement.prototype.getContext = () => ({
  scale() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}
});

const pause = () => new Promise(resolve => setTimeout(resolve, 0));

async function main() {
  try {
    window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
    await pause();

    const doc = window.document;
    const lot = doc.querySelector("#inStockLot");
    const grade = doc.querySelector("#inLotGrade");
    assert.strictEqual(stockLotRequests, 1, "intake should fetch registered lots once on first open");
    assert.ok(Array.from(lot.options).some(option => option.value === "LOT-TEST-1"), "registered lot should be available");

    lot.value = "LOT-TEST-1";
    lot.dispatchEvent(new window.Event("change", { bubbles: true }));
    grade.value = "GRADE-TEST-1";
    grade.dispatchEvent(new window.Event("change", { bubbles: true }));
    doc.querySelector("#inDemo").value = "Women";
    doc.querySelector("#inCat").value = "Shoes";
    doc.querySelector("#inSku").value = "ADN-WOM-TEST";
    const cost = doc.querySelector("#inCost");
    const sell = doc.querySelector("#inSell");
    sell.value = "31500";
    sell.dispatchEvent(new window.Event("input", { bubbles: true }));

    // The production DB invokes this handler after each background sync.
    for (let i = 0; i < 4; i++) renderFromSync("*");
    await pause();
    assert.strictEqual(lot.value, "LOT-TEST-1", "background sync must not clear the selected lot");
    assert.strictEqual(grade.value, "GRADE-TEST-1", "background sync must not clear the selected grade tier");
    assert.strictEqual(doc.querySelector("#inDemo").value, "Women", "background sync must not reset form selections");
    assert.strictEqual(doc.querySelector("#inCat").value, "Shoes", "background sync must not reset the category");
    assert.strictEqual(doc.querySelector("#inSku").value, "ADN-WOM-TEST", "background sync must not roll the operator's SKU");
    assert.strictEqual(cost.value, "12000", "the locked tier COGS must stay applied");
    assert.strictEqual(sell.value, "31500", "background sync must not overwrite a deliberate retail price");
    assert.strictEqual(stockLotRequests, 1, "background sync must not refetch/rebuild the lot selector");

    // A deliberate product save refreshes lot availability; a still-valid
    // lot/tier selection must survive that refresh as well.
    doc.querySelector("#inTitle").value = "Regression Test Piece";
    doc.querySelector("#btnIntakeSave").click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(lot.value, "LOT-TEST-1", "a successful save refresh must retain an available lot");
    assert.strictEqual(grade.value, "GRADE-TEST-1", "a successful save refresh must retain an available tier");
    assert.strictEqual(cost.value, "12000", "a successful save refresh must keep the locked tier COGS");
    assert.strictEqual(sell.value, "31500", "a successful save refresh must keep the deliberate retail price");
    assert.strictEqual(stockLotRequests, 2, "saving should perform one intentional lot refresh");

    console.log("✓ intake lot and tier choices survive background sync and explicit refresh");
  } finally {
    window.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
