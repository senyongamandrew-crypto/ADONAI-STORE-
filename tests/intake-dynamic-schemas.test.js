#!/usr/bin/env node
/* Schema-driven Catalog Intake (category_field_schemas).
 * With js/catalog-schemas.js loaded, Category + Sub-group resolve ONE form:
 * earrings get millimetre / gram inputs and earring photo angles (never
 * inches, garment sizes or fabric), pre-loved shoes get inspection points,
 * required details block the save, hidden fields never leak into the saved
 * product, and server field errors are pinned to the exact inputs.
 * Run: node tests/intake-dynamic-schemas.test.js
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
let rejectNext = null;
let schemaFetches = 0;
let updatedPatch = null;
const PRODUCTS = {
  "PRD-EAR-1": {
    id: "PRD-EAR-1", name: "Sterling Studs", sku: "ADN-EAR-1", barcode_id: "ADN-EAR-1", brand: "Unbranded", color: "Silver",
    category: "Rings & Earrings", subcategory: "Stud Earrings", demographic: "Women", size: "-", condition: "Brand New with Tags (BNWT)",
    item_condition: "BRAND_NEW", cost_price: 9000, base_price: 25000, selling_price: 28500, total_transport_cost: 7000, compare_price: 0, in_stock_count: 3,
    fabric: "925 Sterling Silver", measurements: {}, images: [], search_tags: ["gift idea"], fulfillment_notes: "Boxed",
    attributes: { schema_key: "earrings", schema_version: 1, complete: true,
      values: { length: { value: 8, unit: "mm" }, primary_metal: "925 Sterling Silver", backing_type: "Lever-Back", nickel_free: true } }
  },
  "PRD-TEE-1": {
    id: "PRD-TEE-1", name: "Vintage Band Tee", sku: "ADN-TEE-1", barcode_id: "ADN-TEE-1-1OF1", brand: "Hanes", color: "Black",
    category: "Tops & Shirts", subcategory: "", demographic: "Men", size: "L", condition: "Grade A — Excellent",
    item_condition: "PRE_LOVED", cost_price: 5000, base_price: 30000, selling_price: 33500, total_transport_cost: 7000, compare_price: 0, in_stock_count: 1,
    fabric: "100% Cotton", measurements: { chest: 22, length: 28, notes: "Measured flat" }, images: [], search_tags: [], attributes: {}
  }
};

window.Auth = { guard: () => null, locked: () => false, suiteUnlocked: () => true, me: () => null, token: () => "", authHeaders: () => ({}), unlockSuite() {} };
window.DB = {
  DEMOGRAPHICS: ["Men", "Women", "Children", "Unisex"],
  CATEGORIES: ["Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories", "Children Wear", "Boots", "Sandals", "Activewear & Sportswear", "Suits & Formalwear", "Underwear & Sleepwear", "Bags & Handbags", "Necklaces & Chains", "Bracelets & Bangles", "Rings & Earrings", "Watches", "Eyewear & Sunglasses", "Hats, Scarves & Belts", "Traditional & Occasionwear", "Swimwear & Beachwear"],
  CONDITIONS: ["Brand New with Tags (BNWT)", "Grade A — Excellent", "Grade B — Good", "Vintage / Collector"],
  ROLE_LABELS: {},
  ugx: value => `UGX ${value}`,
  barcodeSVG: () => "",
  apiUrl: value => value,
  getSettings: () => ({ base_delivery_fee: 7000 }),
  listProducts: () => [], listSales: () => [], listStaff: () => [], listRiders: () => [], listLedger: () => [], listGuests: () => [],
  getProduct: id => (PRODUCTS[id] ? JSON.parse(JSON.stringify(PRODUCTS[id])) : null),
  updateProduct: async (id, patch) => { updatedPatch = { id, patch }; return Object.assign({}, PRODUCTS[id], patch); },
  on: () => {},
  financeRequest: async () => ({ stock_lots: [] }),
  consignmentRequest: async () => ({ partners: [] }),
  addProduct: async values => {
    if (rejectNext) { const error = rejectNext; rejectNext = null; throw error; }
    savedProduct = values;
    return { id: "PRD-TEST-1", name: values.name, sku: values.sku };
  }
};
window.Icons = { svg: () => "", icon: () => "" };
window.Intake = { compressImage: async () => "", imageFieldHTML: () => "" };
window.fetch = async url => {
  if (String(url).includes("/api/catalog/field-schemas")) schemaFetches += 1;
  return { ok: false, json: async () => ({}) };
};
window.HTMLCanvasElement.prototype.getContext = () => ({ scale() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} });
window.HTMLElement.prototype.scrollIntoView = function () {};

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const change = el => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const plain = value => JSON.parse(JSON.stringify(value)); // jsdom objects live in another realm
const input = el => el.dispatchEvent(new window.Event("input", { bubbles: true }));

async function main() {
  try {
    for (const file of ["js/garment-media.js", "js/catalog-schemas.data.js", "js/catalog-schemas.js", "js/audit-exports.js", "js/receipt-printing.js", "app.js"]) {
      window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
    }
    await pause();
    const doc = window.document;
    const $ = sel => doc.querySelector(sel);
    const field = key => $(`#intakeSpecs [data-csf-key="${key}"]`);
    const visible = key => !!field(key) && !field(key).hidden;
    const setValue = (key, value, unit) => {
      const wrap = field(key);
      const control = wrap.querySelector("[data-csf-input]");
      control.value = value; input(control); change(control);
      if (unit) { const unitEl = wrap.querySelector("[data-csf-unit], [data-csf-scale]"); unitEl.value = unit; change(unitEl); }
    };
    const save = async () => { savedProduct = null; $("#btnIntakeSave").click(); await pause(10); };

    assert.ok(window.CatalogSchemas && window.CatalogSchemas.document, "schema engine and bundled data load");
    assert.ok(schemaFetches >= 1, "intake refreshes schemas from GET /api/catalog/field-schemas");

    /* --- Earrings: mm / g only, no garment size, fabric or inch set --- */
    const cat = $("#inCat");
    cat.value = "Rings & Earrings"; change(cat);
    const sub = $("#inSubCat");
    assert.strictEqual($("#inSubCatRow").hidden, false, "the sub-group selector appears");
    assert.deepStrictEqual(Array.from(sub.options).map(o => o.value), ["Stud Earrings", "Hoop Earrings", "Dangle Earrings", "Rings"]);
    assert.strictEqual($("#intakeSpecsSection").hidden, false, "the specification section renders");
    assert.match($("#intakeSchemaBadge").textContent, /Earrings/);
    assert.match($("#intakeProfileHint").textContent, /No inches/i);
    const units = Array.from(doc.querySelectorAll("#intakeSpecs [data-csf-fixed-unit], #intakeSpecs [data-csf-unit] option")).map(el => el.dataset.csfFixedUnit || el.value);
    assert.ok(units.length && units.every(unit => unit === "mm" || unit === "g"), `earrings only use mm and g, got ${units}`);
    assert.strictEqual($("#inSize").closest(".field").hidden, true, "no garment size box on earrings");
    assert.strictEqual($("#inFabric").closest(".field").hidden, true, "no fabric box on earrings — metal projects into it");
    assert.strictEqual($("#inMeasureSetField").hidden, true, "legacy inch measurement set is hidden");
    assert.strictEqual($("#measureFields").hidden, true, "legacy inch inputs are hidden");
    assert.ok(visible("stud_depth"), "studs ask for stud depth");
    assert.strictEqual(doc.querySelectorAll("#intakePhotoProtocol [data-cpp-angle]").length, 4, "four earring photo angles");
    assert.match($("#intakePhotoProtocol").textContent, /Backing & post closure/);
    assert.match($("#intakePhotoProtocol").textContent, /0 \/ 3 required angles/);
    assert.match($("#intakeReadiness").textContent, /Category details 0\/4/);

    /* --- Required details block the save and are pinned to their inputs --- */
    $("#inTitle").value = "Sterling Lever-Back Studs";
    $("#inSell").value = "45000";
    await save();
    assert.strictEqual(savedProduct, null, "missing required earring details block intake");
    assert.match($("#toast").textContent, /Fix 4 category details/);
    assert.ok(field("primary_metal").classList.contains("csf-invalid"), "primary metal is flagged");
    assert.strictEqual(field("primary_metal").querySelector("[data-csf-error]").hidden, false);

    /* --- Stale-value guard: legacy inch inputs and hidden sub-group fields --- */
    const legacyInput = doc.querySelector("#measureFields [data-measure]");
    if (legacyInput) legacyInput.value = "42";
    setValue("stud_depth", "6");
    sub.value = "Dangle Earrings"; change(sub);
    assert.ok(!visible("stud_depth"), "dangles hide stud depth");
    sub.value = "Stud Earrings"; change(sub);
    assert.ok(visible("stud_depth"), "studs show stud depth again");

    setValue("length", "8");
    setValue("pair_weight", "1.8");
    setValue("primary_metal", "925 Sterling Silver");
    setValue("accent_material", "Cubic Zirconia");
    setValue("backing_type", "Lever-Back");
    setValue("nickel_free", "true");
    assert.match($("#intakeSpecsProgress").textContent, /4 \/ 4 required/);
    assert.match($("#inSearchTags").value, /nickel-free/, "search tags are generated from the attributes");
    assert.match($("#inSearchTags").value, /lever-back/);
    $("#inFulfillment").value = "Ships in a padded jewelry box";

    sub.value = "Dangle Earrings"; change(sub); // stud depth now hidden with a value inside
    await save();
    assert.ok(savedProduct, "a complete earring saves");
    assert.strictEqual(savedProduct.subcategory, "Dangle Earrings");
    assert.strictEqual(savedProduct.attributes.schema_key, "earrings");
    assert.deepStrictEqual(plain(savedProduct.attributes.values.length), { value: 8, unit: "mm" });
    assert.strictEqual(savedProduct.attributes.values.nickel_free, true);
    assert.ok(!("stud_depth" in savedProduct.attributes.values), "hidden stud depth never leaks onto a dangle");
    assert.deepStrictEqual(plain(savedProduct.measurements), {}, "hidden legacy inch inputs never leak onto jewelry");
    assert.strictEqual(savedProduct.size, "-", "no garment size on earrings");
    assert.strictEqual(savedProduct.fabric, "925 Sterling Silver · Cubic Zirconia", "metal projects into the material column");
    assert.ok(savedProduct.search_tags.includes("nickel-free"));
    assert.strictEqual(savedProduct.fulfillment_notes, "Ships in a padded jewelry box");
    assert.ok(savedProduct.attributes.photo_angles && typeof savedProduct.attributes.photo_angles === "object");

    /* --- Brand shortcuts --- */
    doc.querySelector('[data-brand-preset="Custom / Handmade"]').click();
    assert.strictEqual($("#inBrand").value, "Custom / Handmade");
    assert.match($("#inSearchTags").value, /custom \/ handmade/);

    /* --- Server field errors map back to inputs --- */
    const serverError = new Error("Fix 1 category detail: Length must be between 0.5 and 150 mm");
    serverError.data = { field_errors: { length: "Length must be between 0.5 and 150 mm" } };
    rejectNext = serverError;
    await save();
    assert.ok(field("length").classList.contains("csf-invalid"), "server field errors flag the exact input");
    assert.match(field("length").textContent, /between 0.5 and 150 mm/);

    /* --- Tops: in/cm units, pit-to-pit required for pre-loved only --- */
    cat.value = "Tops & Shirts"; change(cat);
    assert.ok(visible("chest") && visible("knit_weave") && visible("hand_feel"));
    const chestUnits = Array.from(field("chest").querySelectorAll("[data-csf-unit] option")).map(o => o.value);
    assert.deepStrictEqual(chestUnits, ["in", "cm"], "garment measurements offer inches and centimetres");
    assert.strictEqual(field("chest").querySelector("[data-csf-req]").hidden, true, "brand-new tops do not require pit-to-pit");
    doc.querySelector('[data-intake-condition="PRE_LOVED"]').click();
    assert.strictEqual(field("chest").querySelector("[data-csf-req]").hidden, false, "pre-loved tops require pit-to-pit");
    assert.strictEqual($("#inSize").closest(".field").hidden, false, "tops keep the tagged size box");
    assert.strictEqual($("#inFabric").closest(".field").hidden, true, "material composition replaces the free fabric box");
    $("#inTitle").value = "Heavyweight Boxy Tee";
    $("#inSize").value = "L";
    setValue("chest", "56", "cm");
    setValue("length", "70", "cm");
    setValue("material_composition", "100% Heavyweight Cotton");
    await save();
    assert.ok(savedProduct, "a complete pre-loved tee saves");
    assert.deepStrictEqual(plain(savedProduct.attributes.values.chest), { value: 56, unit: "cm" });
    assert.strictEqual(savedProduct.size, "L");

    /* --- Boots: inspection only for pre-loved, shaft height for boots --- */
    cat.value = "Boots"; change(cat);
    sub.value = "Chelsea Boots"; change(sub);
    assert.ok(visible("shaft_height") && visible("ankle_opening"), "boots ask for shaft height and ankle opening");
    assert.strictEqual($("#intakeSpecs [data-csf-inspection]").hidden, false, "pre-loved shoes get inspection points");
    assert.strictEqual(doc.querySelectorAll("#intakeSpecs [data-csf-point]").length, 4);
    assert.strictEqual(doc.querySelectorAll("#intakePhotoProtocol [data-cpp-angle]").length, 5, "five footwear angles");
    doc.querySelector('[data-intake-condition="BRAND_NEW"]').click();
    assert.strictEqual($("#intakeSpecs [data-csf-inspection]").hidden, true, "brand-new shoes skip wear inspection");
    assert.ok(!visible("insole_length") || field("insole_length").querySelector("[data-csf-req]").hidden, "insole only required for pre-loved");

    /* --- Children Wear › Kids Shoes takes the footwear base profile --- */
    cat.value = "Children Wear"; change(cat);
    sub.value = "Kids Shoes"; change(sub);
    assert.match($("#intakeSchemaBadge").textContent, /Shoes, Boots & Sandals/);
    assert.strictEqual($("#inFabricNotesField").hidden, true, "kids shoes use the footwear profile — no garment fabric grading");
    assert.match(doc.querySelector('[data-intake-condition="BRAND_NEW"]').textContent, /Footwear/, "toggle wording follows the footwear profile");

    /* --- Bags: clutches hide strap drop and padding --- */
    cat.value = "Bags & Handbags"; change(cat);
    sub.value = "Backpacks"; change(sub);
    assert.ok(visible("capacity") && visible("laptop_sleeve") && visible("strap_padding"));
    sub.value = "Clutches & Evening Bags"; change(sub);
    assert.ok(!visible("strap_drop") && !visible("strap_padding") && !visible("capacity"), "clutches skip straps and litres");

    /* --- Edit modal: complete records stay complete --- */
    const openEditor = async id => {
      const trigger = doc.createElement("button");
      trigger.dataset.editprod = id;
      doc.body.appendChild(trigger);
      trigger.click();
      await pause(5);
      trigger.remove();
    };
    const modalField = key => doc.querySelector(`#mpSpecs [data-csf-key="${key}"]`);
    await openEditor("PRD-EAR-1");
    assert.strictEqual($("#mpSpecsSection").hidden, false, "the edit modal renders the earring form");
    assert.strictEqual($("#mpSubCat").value, "Stud Earrings");
    assert.strictEqual(modalField("length").querySelector("[data-csf-input]").value, "8", "stored attributes prefill the form");
    assert.strictEqual(modalField("backing_type").querySelector("[data-csf-input]").value, "Lever-Back");
    assert.strictEqual($("#mpSize").closest(".field").hidden, true, "no garment size box on earrings in the editor");
    assert.strictEqual($("#mpMeasure").closest(".field").hidden, true, "no inch flat-lay text on earrings in the editor");
    assert.strictEqual($("#mpSearchTags").value, "gift idea");
    const metal = modalField("primary_metal").querySelector("[data-csf-input]");
    metal.value = ""; change(metal);
    updatedPatch = null;
    doc.querySelector("[data-save-prod]").click();
    await pause(10);
    assert.strictEqual(updatedPatch, null, "a complete record cannot be saved with a required detail removed");
    assert.ok(modalField("primary_metal").classList.contains("csf-invalid"));
    metal.value = "Titanium"; change(metal);
    doc.querySelector("[data-save-prod]").click();
    await pause(10);
    assert.ok(updatedPatch, "the corrected record saves");
    assert.strictEqual(updatedPatch.patch.attributes.values.primary_metal, "Titanium");
    assert.strictEqual(updatedPatch.patch.subcategory, "Stud Earrings");
    assert.strictEqual(updatedPatch.patch.fabric, "Titanium", "material projection follows the edited metal");
    assert.strictEqual(updatedPatch.patch.size, "-");

    /* --- Edit modal: legacy garment prefilled from inches, gaps allowed --- */
    await openEditor("PRD-TEE-1");
    assert.strictEqual($("#mpSubCat").value, "T-Shirts", "a legacy record defaults to the first sub-group");
    const chest = modalField("chest");
    assert.strictEqual(chest.querySelector("[data-csf-input]").value, "22", "legacy inch flat-lay values prefill the form");
    assert.strictEqual(chest.querySelector("[data-csf-unit]").value, "in");
    assert.match($("#mpSpecsStatus").textContent, /gaps allowed/);
    updatedPatch = null;
    doc.querySelector("[data-save-prod]").click();
    await pause(10);
    assert.ok(updatedPatch, "older records save even with required details still missing");
    assert.deepStrictEqual(plain(updatedPatch.patch.attributes.values.chest), { value: 22, unit: "in" });
    assert.deepStrictEqual(plain(updatedPatch.patch.measurements), { chest: 22, length: 28, notes: "Measured flat" }, "the inch card keeps its values and note");
    assert.match($("#toast").textContent, /required category detail/, "staff are reminded about the gap");

    console.log("✓ edit modal keeps complete records complete and upgrades legacy garments from their inch measurements");
    console.log("✓ schema-driven intake renders only each sub-group's fields, units and angles");
    console.log("✓ required details block intake; hidden and legacy values never leak; server errors pin to inputs");
  } finally {
    window.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
