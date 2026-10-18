#!/usr/bin/env node
/**
 * End-to-end storefront load measurement.
 *
 * Measures what a customer who opens the site actually pays for: the
 * document, the scripts, the catalog payload and the photos that make the
 * rail look like a shop. Reports the first-viewport image weight separately
 * from the full page, because the first screen is what "the site feels
 * slow" is really about.
 *
 * Usage: node tests/perf-storefront-load.js [apiBase]
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const API = process.argv[2] || "http://127.0.0.1:10099";

function localSize(url) {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return null;
  const rel = decodeURIComponent(url.split("?")[0]).replace(/^\/+/, "");
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  try { return fs.statSync(abs).size; } catch (e) { return null; }
}

async function timedGet(url, options = {}) {
  const started = Date.now();
  const response = await fetch(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  // Node decompresses transparently, so the wire size comes from the
  // response headers rather than the buffer.
  const encoded = response.headers.get("content-encoding");
  const wireBytes = encoded
    ? Number(response.headers.get("content-length") || buffer.length)
    : buffer.length;
  return { ms: Date.now() - started, bytes: wireBytes, raw: buffer.length, buffer, response, encoded };
}

/**
 * The URLs a browser actually downloads for one rendered grid: the WebP
 * source wins, and the srcset candidate closest above the rendered card
 * width is the one fetched.
 */
function browserImageUrls(grid, viewportWidth) {
  const cardWidth = viewportWidth >= 1100 ? 280 : viewportWidth >= 640 ? 0.45 * viewportWidth : 0.9 * viewportWidth;
  const urls = [];
  for (const img of grid.querySelectorAll("img")) {
    const picture = img.closest("picture");
    const source = picture ? picture.querySelector("source[type='image/webp']") : null;
    let url = null;
    if (source && source.getAttribute("srcset")) {
      const candidates = source.getAttribute("srcset").split(",").map(c => {
        const parts = c.trim().split(/\s+/);
        return { url: parts[0], w: parseInt(parts[1], 10) || 0 };
      }).filter(c => c.url);
      const sorted = candidates.slice().sort((a, b) => a.w - b.w);
      const pick = sorted.find(c => c.w >= cardWidth) || sorted[sorted.length - 1];
      url = pick ? pick.url : null;
    }
    if (!url) url = img.getAttribute("src");
    if (url) urls.push(url);
  }
  return urls;
}

async function main() {
  const report = [];

  /* 1. The document. */
  const html = await timedGet(`${API}/`, { headers: { "Accept-Encoding": "gzip" } });
  report.push(["document (index.html)", html.ms, html.bytes]);

  /* 2. The scripts and stylesheet the storefront needs. */
  const assets = [
    "/css/storefront.css", "/js/analytics.js", "/js/scrollLock.js", "/js/image-manifest.js",
    "/js/db.js", "/js/product-kit.js", "/js/storefront.js", "/js/cartController.js"
  ];
  let scriptBytes = 0;
  let scriptMs = 0;
  for (const asset of assets) {
    const result = await timedGet(`${API}${asset}`, { headers: { "Accept-Encoding": "gzip" } });
    scriptBytes += result.bytes;
    scriptMs += result.ms;
  }
  report.push(["scripts + stylesheet", scriptMs, scriptBytes]);

  /* 3. The catalog payload the rail waits for. */
  const catalog = await timedGet(`${API}/api/products?availability=public`, {
    headers: { "Accept-Encoding": "gzip" }
  });
  report.push(["catalog payload (gzip)", catalog.ms, catalog.bytes]);

  /* 4. The photos. */
  const products = JSON.parse(catalog.buffer.toString("utf8")).products || [];
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html.buffer.toString("utf8"), {
    runScripts: "outside-only", url: `${API}/`, virtualConsole
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

  const started = Date.now();
  for (const file of ["js/image-manifest.js", "js/product-kit.js", "js/db.js", "js/storefront.js"]) {
    window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  }
  await new Promise(r => setTimeout(r, 500));
  const timeToCards = Date.now() - started;

  const grid = window.document.querySelector("#productGrid");
  const cards = grid.querySelectorAll("article.pcard");

  const viewports = [[1440, "desktop"], [390, "phone"]];
  const imageRows = [];
  for (const [width, label] of viewports) {
    const urls = browserImageUrls(grid, width);
    let bytes = 0;
    let counted = 0;
    for (const url of urls) {
      const size = localSize(url);
      if (size === null) continue;
      bytes += size;
      counted++;
    }
    imageRows.push([label, counted, bytes]);
  }

  console.log(`\nStorefront first-visit cost — ${products.length} products, ${cards.length} cards\n`);
  for (const [label, ms, bytes] of report) {
    console.log(`  ${label.padEnd(28)} ${String(ms).padStart(5)} ms   ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`  ${"rail ready (js + catalog)".padEnd(28)} ${String(timeToCards).padStart(5)} ms   (in-page render)`);
  for (const [label, count, bytes] of imageRows) {
    console.log(`  ${("photos on the rail (" + label + ")").padEnd(28)} ${"".padStart(5)}      ${String(count).padStart(2)} requests, ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  const total = report.reduce((sum, r) => sum + r[2], 0) + imageRows[0][2];
  console.log(`\n  TOTAL first visit (desktop): ${(total / 1024).toFixed(1)} KB\n`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
