#!/usr/bin/env node
/**
 * Storefront media-weight audit.
 *
 * Renders the real storefront grid in jsdom against the live catalog and
 * reports the bytes a browser must download before the rail is usable.
 *
 * It exists because the rail used to ship one FULL-RESOLUTION JPEG per 40x40
 * photo-count thumbnail: the four tiny dots on a single card pulled ~1 MB of
 * original images (415 KB + 284 KB + 199 KB + 107 KB for one product), while
 * the 320w WebP derivatives for the very same four pictures total ~96 KB.
 *
 * Usage: node tests/perf-media-audit.js [apiBase]
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const API = process.argv[2] || "http://127.0.0.1:10099";

function localFile(url) {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return null;
  const rel = decodeURIComponent(url.split("?")[0]).replace(/^\/+/, "");
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

function fileSize(url) {
  const abs = localFile(url);
  if (!abs) return null;
  try { return fs.statSync(abs).size; } catch (e) { return null; }
}

/**
 * Collect the image URLs a browser would request for one grid render.
 *
 * <picture> blocks are resolved the way a browser does: the WebP source
 * wins, and the srcset candidate closest above the rendered card width is
 * chosen. Plain <img> tags (no <picture> wrapper) are taken as-is.
 */
function requestsFromHtml(html, viewportWidth) {
  const out = [];
  const cardWidth = viewportWidth >= 1100 ? 280 : viewportWidth >= 640 ? 0.45 * viewportWidth : 0.9 * viewportWidth;
  const doc = new JSDOM(`<div id="root">${html}</div>`).window.document;
  const imgs = Array.from(doc.querySelectorAll("img"));

  for (const img of imgs) {
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
    if (url) out.push(url);
  }
  return out;
}

async function main() {
  const res = await fetch(`${API}/api/products?availability=public`);
  const data = await res.json();
  const products = data.products || [];

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", e => console.error("[jsdom]", e.message.slice(0, 200)));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), {
    runScripts: "outside-only",
    url: `${API}/`,
    virtualConsole
  });
  const { window } = dom;

  window.fetch = async url => {
    const u = String(url);
    const body = u.includes("/api/products")
      ? { products }
      : u.includes("/api/settings")
        ? { settings: {} }
        : {};
    return new global.Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  window.Response = global.Response;
  window.Headers = global.Headers;
  window.Request = global.Request;
  window.localStorage.setItem("adonai-consent-v1", "essential");
  window.scrollTo = () => {};

  for (const file of ["js/image-manifest.js", "js/product-kit.js", "js/db.js", "js/storefront.js"]) {
    try {
      window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
    } catch (e) {
      console.error(`[${file}]`, e.message.slice(0, 200));
    }
  }
  await new Promise(r => setTimeout(r, 600));

  const grid = window.document.querySelector("#productGrid");
  const html = grid ? grid.innerHTML : "";
  const cardCount = (html.match(/<article class="pcard/g) || []).length;

  const report = {};
  for (const width of [1440, 768, 390]) {
    const urls = requestsFromHtml(html, width);
    const tally = {};
    let total = 0;
    let counted = 0;
    for (const u of urls) {
      const size = fileSize(u);
      if (size === null) continue;
      counted++;
      total += size;
      const kind = /\.webp$/i.test(u) ? "webp" : "jpg";
      tally[kind] = tally[kind] || { count: 0, bytes: 0 };
      tally[kind].count++;
      tally[kind].bytes += size;
    }
    report[width] = { imageCount: counted, totalBytes: total, tally, total: urls.length };
  }

  console.log(`\nStorefront media audit — ${products.length} products, ${cardCount} cards rendered\n`);
  for (const [w, r] of Object.entries(report)) {
    console.log(`  viewport ${w}px: ${r.imageCount} image requests, ${(r.totalBytes / 1024).toFixed(0)} KB`);
    Object.entries(r.tally).forEach(([k, v]) => {
      console.log(`      ${k.padEnd(5)} ${String(v.count).padStart(4)} reqs  ${(v.bytes / 1024).toFixed(0).padStart(7)} KB`);
    });
  }
  console.log("");
  return report;
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
