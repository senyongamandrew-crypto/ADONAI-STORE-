#!/usr/bin/env node
/* Regression coverage for category-aware Catalog Intake profiles.
 * After staff pick the category group / category, the intake form must ask
 * only the details that belong to that kind of stock: a necklace never gets
 * S/M/L size variants, fabric composition or garment grading notes, while a
 * gown still gets the full garment set. Hidden fields must not leak stale
 * values into a saved product.
 * Run: node tests/intake-category-profiles.test.js
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

let savedProduct = null;

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
  CATEGORIES: ["Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories", "Children Wear", "Boots", "Sandals", "Activewear & Sportswear", "Suits & Formalwear", "Underwear & Sleepwear", "Bags & Handbags", "Necklaces & Chains", "Bracelets & Bangles", "Rings & Earrings", "Watches", "Eyewear & Sunglasses", "Hats, Scarves & Belts", "Traditional & Occasionwear", "Swimwear & Beachwear"],
  CONDITIONS: ["Brand New with Tags (BNWT)", "Grade A — Excellent", "Grade B — Good", "Vintage / Collector"],
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
  on: () => {},
  financeRequest: async pathName => {
    if (pathName !== "stock-lots") throw new Error(`Unexpected finance request: ${pathName}`);
    return { stock_lots: [] };
  },
  consignmentRequest: async pathName => {
    if (pathName !== "partners/choices") throw new Error(`Unexpected consignment request: ${pathName}`);
    return { partners: [] };
  },
  addProduct: async values => {
    savedProduct = values;
    return { id: "PRD-TEST-1", name: values.name, sku: values.sku };
  }
};
window.Icons = { svg: () => "", icon: () => "" };
window.Intake = { compressImage: async () => "", imageFieldHTML: () => "" };
window.fetch = async () => ({ ok: false, json: async () => ({}) });
window.HTMLCanvasElement.prototype.getContext = () => ({
  scale() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}
});

const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function change(window, select) {
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function options(select) {
  return Array.from(select.options).map(option => option.value || option.textContent);
}

function measureKeys(doc) {
  return Array.from(doc.querySelectorAll("#measureFields [data-measure]")).map(input => input.dataset.measure);
}

async function main() {
  try {
    window.eval(fs.readFileSync(path.join(ROOT, "js/garment-media.js"), "utf8"));
    window.eval(fs.readFileSync(path.join(ROOT, "js/audit-exports.js"), "utf8"));
    window.eval(fs.readFileSync(path.join(ROOT, "js/receipt-printing.js"), "utf8"));
    window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
    await pause();

    const doc = window.document;
    const cat = doc.querySelector("#inCat");
    const group = doc.querySelector("#inGroup");
    const cond = doc.querySelector("#inCond");
    const sizeLabel = () => doc.querySelector("#inSize").closest(".field").querySelector("label").textContent;
    const fabricLabel = () => doc.querySelector("#inFabric").closest(".field").querySelector("label").textContent;

    /* --- Default garment profile: full apparel detail capture --- */
    cat.value = "Outerwear & Jackets";
    change(window, cat);
    assert.match(doc.querySelector("#intakeProfileHint").textContent, /Garment/i, "garment profile should be announced");
    assert.strictEqual(doc.querySelector("#inSizeVariantsField").hidden, false, "brand-new apparel keeps size variants");
    assert.strictEqual(doc.querySelector("#inFabricNotesField").hidden, false, "apparel keeps fabric grading notes");
    assert.match(fabricLabel(), /Fabric & composition/, "apparel asks for fabric composition");
    assert.ok(options(cond).includes("Factory Fresh"), "apparel condition grades keep Factory Fresh");
    assert.ok(measureKeys(doc).includes("shoulder"), "apparel measurement set offers garment fields");

    /* --- Jewelry profile: no garment questions at all --- */
    cat.value = "Necklaces & Chains";
    change(window, cat);
    assert.strictEqual(group.value, "Jewelry", "category change keeps the group in sync");
    assert.match(doc.querySelector("#intakeProfileHint").textContent, /Jewelry/i, "jewelry profile should be announced");
    assert.strictEqual(doc.querySelector("#inSizeVariantsField").hidden, true, "necklaces never ask for S/M/L size variants");
    assert.strictEqual(doc.querySelector("#inFabricNotesField").hidden, true, "necklaces never ask for fabric grading notes");
    assert.strictEqual(doc.querySelector("#inMeasurementsField").hidden, true, "necklaces never ask for garment measurements");
    assert.strictEqual(doc.querySelector("#inCare").closest(".field").hidden, true, "necklaces do not ask for garment care instructions");
    assert.match(sizeLabel(), /Length \/ size/, "necklace size becomes length / size");
    assert.match(doc.querySelector("#inSize").placeholder, /18 in/, "necklace size placeholder explains lengths");
    assert.ok(options(doc.querySelector("#inSizePreset")).includes("One size"), "jewelry presets offer One size");
    assert.ok(!options(doc.querySelector("#inSizePreset")).includes("XS"), "jewelry presets never offer XS");
    assert.match(fabricLabel(), /Material \/ composition/, "jewelry asks for material, not fabric");
    assert.ok(options(cond).includes("Brand New with Tags (BNWT)"), "jewelry condition grades fit jewelry");
    assert.ok(!options(cond).includes("Factory Fresh"), "jewelry drops apparel-only Factory Fresh");
    const jewelryMeasures = measureKeys(doc);
    assert.ok(jewelryMeasures.includes("length") && jewelryMeasures.includes("pendant"), "necklaces measure chain length and pendant, not chest");
    assert.ok(!jewelryMeasures.includes("chest") && !jewelryMeasures.includes("insole"), "no garment or shoe measurements on a necklace");

    /* --- Rings size differently from chains --- */
    cat.value = "Rings & Earrings";
    change(window, cat);
    assert.match(sizeLabel(), /Ring/, "rings ask for ring size");
    assert.ok(options(doc.querySelector("#inSizePreset")).includes("7"), "ring size presets include ring sizes");

    /* --- Back to apparel: garment questions return --- */
    cat.value = "Dresses & Skirts";
    change(window, cat);
    assert.match(fabricLabel(), /Fabric & composition/, "dresses ask for fabric composition again");
    assert.strictEqual(doc.querySelector("#inFabricNotesField").hidden, false, "dresses keep fabric grading notes");
    assert.strictEqual(doc.querySelector("#inSizeVariantsField").hidden, false, "brand-new dresses keep size variants");
    assert.ok(options(cond).includes("Factory Fresh"), "apparel condition grades return");
    assert.ok(options(doc.querySelector("#inMeasureSet")).includes("top") && options(doc.querySelector("#inMeasureSet")).includes("bottom"), "apparel offers both garment measurement sets");
    assert.ok(measureKeys(doc).includes("shoulder"), "garment measurement fields return");

    /* --- Pre-loved garment quick measurements appear with garment wording --- */
    doc.querySelector('[data-intake-condition="PRE_LOVED"]').click();
    assert.strictEqual(doc.querySelector("#inMeasurementsField").hidden, false, "pre-loved garments log exact measurements");
    assert.match(doc.querySelector("#inMeasurementsField").querySelector("label").textContent, /garment/i, "quick measurements say garment for apparel");
    assert.strictEqual(doc.querySelector("#inSizeVariantsField").hidden, true, "pre-loved pieces stay 1-of-1 without size variants");
    assert.strictEqual(doc.querySelector("#inFactoryNotesField").hidden, true, "pre-loved pieces do not ask factory tag notes");

    /* --- Group shortcut shapes footwear the same way --- */
    group.value = "Footwear";
    change(window, group);
    assert.strictEqual(cat.value, "Shoes", "footwear group shortcut picks Shoes");
    assert.match(sizeLabel(), /Shoe size/, "shoes ask for shoe size");
    assert.strictEqual(doc.querySelector("#inMeasureSet").value, "other", "shoes switch to the footwear measurement set");
    assert.ok(measureKeys(doc).includes("insole"), "shoes measure insole and heel");
    assert.match(doc.querySelector("#inMeasurementsField").querySelector("label").textContent, /shoe/i, "quick measurements say shoe for footwear");
    assert.strictEqual(doc.querySelector("#inFabricNotesField").hidden, true, "shoes never ask for fabric grading notes");

    /* --- Brand-new watch: never S/M/L, jewelry-style conditions --- */
    doc.querySelector('[data-intake-condition="BRAND_NEW"]').click();
    cat.value = "Watches";
    change(window, cat);
    assert.strictEqual(doc.querySelector("#inSizeVariantsField").hidden, true, "watches never ask for S/M/L size variants");
    assert.ok(options(cond).includes("Brand New with Tags (BNWT)"), "watch condition grades fit watches");
    assert.ok(measureKeys(doc).includes("case_diameter"), "watches measure case diameter");

    /* --- Children sizing follows the target audience --- */
    cat.value = "Tops & Shirts";
    change(window, cat);
    doc.querySelector("#inDemo").value = "Children";
    change(window, doc.querySelector("#inDemo"));
    assert.ok(options(doc.querySelector("#inSizePreset")).includes("2y"), "children's apparel presets lead with age sizes");

    /* --- Hidden profile fields must not leak into the saved product --- */
    doc.querySelector("#inSizeVariants").value = "S, M, L";
    doc.querySelector("#inFabricNotes").value = "stale fabric note";
    doc.querySelector("#inFabric").value = "100% Cotton";
    cat.value = "Necklaces & Chains";
    change(window, cat);
    doc.querySelector("#inFabric").value = "Gold-plated brass"; // visible again — as Material
    doc.querySelector("#inTitle").value = "Gold Chain Necklace";
    doc.querySelector("#inSell").value = "45000";
    doc.querySelector("#btnIntakeSave").click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(savedProduct, "the save should reach the catalog");
    assert.strictEqual(savedProduct.name, "Gold Chain Necklace");
    assert.strictEqual(savedProduct.size_variants.length, 0, "hidden size variants are not saved on a necklace");
    assert.strictEqual(savedProduct.fabric_grading_notes, "", "hidden fabric grading notes are not saved on a necklace");
    assert.strictEqual(savedProduct.fabric, "Gold-plated brass", "the visible material field still saves on a necklace");

    console.log("✓ category-aware intake asks only the details each kind of stock needs");
  } finally {
    window.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
