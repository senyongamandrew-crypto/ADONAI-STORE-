#!/usr/bin/env node
"use strict";

/**
 * Storefront load-performance regressions.
 *
 * The rail used to be slow to show its cards and slow to load their photos.
 * Three things caused it, and each one has a guard here:
 *
 *   1. The 40x40 photo-count dots pointed at the full-resolution master
 *      JPEG, so four dots on one card pulled about a megabyte.
 *   2. Every card photo was lazy-loaded, so the photos a shopper actually
 *      sees on arrival waited behind the whole catalog.
 *   3. The whole rail was one giant innerHTML string, so nothing could
 *      paint until the entire catalog had been built.
 *
 * Run: node tests/storefront-performance.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

/* The image manifest is a generated script, not a JSON file. */
function readManifest() {
  const context = { window: {} };
  vm.runInNewContext(read("js/image-manifest.js"), context, { filename: "js/image-manifest.js" });
  return context.window.ADONAI_IMAGE_MANIFEST || {};
}

const homepage = read("index.html");
const storefront = read("js/storefront.js");
const productKit = read("js/product-kit.js");
const db = read("js/db.js");
const serve = read("serve.py");
const api = read("api.py");
const media = read("media.py");
const accessControl = read("access_control.py");
const manifest = readManifest();

/* ------------------------------------------------------------------ *
 * 1. The photo-count dots must use the tiny derivative.
 * ------------------------------------------------------------------ */
assert.match(
  storefront,
  /PK\.thumbSrc\(src\)/,
  "the photo-count dots resolve their source through the thumbnail helper"
);
assert.doesNotMatch(
  storefront,
  /data-angle="\$\{i\}"\"><img src="\$\{esc\(PK\.resolveSrc\(src\)\)\}"/,
  "the photo-count dots no longer point at the full-resolution master"
);
assert.match(
  productKit,
  /function thumbSrc\(src\)/,
  "the shared kit exposes a thumbnail resolver"
);
assert.match(
  productKit,
  /entry\.thumb\)/,
  "the thumbnail resolver prefers the recorded tiny derivative"
);

/* Every catalog photo must actually have a tiny derivative on disk, and it
   must be dramatically smaller than the master it stands in for. */
const photoEntries = Object.entries(manifest).filter(([key]) => key.startsWith("assets/"));
assert.ok(photoEntries.length > 0, "the image manifest records the bundled artwork");
for (const [key, entry] of photoEntries) {
  assert.ok(entry.thumb, `${key} records a thumbnail derivative`);
  const thumbPath = path.join(ROOT, entry.thumb);
  assert.ok(fs.existsSync(thumbPath), `${entry.thumb} exists on disk`);
  const masterPath = path.join(ROOT, key);
  if (!fs.existsSync(masterPath)) continue;
  const thumbBytes = fs.statSync(thumbPath).size;
  const masterBytes = fs.statSync(masterPath).size;
  assert.ok(
    thumbBytes * 5 < masterBytes,
    `${entry.thumb} (${thumbBytes} bytes) is far smaller than ${key} (${masterBytes} bytes)`
  );
}

/* The four angles of the multi-photo demo piece are the worst case: they
   used to cost about a megabyte as four dots on a single card. */
const multiAngle = manifest["assets/products/p1001.jpg"];
if (multiAngle) {
  const dots = ["assets/products/p1001.jpg", "assets/products/p1001-back.jpg",
                "assets/products/p1001-fabric.jpg", "assets/products/p1001-flaw.jpg"];
  const dotBytes = dots.reduce((total, file) => {
    const entry = manifest[file];
    return total + (entry && fs.existsSync(path.join(ROOT, entry.thumb))
      ? fs.statSync(path.join(ROOT, entry.thumb)).size
      : 0);
  }, 0);
  assert.ok(dotBytes > 0, "the multi-angle piece has measurable dot weight");
  assert.ok(
    dotBytes < 60 * 1024,
    `the four photo dots weigh ${Math.round(dotBytes / 1024)} KB — well under the 60 KB budget`
  );
}

/* ------------------------------------------------------------------ *
 * 2. The photos a shopper sees on arrival must not be lazy.
 * ------------------------------------------------------------------ */
assert.match(
  storefront,
  /const EAGER_CARD_COUNT = \d+/,
  "the storefront declares how many cards load their photo immediately"
);
assert.match(
  productKit,
  /const loading = opts\.eager \? "eager" : "lazy"/,
  "the shared kit can mark a photo eager"
);
assert.match(
  productKit,
  /const fetchPriority = opts\.priority \? "high" : "auto"/,
  "the largest-content photo asks for high priority"
);
assert.match(
  storefront,
  /eager: eager,\s*\n\s*priority: index === 0/,
  "the first cards load eagerly and only the very first asks for priority"
);

/* ------------------------------------------------------------------ *
 * 3. The rail must paint in batches, not in one giant string.
 * ------------------------------------------------------------------ */
assert.match(
  storefront,
  /const GRID_CHUNK = \d+/,
  "the rail is drawn in batches"
);
assert.match(
  storefront,
  /grid\.insertAdjacentHTML\("beforeend"/,
  "the rail appends each batch instead of replacing the grid in one go"
);
assert.doesNotMatch(
  storefront,
  /grid\.innerHTML = list\.map\(cardHTML\)\.join\(""\)/,
  "the rail no longer builds the whole catalog as a single HTML string"
);
assert.match(
  storefront,
  /if \(token !== gridRenderToken\) return;/,
  "a newer render abandons the batches still queued"
);

/* ------------------------------------------------------------------ *
 * 4. The rail must never look empty while the catalog is in flight.
 * ------------------------------------------------------------------ */
assert.match(
  homepage,
  /id="productGrid"[^>]*aria-busy="true"/,
  "the rail ships a busy placeholder grid in the HTML itself"
);
assert.ok(
  (homepage.match(/pcard--skeleton/g) || []).length >= 2,
  "the HTML carries placeholder cards that paint before any script runs"
);
assert.match(
  read("css/storefront.css"),
  /\.pcard--skeleton/,
  "the placeholder cards are styled"
);
assert.match(
  storefront,
  /const stillLoading = /,
  "the storefront knows the difference between an empty rail and a loading one"
);
assert.match(
  db,
  /productsSynced: \(\) => productsSynced/,
  "the data layer reports when the catalog has answered"
);
assert.match(
  storefront,
  /railLoadTimedOut/,
  "the placeholder cannot stay on screen forever"
);

/* ------------------------------------------------------------------ *
 * 5. A photo held by the media API must ship a responsive srcset.
 * ------------------------------------------------------------------ */
assert.match(
  productKit,
  /const MEDIA_API_URL = /,
  "the shared kit recognises media API photos"
);
assert.match(
  productKit,
  /srcset="\$\{mediaApiSrcset\(resolved\)\}"/,
  "a media API photo is delivered with a responsive srcset"
);
assert.match(
  productKit,
  /mediaApiUrl\(resolveSrc\(value\), 96\)/,
  "a media API thumbnail asks the server for a 96px re-encode"
);
assert.match(
  media,
  /def build_derivative\(source_bytes, width\)/,
  "the media API can re-encode a stored photo"
);
assert.match(
  media,
  /MEDIA_WIDTHS = \(96, 320, 480, 640, 960\)/,
  "the media API publishes the widths the storefront asks for"
);
assert.match(
  media,
  /never upscale/i,
  "the media API never upscales a photo"
);

/* ------------------------------------------------------------------ *
 * 6. The catalog payload must be compressed on the wire.
 * ------------------------------------------------------------------ */
assert.match(
  serve,
  /def compress_api_body\(/,
  "the server can compress an API response"
);
assert.match(
  serve,
  /"Content-Encoding", "gzip"/,
  "a compressed API response is labelled as gzip"
);
assert.match(
  serve,
  /"content-length"/,
  "the uncompressed length is replaced so exactly one Content-Length is sent"
);
assert.ok(
  (serve.match(/compress_api_body\(/g) || []).length >= 3,
  "both the WSGI and the standalone server paths compress API responses"
);

/* ------------------------------------------------------------------ *
 * 7. The public channel must not publish internal costing.
 * ------------------------------------------------------------------ */
assert.match(
  accessControl,
  /def sanitize_storefront_product\(data\)/,
  "the public product channel has its own scrub"
);
assert.match(
  accessControl,
  /"cost_price"/,
  "the public channel drops the cost price"
);
assert.match(
  accessControl,
  /"staff_notes"/,
  "the public channel drops staff notes"
);
assert.match(
  api,
  /sanitize_storefront_product\(data\)/,
  "the public product list uses the public scrub"
);

/* ------------------------------------------------------------------ *
 * 8. Card photos must arrive fast and never look broken.
 *
 * The production rail sat blank for three compounding reasons: the
 * resized copies were encoded inside the shopper's own request (and
 * forgotten at every restart), `sizes` overstated the card so phones
 * downloaded the largest candidate, and a still-travelling photo
 * rendered as an empty frame with raw alt text.
 * ------------------------------------------------------------------ */
assert.match(
  media,
  /_store_derivatives\(session, asset\.id, derivatives\)/,
  "an upload stores its responsive copies with the master — no shopper waits for an encode"
);
assert.match(
  media,
  /_stored_derivative\(session, asset\.id, width\)/,
  "a sized request is served from the durable copy, not a fresh encode"
);
assert.match(
  read("models.py"),
  /class ProductMediaDerivative/,
  "the durable derivative store exists"
);
assert.match(
  storefront,
  /sizes: "\(min-width: 1280px\) 300px, \(min-width: 900px\) 30vw, \(min-width: 641px\) 45vw, 50vw"/,
  "card sizes describe the two-column phone rail the grid actually lays out"
);
assert.doesNotMatch(
  storefront,
  /45vw, 90vw"/,
  "sizes no longer tells a phone the card photo is nearly screen-wide"
);
assert.match(
  storefront,
  /fetchpriority="low"/,
  "the photo-count dots never compete with the card photos"
);
assert.match(
  storefront,
  /lastGridSignature/,
  "an unchanged live sync leaves the rendered cards (and their loading photos) alone"
);
assert.match(
  productKit,
  /MEDIA_API_WIDTHS = \[320, 480, 640, 960\]/,
  "the srcset offers the 480w candidate the two-column phone rail needs"
);
assert.match(
  productKit,
  /function settleImages\(root\)/,
  "the shared kit can mark landed photos"
);
assert.match(
  productKit,
  /dataset\.masterRetry/,
  "a failed resized candidate retries once against the master before giving up"
);
{
  const storefrontCss = read("css/storefront.css");
  assert.match(
    storefrontCss,
    /\.pmedia img \{\s*width: 100%; height: 100%;\s*\/\* contain, not cover/,
    "card photos fit the whole piece in frame instead of cropping it"
  );
  assert.match(
    storefrontCss,
    /\.pmedia > img\.is-loaded/,
    "a landed card photo fades in over its placeholder"
  );
}

/* ------------------------------------------------------------------ *
 * 9. The behaviour, exercised for real in a DOM.
 * ------------------------------------------------------------------ */
function renderStorefront(products, options = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(homepage, {
    runScripts: "outside-only",
    url: "http://127.0.0.1/",
    virtualConsole
  });
  const { window } = dom;
  window.__ADONAI_STOREFRONT__ = true;
  window.fetch = async url => {
    if (String(url).includes("/api/products")) {
      return new global.Response(JSON.stringify({ products }), {
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
  for (const file of ["js/image-manifest.js", "js/product-kit.js", "js/db.js", "js/storefront.js"]) {
    window.eval(read(file));
  }
  return { window, dom, options };
}

const demoProducts = [{
  id: "PRD-1", sku: "ADN-1", slug: "denim-jacket-aden-1", name: "Denim Jacket",
  brand: "Levi's", color: "Indigo", demographic: "Men", category: "Outerwear & Jackets",
  subcategory: "", size: "L", condition: "Grade A — Excellent", item_condition: "PRE_LOVED",
  in_stock_count: 1, selling_price: 68000, final_selling_price: 68000, compare_price: 120000,
  image_url: "assets/products/p1001.jpg",
  images: ["assets/products/p1001.jpg", "assets/products/p1001-back.jpg",
           "assets/products/p1001-fabric.jpg", "assets/products/p1001-flaw.jpg"],
  measurements: {}, review_count: 0, average_rating: null, sales_count: 0,
  desc: "", search_tags: [], attributes: {}, specifications: [], photo_angle_labels: {}
}];

(async () => {
  const { window } = renderStorefront(demoProducts);
  await new Promise(r => setTimeout(r, 500));
  const grid = window.document.querySelector("#productGrid");
  const cards = grid.querySelectorAll("article.pcard");
  assert.equal(cards.length, 1, "the card is rendered");

  const dot = grid.querySelector(".media-dots img");
  assert.ok(dot, "the multi-angle card shows its photo-count dots");
  assert.match(dot.getAttribute("src"), /-96\.webp$/,
    "a photo-count dot loads the 96px derivative");
  assert.doesNotMatch(dot.getAttribute("src"), /p1001\.jpg$/,
    "a photo-count dot never loads the full-resolution master");

  const main = grid.querySelector(".pmedia img");
  assert.equal(main.getAttribute("loading"), "eager",
    "the first card's photo loads immediately");
  assert.equal(main.getAttribute("fetchpriority"), "high",
    "the first card's photo asks for high priority");
  assert.ok(grid.querySelector("picture source[type='image/webp']"),
    "the first card's photo ships a responsive WebP srcset");

  assert.equal(grid.querySelectorAll(".pcard--skeleton").length, 0,
    "the placeholder cards are gone once the catalog has arrived");
  assert.equal(grid.getAttribute("aria-busy"), null,
    "the rail is no longer marked busy");

  main.dispatchEvent(new window.Event("load"));
  assert.ok(main.classList.contains("is-loaded"),
    "a landed photo is marked so CSS can fade it in over the placeholder");

  /* A POS-uploaded photo (the production path) ships the candidates a
     two-column phone rail needs, and a failed candidate falls back to
     the master — never to a blank frame. */
  const mediaUrl = "/api/media/" + "a".repeat(32);
  const mediaProducts = [{
    ...demoProducts[0],
    id: "PRD-2", sku: "ADN-2", slug: "uploaded-piece-adn-2", name: "Uploaded Piece",
    image_url: mediaUrl,
    images: [mediaUrl, "/api/media/" + "b".repeat(32)]
  }];
  const second = renderStorefront(mediaProducts);
  await new Promise(r => setTimeout(r, 500));
  const grid2 = second.window.document.querySelector("#productGrid");
  const uploaded = grid2.querySelector(".pmedia img");
  assert.ok(uploaded, "the media-API card renders its photo");
  assert.match(uploaded.getAttribute("srcset") || "", /w=480/,
    "the media-API srcset offers the 480w candidate");
  assert.match(uploaded.getAttribute("sizes") || "", /50vw$/,
    "the card sizes end at the two-column phone width");
  assert.ok(!uploaded.classList.contains("is-loaded"),
    "a photo that has not landed yet stays over its placeholder");
  uploaded.dispatchEvent(new second.window.Event("error"));
  assert.equal(uploaded.getAttribute("srcset"), null,
    "a failed resized candidate drops the srcset and retries the master");
  assert.equal(uploaded.getAttribute("src"), mediaUrl,
    "the retry points at the full-size master");
  uploaded.dispatchEvent(new second.window.Event("error"));
  assert.ok(uploaded.classList.contains("img-broken"),
    "a photo that cannot be served at all yields to the placeholder, not a blank frame");

  console.log("✓ photo dots use the 96px derivative, never the full-resolution master");
  console.log("✓ the first cards load their photo eagerly, the first at high priority");
  console.log("✓ the rail paints in batches and keeps its placeholder until the catalog lands");
  console.log("✓ media API photos ship a responsive srcset and are re-encoded on request");
  console.log("✓ card photos are durable, phone-sized, uncropped and fade in over a placeholder");
  console.log("✓ the catalog payload is gzipped and no longer publishes internal costing");
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
