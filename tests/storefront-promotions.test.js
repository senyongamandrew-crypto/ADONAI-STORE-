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
const db = read("js/db.js");
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
  "staff can choose automatic, selected products, custom images, or hidden mode");
assert.match(adminHtml, /<option value="custom">Upload banner images or HTML<\/option>/,
  "the promotion manager supports custom images and HTML banners");
assert.match(adminHtml, /accept="[^"]*\.html[^"]*\.htm/,
  "the promotion file picker accepts standalone HTML banner files");
assert.match(admin, /DB\.uploadPromotionHtml\(file\)/,
  "uploaded HTML banners use the dedicated isolated-creative endpoint");
assert.match(storefront, /sandbox="allow-scripts"/,
  "public HTML artwork runs in a sandbox without same-origin access");
assert.match(adminHtml, /id="promoCreativeFileInput"[\s\S]*?id="promoCreativeList"/,
  "the manager exposes an upload control and ordered creative list");
assert.match(admin, /data-promo-creative-move[\s\S]*?data-promo-creative-replace[\s\S]*?data-promo-creative-remove/,
  "custom artwork can be ordered, replaced and removed");
assert.match(api, /normalize_storefront_promo_ids/,
  "the API validates custom image settings before publication");
assert.match(db, /X-Adonai-Media-Preview/,
  "authorized staff preview uploaded drafts without making them public");
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
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), { mode: "auto", ids: [], items: [] });
promoContext.setPromoSetting("none");
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), { mode: "none", ids: [], items: [] });
promoContext.setPromoSetting('["SKU-3", "SKU-1", "SKU-3"]');
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), { mode: "selected", ids: ["SKU-3", "SKU-1"], items: [] },
  "manual picks retain their chosen order and ignore duplicate IDs");
const promoImageId = "a".repeat(32);
promoContext.setPromoSetting(JSON.stringify({ mode: "custom", items: [{ media_id: promoImageId, alt_text: "Fresh arrivals" }] }));
assert.deepEqual(JSON.parse(JSON.stringify(promoContext.promotionalSelection())), {
  mode: "custom", ids: [], items: [{ media_id: promoImageId, type: "image", width: 0, height: 0, alt_text: "Fresh arrivals" }]
}, "custom image selections preserve their manually ordered media and alt text");

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
const emptySelectedDom = new JSDOM(homepage, { runScripts: "outside-only", url: "https://adonai-preview.example/" });
const emptySelectedWindow = emptySelectedDom.window;
emptySelectedWindow.setInterval = () => 0;
emptySelectedWindow.requestAnimationFrame = callback => callback();
emptySelectedWindow.AdonaiPDP = window.AdonaiPDP;
emptySelectedWindow.DB = {
  ...window.DB,
  getSettings: () => ({ storefront_promo_ids: '["SKU-3"]' }),
  listProducts: () => []
};
emptySelectedWindow.eval(storefront);
assert.equal(emptySelectedWindow.document.querySelector("#promoRail").hidden, false,
  "the promotional strip remains rendered when saved products are unavailable and the catalog is empty");
assert.ok(emptySelectedWindow.document.querySelector(".promo-card--brand"),
  "an empty selected-product mode falls back to existing Adonai artwork, not a dummy product");
emptySelectedDom.window.close();
const customImageId = "c".repeat(32);
const customDom = new JSDOM(homepage, { runScripts: "outside-only", url: "https://adonai-preview.example/" });
const customWindow = customDom.window;
customWindow.setInterval = () => 0;
customWindow.requestAnimationFrame = callback => callback();
customWindow.AdonaiPDP = window.AdonaiPDP;
customWindow.DB = {
  ...window.DB,
  getSettings: () => ({ storefront_promo_ids: JSON.stringify({ mode: "custom", items: [{ media_id: customImageId, alt_text: "Hand-picked seasonal artwork" }] }) }),
  listProducts: () => []
};
customWindow.eval(storefront);
const customRail = customWindow.document.querySelector("#promoRail");
const customCard = customWindow.document.querySelector("#promoTrack .promo-card--custom");
assert.equal(customRail.hidden, false, "a custom image strip stays visible with an empty catalog");
assert.ok(customCard, "manual custom artwork appears in the storefront rail");
assert.equal(customCard.querySelector("img").getAttribute("src"), `/api/media/${customImageId}`,
  "custom artwork loads from durable uploaded media");
assert.equal(customCard.querySelector("img").alt, "Hand-picked seasonal artwork",
  "the owner-supplied accessible image description reaches the storefront");
assert.equal(customCard.querySelector(".promo-card-prices"), null,
  "custom artwork receives no generated price or discount copy");
assert.equal(customCard.querySelector(".promo-card-discount"), null,
  "custom artwork never receives a fabricated discount badge");
assert.ok(customWindow.document.querySelectorAll("#promoTrack .promo-card--custom").length > 1,
  "even a single manually uploaded image scrolls continuously across the strip");
const customHtmlId = "d".repeat(32);
const htmlDom = new JSDOM(homepage, { runScripts: "outside-only", url: "https://adonai-preview.example/" });
const htmlWindow = htmlDom.window;
htmlWindow.setInterval = () => 0;
htmlWindow.requestAnimationFrame = callback => callback();
htmlWindow.AdonaiPDP = window.AdonaiPDP;
htmlWindow.DB = {
  ...window.DB,
  getSettings: () => ({ storefront_promo_ids: JSON.stringify({ mode: "custom", items: [{
    media_id: customHtmlId, type: "html", width: 728, height: 90, alt_text: "Blazer sale banner"
  }] }) }),
  listProducts: () => []
};
htmlWindow.eval(storefront);
const htmlCard = htmlWindow.document.querySelector("#promoTrack .promo-card--html");
const htmlFrame = htmlCard && htmlCard.querySelector("iframe");
assert.ok(htmlFrame, "a published HTML banner is embedded in its own frame");
assert.equal(htmlWindow.document.querySelectorAll("#promoTrack iframe").length, 1,
  "a single rich creative is not duplicated, avoiding repeated script execution and impressions");
assert.ok(htmlWindow.document.querySelector("#promoTrack").classList.contains("is-static"),
  "a single HTML banner displays once without a duplicate marquee iframe");
assert.equal(htmlFrame.getAttribute("src"), `/api/promo-media/${customHtmlId}`,
  "the public banner reads from durable HTML creative storage");
assert.equal(htmlFrame.getAttribute("sandbox"), "allow-scripts",
  "banner scripts remain sandboxed away from the store origin");
assert.doesNotMatch(htmlFrame.getAttribute("sandbox"), /allow-same-origin|allow-top-navigation/,
  "an uploaded banner cannot access the store DOM or take over the top page");
assert.match(htmlCard.getAttribute("style"), /--promo-html-frame-width:728px/,
  "standard 728 by 90 HTML banners retain their original viewport dimensions when scaled into the rail");
assert.equal(htmlCard.getAttribute("aria-label"), "Storefront artwork: Blazer sale banner",
  "HTML banner descriptions are exposed accessibly on the storefront");
htmlDom.window.close();
customDom.window.close();
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
let managerUploadCount = 0;
managerWindow.DB = {
  getSettings: () => managerSettings,
  listProducts: () => managerCatalog,
  apiUrl: value => value,
  uploadMedia: async () => ({ id: (++managerUploadCount).toString(16).padStart(32, "0") }),
  uploadPromotionHtml: async file => ({ id: "f".repeat(32), url: "/api/promo-media/" + "f".repeat(32), name: file.name, width: 728, height: 90 }),
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

async function verifyCustomCreativeManager() {
  const mode = managerDoc.querySelector("#storefrontPromoMode");
  mode.value = "custom";
  mode.dispatchEvent(new managerWindow.Event("change", { bubbles: true }));
  assert.equal(managerDoc.querySelector("#promoCreativeChoices").hidden, false,
    "custom creative controls appear when staff select the manual banner mode");
  assert.match(managerDoc.querySelector("#promoCreativeList").textContent, /No custom banner files yet/,
    "the custom manager begins empty rather than inventing demo artwork");

  const fileInput = managerDoc.querySelector("#promoCreativeFileInput");
  const first = new managerWindow.File(["image one"], "artwork-one.png", { type: "image/png" });
  const second = new managerWindow.File(["<!doctype html><html><body>Banner</body></html>"], "Blazer Banner 728x90.html", { type: "text/html" });
  Object.defineProperty(fileInput, "files", { configurable: true, value: [first, second] });
  fileInput.dispatchEvent(new managerWindow.Event("change", { bubbles: true }));
  await new Promise(resolve => managerWindow.setTimeout(resolve, 10));
  assert.equal(managerDoc.querySelectorAll("#promoCreativeList .promo-creative-row").length, 2,
    "uploaded artwork is listed as separate editable creatives");
  assert.equal(managerDoc.querySelector("#promoCreativeCapacity").textContent, "2 of 8 creatives",
    "custom banner-file capacity is visible to staff");
  assert.match(managerDoc.querySelector("#promoCreativeList").textContent, /HTML banner 2/,
    "uploaded HTML files are identified separately from image creatives");
  const htmlPreview = managerDoc.querySelector("#promoCreativeList iframe");
  assert.ok(htmlPreview && htmlPreview.getAttribute("sandbox") === "allow-scripts",
    "the admin previews uploaded HTML in a sandbox too");

  managerDoc.querySelector('[data-promo-creative-move="down"][data-promo-creative-index="0"]').click();
  const alt = managerDoc.querySelector('[data-promo-alt="0"]');
  alt.value = "Owner-selected seasonal art";
  alt.dispatchEvent(new managerWindow.Event("change", { bubbles: true }));

  const replaceInput = managerDoc.querySelector('[data-promo-replace-file="1"]');
  const replacement = new managerWindow.File(["replacement"], "replacement.jpg", { type: "image/jpeg" });
  Object.defineProperty(replaceInput, "files", { configurable: true, value: [replacement] });
  replaceInput.dispatchEvent(new managerWindow.Event("change", { bubbles: true }));
  await new Promise(resolve => managerWindow.setTimeout(resolve, 10));

  managerDoc.querySelector("#btnSavePromoSettings").click();
  await new Promise(resolve => managerWindow.setTimeout(resolve, 10));
  const published = JSON.parse(managerSettings.storefront_promo_ids);
  assert.equal(published.mode, "custom", "the manual creative mode publishes through the shared setting");
  assert.equal(published.items.length, 2, "publishing retains the selected custom artwork list");
  assert.equal(published.items[0].media_id, "f".repeat(32),
    "the uploaded HTML banner stays first after reordering and publishing");
  assert.equal(published.items[0].type, "html",
    "published settings retain the HTML creative type");
  assert.equal(published.items[0].width, 728);
  assert.equal(published.items[0].height, 90);
  assert.equal(published.items[0].alt_text, "Owner-selected seasonal art",
    "accessible descriptions survive reordering, replacement and publishing");
  assert.equal(published.items[1].media_id, "0".repeat(31) + "2",
    "the replaced image is uploaded and published after the HTML banner");
  assert.equal(published.items[1].type, "image");
  managerDom.window.close();
  console.log("✓ storefront promotions use real catalog items, custom uploads/replacements/order, visible empty-catalog artwork and no fabricated offers");
}

verifyCustomCreativeManager().catch(error => {
  console.error(error);
  managerDom.window.close();
  process.exitCode = 1;
});
