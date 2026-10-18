#!/usr/bin/env node
"use strict";

/**
 * Product detail page — measurement disclosure.
 *
 * A piece whose measurements were never logged must NOT grow an empty
 * "Exact Flat-Lay Measurements" panel telling the shopper to message us on
 * WhatsApp. The card only appears when there are real numbers to show.
 *
 * Run: node tests/pdp-measurements.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

const productScript = read("js/product.js");
const productCss = read("css/product.css");

/* The panel and its copy are gone from the source entirely. */
assert.doesNotMatch(
  productScript,
  /Measurements for this piece are/,
  "the product page no longer offers an empty measurements panel"
);
assert.doesNotMatch(
  productScript,
  /measurements-card empty/,
  "the empty measurements card is gone"
);
assert.doesNotMatch(
  productCss,
  /measurements-card\.empty/,
  "the rule that styled the empty measurements card is gone"
);

/* The card itself is untouched for a piece that has measurements. */
assert.match(
  productScript,
  /<h4>Exact Flat-Lay Measurements<\/h4>/,
  "a piece with measurements still shows the flat-lay card"
);
assert.match(
  productScript,
  /if \(!rows\.length\) return "";/,
  "a piece without measurements shows no measurements card at all"
);

/* --- Behaviour, exercised for real in a DOM. ------------------------- */

function renderPdp(product) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(read("product.html"), {
    runScripts: "outside-only",
    url: "http://127.0.0.1/product/demo-piece-1",
    virtualConsole
  });
  const { window } = dom;
  window.fetch = async url => {
    if (String(url).includes("/api/products/")) {
      return new global.Response(JSON.stringify({ product }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    return new global.Response(JSON.stringify({ settings: {} }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  window.Response = global.Response;
  window.Headers = global.Headers;
  window.Request = global.Request;
  window.localStorage.setItem("adonai-consent-v1", "essential");
  window.scrollTo = () => {};
  for (const file of ["js/image-manifest.js", "js/product-kit.js", "js/db.js", "js/product.js"]) {
    window.eval(read(file));
  }
  return window;
}

const base = {
  id: "PRD-1", sku: "ADN-1", slug: "demo-piece-1", name: "Demo Piece",
  brand: "Adonai", color: "Brown", demographic: "Women", category: "Dresses & Skirts",
  size: "M", condition: "Grade A — Excellent", item_condition: "PRE_LOVED",
  in_stock_count: 1, selling_price: 75000, final_selling_price: 75000, compare_price: 0,
  image_url: "assets/products/p1002.jpg", images: [], video: null,
  desc: "", fabric: "", care_notes: "", flaw_notes: "", flaw_photo_index: -1,
  review_count: 0, average_rating: null, sales_count: 0, search_tags: [],
  attributes: {}, attribute_schema: "", specifications: [], photo_angle_labels: {}
};

(async () => {
  /* 1. No measurements logged → no measurements card at all. */
  const without = renderPdp(Object.assign({}, base, { measurements: {} }));
  await new Promise(r => setTimeout(r, 400));
  const withoutHtml = without.document.querySelector("#pdpGrid").innerHTML;
  assert.doesNotMatch(withoutHtml, /Exact Flat-Lay Measurements/,
    "a piece with no logged measurements shows no measurements card");
  assert.doesNotMatch(withoutHtml, /Measurements for this piece are/,
    "the 'measurements are not logged' copy is never rendered");
  assert.doesNotMatch(withoutHtml, /measurements-card/,
    "no measurements card markup is emitted at all");
  /* The rest of the page is untouched. */
  assert.match(withoutHtml, /flaw-callout/,
    "the flaw disclosure still renders alongside it");

  /* 2. Measurements logged → the card still renders with its numbers. */
  const withRows = renderPdp(Object.assign({}, base, {
    measurements: { shoulder: 18.5, chest: 22.0, length: 26.0 }
  }));
  await new Promise(r => setTimeout(r, 400));
  const withHtml = withRows.document.querySelector("#pdpGrid").innerHTML;
  assert.match(withHtml, /Exact Flat-Lay Measurements/,
    "a piece with logged measurements keeps the flat-lay card");
  assert.match(withHtml, /measure-row/,
    "the logged measurements are listed");

  console.log("✓ a piece with no logged measurements shows no measurements card");
  console.log("✓ a piece with logged measurements still shows the flat-lay card");
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
