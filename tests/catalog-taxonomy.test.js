#!/usr/bin/env node
/* Keep the shared fashion taxonomy consistent across intake, persistence,
 * storefront and cashier category filters. */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const db = read("js/db.js");
const admin = read("app.js");
const seed = read("db_init.py");
const pos = read("js/pos.js");
const storefront = read("js/storefront.js");
const posHtml = read("pos.html");
const api = read("api.py");
const adminHtml = read("admin.html");
const productHtml = read("product.html");

function expression(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} should be declared`);
  return vm.runInNewContext(`(${match[1]})`);
}

const categories = expression(db, /const CATEGORIES\s*=\s*(\[[\s\S]*?\]);/, "shared categories");
const codes = expression(db, /const CAT_CODES\s*=\s*(\{[\s\S]*?\});/, "category codes");
const groups = expression(admin, /const GROUPS\s*=\s*(\{[\s\S]*?\n  \});/, "intake groups");
const expected = [
  "Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Boots", "Sandals",
  "Activewear & Sportswear", "Suits & Formalwear", "Underwear & Sleepwear", "Bags & Handbags",
  "Necklaces & Chains", "Bracelets & Bangles", "Rings & Earrings", "Watches", "Eyewear & Sunglasses",
  "Hats, Scarves & Belts", "Traditional & Occasionwear", "Swimwear & Beachwear", "Accessories", "Children Wear"
];

for (const category of expected) {
  assert.ok(categories.includes(category), `shared taxonomy includes ${category}`);
  assert.ok(Object.hasOwn(codes, category), `${category} has a stable short code`);
  assert.ok(seed.includes(`("${category}"`), `${category} is seeded in the database`);
  const escaped = category.replaceAll("&", "&amp;");
  assert.ok(posHtml.includes(`data-cat="${escaped}"`), `${category} is present in the POS first-paint filters`);
}
assert.equal(new Set(Object.values(codes)).size, Object.values(codes).length, "category codes are unique");
const grouped = new Set(Object.values(groups).flat());
for (const category of categories) assert.ok(grouped.has(category), `${category} can be chosen through an intake group`);
assert.ok(pos.includes("DB.CATEGORIES.map(c => [c, c])"), "POS filters use the shared category list");
assert.ok(pos.includes("p.name, p.brand, p.category, p.desc"), "cashier search can find category and item-description terms");
assert.ok(storefront.includes("concat(DB.CATEGORIES)"), "storefront filters use the shared category list");
assert.ok(api.includes('clean_path == "/api/categories"'), "the public catalog category API exposes seeded categories");
/* Every interface loads db.js behind the same cache key: the key itself moves
 * whenever the file changes, so a pinned number would only have to be re-pinned
 * on every cache-bust — what actually matters is that no page is left serving an
 * older build than the others. */
function cacheKey(html, file) {
  const pattern = new RegExp(file.split(".").join("\\.") + "\\?v=([0-9][0-9.]*)");
  const match = html.match(pattern);
  assert.ok(match, `${file} is loaded with a cache key`);
  return match[1];
}
const indexHtml = read("index.html");
const dbKeys = [adminHtml, posHtml, productHtml, indexHtml].map(html => cacheKey(html, "js/db.js"));
assert.equal(new Set(dbKeys).size, 1, `every interface loads the same db.js build (${dbKeys.join(", ")})`);
assert.ok(adminHtml.includes("app.js?v="), "admin console loads the operations script behind a cache key");
assert.ok(posHtml.includes("js/pos.js?v="), "cashier loads the register script behind a cache key");
assert.ok(productHtml.includes("/js/product-kit.js?v="), "public product pages fetch the shared product kit");

console.log("✓ broad fashion categories stay consistent across intake, database, storefront and POS");
