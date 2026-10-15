#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const homepage = read("index.html");
const storefront = read("js/storefront.js");
const styles = read("css/storefront.css");
const admin = read("app.js");
const adminHtml = read("admin.html");
const posHtml = read("pos.html");
const api = read("api.py");
const dbInit = read("db_init.py");

const masthead = homepage.indexOf('class="masthead wrap"');
const promoRail = homepage.indexOf('id="promoRail"');
const catalog = homepage.indexOf('id="catalogDashboardRegion"');
assert(masthead >= 0 && masthead < promoRail && promoRail < catalog,
  "promotional strip sits between the intro panel and available pieces");
assert.match(homepage.slice(promoRail - 40, promoRail + 140), /hidden>/,
  "the public promo strip starts hidden until its image content is ready");
const promoMarkup = homepage.slice(promoRail, catalog);
assert.doesNotMatch(promoMarkup, /Live price drops|Discover the collection|Adonai Store · Kampala|→/,
  "the strip has no extra heading, branding caption or arrow text");

assert.match(storefront, /compare > current/,
  "only a genuine compare-at price above the live price qualifies as an offer");
assert.match(storefront, /stock <= 0 \|\| current <= 0/,
  "out-of-stock and invalid-price products are not advertised");
assert.match(storefront, /getProductImages\(product\)\[0\]/,
  "the advert uses the real product gallery image");
assert.match(storefront, /PK\.productPath\(p\)/,
  "each advert links to its actual product page");
const productPromoMarkup = storefront.slice(storefront.indexOf("function promotionalCardHTML"), storefront.indexOf("function brandPromotionCardHTML"));
assert.doesNotMatch(productPromoMarkup, /promo-card-copy|promo-card-cta|View piece|→/,
  "product promos have no text underneath or unnecessary arrows");
assert.match(storefront, /rail\.hidden = false/,
  "the strip is shown even when the clean catalog has no offers");
assert.match(storefront, /brandPromotionCardHTML/,
  "an empty catalog uses the existing Adonai brand artwork instead of dummy offers");
assert.match(storefront, /assets\/storefront-editorial-bg\.jpg/,
  "the fallback advert uses existing store artwork");
assert.match(storefront, /aria-hidden="true" inert/,
  "duplicated marquee cards are hidden from assistive technology and keyboard focus");
assert.match(admin, /Compare-at \(UGX\)/,
  "staff can publish an offer through the existing product editor");
assert.match(adminHtml, /id="storefrontPromoManager"/,
  "Admin Suite contains a control panel for the storefront strip");
assert.match(adminHtml, /id="storefrontPromoMode"/,
  "staff can choose automatic, selected products, or hidden mode");
assert.match(posHtml, /href="admin\.html\?view=settings" data-console-view="settings">[\s\S]*?<span>Storefront Promotions<\/span>/,
  "the POS navigation has a direct Storefront Promotions entry");
assert.ok(adminHtml.indexOf('id="storefrontPromoManager"') < adminHtml.indexOf('id="displaySizeSettings"'),
  "the promotion controls appear at the top of System Parameters instead of being buried");
assert.match(admin, /DB\.syncStoreSettings\(\{ storefront_promo_ids: value \}/,
  "the chosen promotion mode is published through shared store settings");
assert.match(api, /"storefront_promo_ids"/,
  "the server publishes the storefront promotion selection");
assert.match(dbInit, /"storefront_promo_ids": "auto"/,
  "new stores begin in automatic mode without sample campaigns");
assert.match(admin, /data-promo-move="up"[\s\S]*?data-promo-move="down"/,
  "the Admin Suite exposes explicit earlier/later controls for selected order");
assert.match(admin, /data-promo-remove/,
  "staff can remove saved products that have left the catalog");
assert.match(admin, /unavailable selection[\s\S]*?skipped on the storefront|Out of stock or missing a valid price/,
  "saved products that are unavailable remain visible and are explained as skipped");

assert.match(styles, /\.promo-card\s*\{[\s\S]*?height: 74px/,
  "the desktop strip is compact");
assert.match(styles, /\.promo-card\s*\{[\s\S]*?height: 68px/,
  "the mobile strip is compact enough to reduce panel height");
assert.match(styles, /@keyframes promo-left-scroll/,
  "the strip has a right-to-left motion loop");
assert.match(styles, /translate3d\(-50%, 0, 0\)/,
  "the marquee loops by one duplicated set for a seamless transition");
assert.match(styles, /\.promo-window:hover \.promo-track,[\s\S]*?\.promo-window:focus-within \.promo-track/,
  "hovering or keyboard-focusing the strip pauses its movement");
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.promo-track[\s\S]*?animation: none !important/,
  "reduced-motion users receive a still, scrollable rail");

const availableItemsFunction = storefront.match(/function availablePromotionItems\(list\) \{[\s\S]*?\n  \}/);
const offerFunction = storefront.match(/function promotionalOffers\(list\) \{[\s\S]*?\n  \}/);
const featuredFunction = storefront.match(/function featuredPromotions\(list\) \{[\s\S]*?\n  \}/);
const selectionFunction = storefront.match(/function promotionalSelection\(\) \{[\s\S]*?\n  \}/);
assert(availableItemsFunction && offerFunction && featuredFunction && selectionFunction,
  "promotion filtering, automatic selection and manual selection logic exists");
const promoContext = {
  displayPrice: product => Number(product && (product.final_selling_price ?? product.selling_price)) || 0,
  getProductImages: product => [product.image_url].filter(Boolean)
};
vm.createContext(promoContext);
vm.runInContext(`
  let S = {};
  const PROMO_MAX_PRODUCTS = 12;
  ${availableItemsFunction[0]}
  ${offerFunction[0]}
  ${featuredFunction[0]}
  ${selectionFunction[0]}
  this.setPromoSetting = value => { S.storefront_promo_ids = value; };
  this.promotionalOffers = promotionalOffers;
  this.featuredPromotions = featuredPromotions;
  this.promotionalSelection = promotionalSelection;
`, promoContext);
const products = [
  { id: "SKU-1", name: "Real markdown", selling_price: 70000, compare_price: 100000, in_stock_count: 2, image_url: "/api/media/active" },
  { id: "SKU-2", name: "Sold out markdown", selling_price: 50000, compare_price: 100000, in_stock_count: 0, image_url: "/api/media/sold" },
  { id: "SKU-3", name: "No markdown", selling_price: 80000, compare_price: 80000, in_stock_count: 1, image_url: "/api/media/full" },
  { id: "SKU-4", name: "Invalid price", selling_price: 0, compare_price: 100000, in_stock_count: 1, image_url: "/api/media/invalid" }
];
const activeOffers = promoContext.promotionalOffers(products);
assert.equal(activeOffers.length, 1, "only an available product with a lower positive selling price is advertised");
assert.equal(activeOffers[0].percent, 30, "the visible offer percentage is calculated from actual prices");
assert.equal(activeOffers[0].image, "/api/media/active", "the offer retains the selected product photo");

const featured = promoContext.featuredPromotions([
  { name: "Available piece", selling_price: 50000, in_stock_count: 1, image_url: "/api/media/featured" },
  { name: "Unavailable piece", selling_price: 50000, in_stock_count: 0, image_url: "/api/media/sold" }
]);
assert.equal(featured.length, 1, "the non-discount rail still showcases only real in-stock pieces");
assert.equal(featured[0].percent, 0, "featured pieces never invent a discount");

promoContext.setPromoSetting("auto");
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), { mode: "auto", ids: [] });
promoContext.setPromoSetting("none");
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), { mode: "none", ids: [] });
promoContext.setPromoSetting('["SKU-3", "SKU-1", "SKU-3"]');
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), { mode: "selected", ids: ["SKU-3", "SKU-1"] },
  "manual picks retain their chosen order and ignore duplicate IDs");

const dom = new JSDOM(homepage, { runScripts: "outside-only", url: "https://adonai-preview.example/" });
const { window } = dom;
window.setInterval = () => 0;
window.requestAnimationFrame = callback => callback();
window.AdonaiPDP = {
  storeEmail: settings => settings.email || "info@adonaithrift-store.online",
  productPath: product => "/product/" + (product.slug || product.id),
  pictureHTML: (src, options = {}) => `<img src="${src}" alt="${options.alt || ""}" class="${options.className || ""}">`,
  hasMeasurements: () => false,
  gradeFor: () => ({ short: "A", color: "#16803c", tint: "#e8f3eb" }),
  stockState: () => ({ sold: false, label: "Available" })
};
window.DB = {
  CATEGORIES: [], CONDITIONS: [], DEMOGRAPHICS: [],
  getSettings: () => ({ store_name: "Adonai Store", tagline: "Brand-new apparel + curated vintage pieces · Kampala, Uganda", email: "info@adonaithrift-store.online", address: "Kampala, Uganda" }),
  listProducts: () => [],
  on: () => () => {},
  ugx: value => "UGX " + Number(value).toLocaleString("en-UG"),
  getPaymentConfig: () => Promise.resolve({ methods: ["cod"], channels: [] }),
  releaseInventoryLock: () => Promise.resolve(),
  getDeliveryFee: () => 0
};
window.eval(storefront);
assert.equal(window.document.querySelector("#promoRail").hidden, false,
  "the empty preview still displays the promotional strip");
assert.ok(window.document.querySelector(".promo-card--brand"),
  "the empty preview displays the existing artwork without added caption text");
assert.equal(window.document.querySelector(".promo-card-discount"), null,
  "the empty preview never invents a discount badge");
assert.ok(window.document.querySelectorAll("#promoTrack .promo-card").length > 1,
  "the branded fallback moves continuously across the narrow strip");

const selectedCatalog = [
  { id: "SKU-1", name: "Regular catalog piece", selling_price: 50000, compare_price: 50000, in_stock_count: 1, image_url: "/api/media/regular" },
  { id: "SKU-2", name: "Published markdown", selling_price: 70000, compare_price: 100000, in_stock_count: 2, image_url: "/api/media/markdown" },
  { id: "SKU-3", name: "Out-of-stock selection", selling_price: 40000, compare_price: 90000, in_stock_count: 0, image_url: "/api/media/sold" }
];
const manualDom = new JSDOM(homepage, { runScripts: "outside-only", url: "https://adonai-preview.example/" });
const manualWindow = manualDom.window;
manualWindow.setInterval = () => 0;
manualWindow.requestAnimationFrame = callback => callback();
manualWindow.AdonaiPDP = window.AdonaiPDP;
manualWindow.DB = {
  ...window.DB,
  getSettings: () => ({ store_name: "Adonai Store", storefront_promo_ids: '["SKU-3", "SKU-2", "SKU-1"]' }),
  listProducts: () => selectedCatalog
};
manualWindow.eval(storefront);
const manualCards = [...manualWindow.document.querySelectorAll(".promo-set:not(.promo-set--clone) .promo-card")];
assert.deepEqual(manualCards.slice(0, 2).map(card => card.getAttribute("href")),
  ["/product/SKU-2", "/product/SKU-1"],
  "manual storefront selection preserves order while skipping a selected item that is now out of stock");
assert.equal(manualCards[0].querySelector(".promo-card-discount").textContent, "30% OFF",
  "manual mode displays only the genuine discount from current catalog prices");
assert.equal(manualCards.some(card => card.getAttribute("href").includes("SKU-3")), false,
  "an unavailable saved product never appears in the storefront strip");
manualDom.window.close();
dom.window.close();

const managerBlock = admin.match(/let promoManagerDirty = false;[\s\S]*?(?=  \/\* What the payment gateway can actually do right now)/);
assert(managerBlock, "Admin Suite storefront promotion manager has an executable settings block");
const managerDom = new JSDOM(adminHtml, { runScripts: "outside-only", url: "https://adonai-preview.example/admin.html" });
const managerWindow = managerDom.window;
let managerSettings = { storefront_promo_ids: '["SKU-3", "SKU-2", "SKU-removed"]' };
const managerCatalog = [
  { id: "SKU-1", name: "Available catalog item", selling_price: 40000, compare_price: 40000, in_stock_count: 1, image_url: "/api/media/1" },
  { id: "SKU-2", name: "Selected catalog item", selling_price: 70000, compare_price: 100000, in_stock_count: 2, image_url: "/api/media/2" },
  { id: "SKU-3", name: "Now sold-out item", selling_price: 50000, compare_price: 90000, in_stock_count: 0, image_url: "/api/media/3" }
];
managerWindow.DB = {
  getSettings: () => managerSettings,
  listProducts: () => managerCatalog,
  syncStoreSettings: async patch => { managerSettings = { ...managerSettings, ...patch }; return { ok: true }; }
};
managerWindow.Icons = { svg: () => "<svg></svg>" };
managerWindow.__testUgx = value => "UGX " + Number(value).toLocaleString("en-UG");
managerWindow.__testEsc = value => String(value == null ? "" : value).replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[char]));
managerWindow.__testToast = () => {};
managerWindow.__testKeys = { requireRemote: callback => callback("") };
const managerHarness = [
  'const $ = (selector, root) => (root || document).querySelector(selector);',
  'const esc = window.__testEsc;',
  'const ugx = window.__testUgx;',
  'const DB = window.DB;',
  'const Icons = window.Icons;',
  'const toast = window.__testToast;',
  'const Keys = window.__testKeys;',
  managerBlock[0],
  'renderPromoManager(DB.getSettings());'
].join("\n");
managerWindow.eval(managerHarness);
const managerDoc = managerWindow.document;
const savedSelection = managerDoc.querySelector("#promoProductList");
assert.match(managerDoc.querySelector("#promoSelectionSummary").textContent, /2 selected products are currently unavailable and skipped/,
  "previously selected products that are now out of stock or removed are explained and skipped");
assert.equal(savedSelection.querySelector('[data-promo-product][value="SKU-3"]'), null,
  "a sold-out saved selection cannot be picked as if it were available");
assert.ok(savedSelection.querySelector('[data-promo-remove="SKU-3"]'),
  "staff can explicitly clear an out-of-stock saved selection");
const moveEarlier = savedSelection.querySelector('[data-promo-move="up"][data-promo-id="SKU-2"]');
assert.ok(moveEarlier && !moveEarlier.disabled, "selected products expose explicit order controls");
moveEarlier.click();
assert.match(managerDoc.querySelector('#promoProductList [data-promo-product][value="SKU-2"]').closest(".promo-product-choice").textContent, /Position 1/,
  "moving a selected product changes its displayed order");
managerDoc.querySelector('[data-promo-remove="SKU-3"]').click();
managerDoc.querySelector('[data-promo-remove="SKU-removed"]').click();
assert.equal(managerDoc.querySelectorAll("#promoProductList [data-promo-remove]").length, 0,
  "stale selections can be removed from the saved list");
managerDom.window.close();

console.log("✓ storefront promotions use real catalog items, visible brand fallback, ordered manager controls and unavailable-item handling");
