#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const OFFICIAL_EMAIL = "info@adonaithrift-store.online";

const homepage = read("index.html");
const productPage = read("product.html");
const storefront = read("js/storefront.js");
const productScript = read("js/product.js");
const db = read("js/db.js");
const api = read("api.py");
const dbInit = read("db_init.py");
const terms = read("terms-and-conditions.html");
const returns = read("return-policy.html");
const privacy = read("privacy-policy.html");
const routes = read("serve.py");

for (const [name, html] of [["homepage", homepage], ["product page", productPage]]) {
  assert.match(html, /href="\/terms-and-conditions"/, `${name} links to Terms & Conditions`);
  assert.match(html, /href="\/return-policy"/, `${name} links to the return policy`);
  assert.match(html, /href="\/privacy-policy"/, `${name} links to the Privacy Policy`);
}

const kitContext = { window: {} };
vm.runInNewContext(read("js/product-kit.js"), kitContext, { filename: "js/product-kit.js" });
const storeEmail = kitContext.window.AdonaiPDP.storeEmail;
const deliveryZones = kitContext.window.AdonaiPDP.DELIVERY_ZONES;
assert.equal(storeEmail({ email: "adonaithriftstore@gmail.com" }), OFFICIAL_EMAIL, "legacy Gmail is replaced by the official domain email");
assert.match(deliveryZones.find(zone => zone.id === "upcountry").eta, /1–3 business days after dispatch/, "product delivery estimates match the regional terms");
assert.match(deliveryZones.find(zone => zone.id === "pickup").eta, /Ready after store confirmation/, "pickup estimate avoids promising an unsupported one-hour handoff");
assert.equal(storeEmail({ email: "  " }), OFFICIAL_EMAIL, "missing email falls back to the official address");
assert.equal(storeEmail({ email: OFFICIAL_EMAIL }), OFFICIAL_EMAIL, "official email is retained");
assert.equal(storeEmail({ email: "help@another-domain.example" }), "help@another-domain.example", "a non-legacy configured contact remains configurable");
assert.match(homepage, /mailto:info@adonaithrift-store\.online/, "homepage includes a no-JavaScript official email fallback");
assert.match(productPage, /mailto:info@adonaithrift-store\.online/, "product page includes a no-JavaScript official email fallback");
assert.match(storefront, /PK\.storeEmail\(S\)/, "storefront footer uses the shared email resolver");
assert.match(productScript, /K\.storeEmail\(settings\)/, "product footer uses the shared email resolver");
assert.match(storefront, /mailto:\$\{esc\(email\)\}/, "storefront email link uses the displayed email");
assert.match(productScript, /mailto:\$\{esc\(email\)\}/, "product footer email link uses the displayed email");
assert.match(db, /email: OFFICIAL_STORE_EMAIL/, "local database seed uses the official email");
assert.match(dbInit, /"email": "info@adonaithrift-store\.online"/, "server database seed uses the official email");
assert.match(dbInit, /existing\.value = v/, "server boot migrates the legacy email in existing settings");
assert.match(api, /LEGACY_STORE_EMAILS/, "API normalizes the retired email in public settings and writes");
assert.match(read("admin.html"), /info@adonaithrift-store\.online/, "admin email hint uses the official domain");

assert.match(returns, /48 hours from receipt/i, "return policy measures the window from receipt");
assert.match(returns, /item is defective/i, "return policy covers defects");
assert.match(returns, /materially incorrectly graded/i, "return policy covers grading errors");
assert.match(returns, /store credit/i, "return policy explains store-credit conditions");
assert.match(returns, /refunded in cash/i, "return policy explains cash refunds");
assert.match(returns, /Plot 45 Salama Road \/ Kibuli/i, "return policy gives the physical handoff location");
assert.match(terms, /Card and supported mobile wallets/i, "terms list card and wallet payment");
assert.match(terms, /Mobile Money/i, "terms list Mobile Money");
assert.match(terms, /Bank transfer/i, "terms list bank transfer");
assert.match(terms, /merchant pay code/i, "terms list merchant pay codes");
assert.match(terms, /targeted for same-day delivery/i, "terms specify a Kampala fulfillment target");
assert.match(terms, /1–3 business days/i, "terms specify a regional fulfillment target");
assert.match(terms, /before dispatch/i, "terms explain order cancellation timing");
assert.match(privacy, /browsing and session data/i, "privacy policy covers browsing and session data");
assert.match(privacy, /temporary reservation\/session token/i, "privacy policy names first-party browser state");
assert.match(privacy, /mailto:info@adonaithrift-store\.online/, "privacy contacts use the official email");
assert.match(routes, /"\/return-policy": "return-policy\.html"/, "return policy has a clean server route");
assert.match(routes, /"\/return-policy"/, "return policy is included in the generated sitemap paths");
assert.match(read("sitemap.xml"), /<loc>https:\/\/www\.adonaithrift-store\.online\/return-policy<\/loc>/, "static sitemap contains the return policy");
assert.match(read("robots.txt"), /Allow: \/return-policy/, "robots file allows policy indexing");
assert.match(storefront, /href="\/terms-and-conditions"/, "checkout provides Terms links");
assert.match(storefront, /href="\/return-policy"/, "checkout provides a direct return-policy link");
assert.match(storefront, /href="\/privacy-policy"/, "checkout provides a privacy link");
assert.match(storefront, /within 48 hours of receipt for defective or incorrectly graded items/i, "checkout surfaces the return eligibility summary");
assert.doesNotMatch(storefront, /Full store policies publish with the live site/, "policy links are not replaced by a dead-end toast");

console.log("✓ storefront contact email, policy routes, disclosures, and checkout links are consistent");
