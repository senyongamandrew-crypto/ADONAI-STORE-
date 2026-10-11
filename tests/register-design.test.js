#!/usr/bin/env node
/* Presentation-only register regressions. No real API or store data is used. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const csstree = require("css-tree");
const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "pos.html"), "utf8");
const script = fs.readFileSync(path.join(ROOT, "js/pos.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "css/pos-overhaul.css"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(products = []) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://preview.example/pos.html", pretendToBeVisual: true });
  const win = dom.window;
  win.Auth = { ready: async () => {}, guard: () => ({ id: "TEST-OPERATOR", name: "Operator", role: "cashier" }), locked: () => false, openAccess: () => true, token: () => "" };
  win.Icons = { svg: () => '<svg viewBox="0 0 24 24" aria-hidden="true"></svg>' };
  let held = 0;
  win.DB = {
    DEMOGRAPHICS: ["Men", "Women", "Children", "Unisex"], CATEGORIES: ["Tops & Shirts", "Shoes"],
    listProducts: () => products, listSales: () => [], on: () => {},
    ugx: value => "UGX " + Number(value).toLocaleString("en-US"),
    findByBarcode: code => products.find(p => p.barcode_id === code) || null,
    acquireInventoryLock: async () => { held++; },
    releaseInventoryLockOwner: async () => {}, getSettings: () => ({})
  };
  win.eval(script);
  await tick();
  return { win, doc: win.document, held: () => held, close: () => win.close() };
}

(async () => {
  const ast = csstree.parse(css);
  assert(ast.children.size > 0);
  const f = await fixture();
  try {
    assert.equal(f.doc.querySelector('.pos-title-links'), null, "the shortcut panel is removed, not hidden with CSS");
    assert.equal(f.doc.querySelector('#posAccessStatus'), null);
    assert(!/No PIN required|Store Settings|Stock Management/i.test(f.doc.querySelector('.pos-title').textContent));
    assert.equal(f.doc.querySelector('.pos-title h1').textContent.trim(), 'Cashier Register (UGX)');
    assert(f.doc.querySelector('#posNavList a[data-console-view="settings"]'));
    assert(f.doc.querySelector('#posNavList a[data-console-view="inventory"]'));
    assert(f.doc.querySelector('#posNavList a[data-console-view="intake"]'));
    assert(f.doc.querySelector('#notifBellBtn'));
    assert.equal(f.doc.querySelector('.pos-title-art').getAttribute('aria-hidden'), 'true');
    assert.equal(f.doc.querySelector('.pos-title-art svg').getAttribute('focusable'), 'false');
    f.doc.querySelector('#btnPosMenu').click();
    assert(f.doc.body.classList.contains('sb-open'), 'the Menu still opens');
    f.doc.querySelector('#closePosSidebar').click();
    assert(!f.doc.body.classList.contains('sb-open'));
    assert.equal(f.doc.querySelector('.pos-catalog-empty h2').textContent, 'Your register is ready');
    assert.match(f.doc.querySelector('.pos-catalog-empty p').textContent, /Menu → Catalog Intake/);
    assert.equal(f.doc.querySelector('.pos-catalog-empty img').getAttribute('alt'), '');
    console.log('✓ cluttered header shortcuts removed; Menu, bell and accessible register heading retained');
  } finally { f.close(); }
  const product = { id: 'UI-TEST', name: 'UI fixture tee', sku: 'UI-SKU', barcode_id: 'UI-BARCODE', brand: 'Adonai', demographic: 'Men', category: 'Tops & Shirts', color: 'Green', size: 'M', condition: 'New', item_condition: 'BRAND_NEW', in_stock_count: 2, selling_price: 50000 };
  const catalog = await fixture([product]);
  try {
    assert.equal(catalog.doc.querySelectorAll('[data-tile]').length, 1);
    assert.equal(catalog.doc.querySelector('.pos-catalog-empty'), null, 'empty artwork does not cover a stocked catalog');
    catalog.doc.querySelector('#posDemos [data-demo="Women"]').click();
    assert.equal(catalog.doc.querySelector('.pos-catalog-empty h2').textContent, 'No matching pieces');
    assert.match(catalog.doc.querySelector('.pos-catalog-empty p').textContent, /another department/);
    catalog.doc.querySelector('#posDemos [data-demo="All"]').click();
    const input = catalog.doc.querySelector('#barcodeInput');
    input.value = product.barcode_id;
    input.dispatchEvent(new catalog.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert.equal(catalog.held(), 1, 'scanner still reserves real stock through the existing API');
    assert.equal(catalog.doc.querySelector('#sumItems').textContent, '1');
    assert.equal(catalog.doc.querySelector('#btnCharge').disabled, false);
    console.log('✓ decorative empty/filter states and scanner-to-cart behavior remain correct');
  } finally { catalog.close(); }
  for (const asset of ['pos-register-pattern.svg', 'pos-register-ready.svg']) {
    const xml = new JSDOM(fs.readFileSync(path.join(ROOT, 'assets', asset), 'utf8'), { contentType: 'image/svg+xml' });
    assert.equal(xml.window.document.documentElement.localName, 'svg');
    xml.window.close();
  }
  console.log('✓ background stylesheet and lightweight SVG artwork validate');
})().catch(error => { console.error(error); process.exitCode = 1; });
