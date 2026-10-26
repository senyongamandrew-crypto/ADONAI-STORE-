#!/usr/bin/env node
/* Browser schema engine ↔ server engine parity.
 * tests/fixtures/catalog-schema-parity.json holds cases whose expected
 * results were produced by catalog_schemas.py (and are re-asserted by the
 * Python suite). js/catalog-schemas.js must reach the same values, errors,
 * projections, search tags and display rows, so what the intake form accepts
 * is exactly what the server stores. Also fails when the generated
 * js/catalog-schemas.data.js drifts from data/category_field_schemas.json.
 * Run: node tests/catalog-schemas-engine.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const generator = require(path.join(ROOT, "scripts", "build-catalog-schemas.js"));

/* 1. Generated bundle is current. */
const expectedBundle = generator.render(JSON.parse(fs.readFileSync(generator.source, "utf8")));
assert.strictEqual(fs.readFileSync(generator.target, "utf8"), expectedBundle, "js/catalog-schemas.data.js is stale — run npm run build:schemas");
console.log("✓ js/catalog-schemas.data.js matches data/category_field_schemas.json");

/* 2. Engine loads standalone (no DOM needed for the pure helpers). */
const sandbox = { window: {}, console };
sandbox.globalThis = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "js/catalog-schemas.data.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "js/catalog-schemas.js"), "utf8"), sandbox);
const CS = sandbox.window.CatalogSchemas;
assert.ok(CS && CS.document, "engine exposes window.CatalogSchemas with the bundled document");
assert.strictEqual(CS.source, "bundled");
const plain = value => JSON.parse(JSON.stringify(value));

/* 3. Parity cases. */
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/catalog-schema-parity.json"), "utf8"));
fixture.cases.forEach(testCase => {
  const resolved = CS.resolve(testCase.category, testCase.subcategory);
  assert.ok(resolved, `${testCase.name}: resolves a schema`);
  const ctx = { subcategory: resolved.subcategory, item_condition: testCase.item_condition };
  const result = CS.validate(resolved.schema, testCase.payload, ctx, { enforceRequired: true });
  const expected = testCase.expected;
  assert.strictEqual(result.ok, expected.ok, `${testCase.name}: ok flag`);
  assert.deepStrictEqual(plain(result.errors), expected.errors, `${testCase.name}: field errors`);
  if (!expected.ok) return;
  assert.deepStrictEqual(plain(result.values), expected.values, `${testCase.name}: normalized values`);
  assert.deepStrictEqual(plain(result.inspection), expected.inspection, `${testCase.name}: inspection`);
  assert.deepStrictEqual(plain(CS.project(resolved.schema, result.values)), expected.projections, `${testCase.name}: legacy projections`);
  const attributes = { schema_key: resolved.key, values: result.values, inspection: result.inspection };
  const tags = CS.autoTags({ category: testCase.category, subcategory: resolved.subcategory, brand: testCase.brand || "", color: testCase.color || "", item_condition: testCase.item_condition, attributes });
  assert.deepStrictEqual(plain(tags), expected.tags, `${testCase.name}: search tags`);
  assert.deepStrictEqual(plain(CS.specifications(attributes)), expected.specifications, `${testCase.name}: display rows`);
});
console.log(`✓ ${fixture.cases.length} parity cases: browser engine matches catalog_schemas.py`);

/* 4. Structural guarantees the UI relies on. */
const doc = CS.document;
Object.entries(doc.taxonomy).forEach(([category, entries]) => entries.forEach(([sub, key]) => {
  assert.ok(doc.schemas[key], `${category} › ${sub} points at an existing schema (${key})`);
}));
["earrings", "rings_bracelets", "necklaces"].forEach(key => {
  const schema = doc.schemas[key];
  const hidden = CS.hiddenCoreFields(schema);
  assert.ok(hidden.includes("size") && hidden.includes("fabric") && hidden.includes("measure_set"), `${key} hides garment size, fabric and inch set`);
  schema.sections.forEach(section => section.fields.forEach(field => {
    if (field.type === "measure" && key === "earrings") assert.ok(!field.units.includes("in"), "earrings never measured in inches");
  }));
});
const rings = doc.schemas.rings_bracelets;
const allFields = rings.sections.flatMap(section => section.fields);
assert.ok(!allFields.some(field => /fabric|texture|weave/i.test(field.key + field.label)), "metal rings never ask about fabric texture");
assert.strictEqual(CS.convert(10, "in", "cm"), 25.4);
assert.throws(() => CS.convert(1, "g", "mm"), /Cannot convert/);
assert.strictEqual(CS.formatValue({ type: "measure" }, { value: 18, unit: "in" }), "18 in (45.7 cm)");
assert.deepStrictEqual(plain(CS.cleanTags(" Gift Idea, studs ,gift idea,,")), ["gift idea", "studs"]);
const fallback = CS.resolve("Rings & Earrings", "Tiaras");
assert.strictEqual(fallback.subcategory, "Stud Earrings", "unknown sub-groups fall back to the first form in the browser");
assert.strictEqual(CS.resolve("Not a category", ""), null);
console.log("✓ taxonomy, hidden core fields, unit conversion and tag cleaning hold");

/* 5. Measurements are optional everywhere, and the digit box stays visible.
 * Dimensions used to block saving (required chest/length etc.) while the
 * global `.field select { width:100% }` squeezed the number input to a
 * sliver beside the unit dropdown. Pin both parts of the fix. */
Object.entries(doc.schemas).forEach(([key, schema]) => schema.sections.forEach(section => {
  assert.ok(!section.require_any, `${key}.${section.id} never demands a measurement`);
  section.fields.forEach(field => {
    if (field.type !== "measure") return;
    assert.ok(!field.required && !field.required_when, `${key}.${field.key} is an optional measurement`);
  });
}));
const schemaCss = fs.readFileSync(path.join(ROOT, "css/catalog-schemas.css"), "utf8");
assert.match(schemaCss, /\.csf-measure \.sel-full \{[^}]*width: auto/, "digit input escapes the global width:100% and takes the flexible space");
assert.match(schemaCss, /\.csf-measure \.csf-unit-select \{[^}]*width: auto/, "unit dropdown escapes width:100% so it cannot steal the row");
assert.match(schemaCss, /\.csf-convert \{/, "live converted value is styled under the input");
console.log("✓ measurements optional in every schema; digit input keeps the row, unit stays compact");
