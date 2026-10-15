#!/usr/bin/env node
/**
 * Adonai Store — PDP order-path contract.
 *
 * Ordering on the storefront has exactly ONE path: Add to Cart → checkout →
 * the order is written to the database, reserves the piece (inventory lock)
 * and appears in the POS for fulfilment.
 *
 * The PDP used to carry a second, competing "Order via WhatsApp" button that
 * wrote nothing at all — no order, no reservation — so a one-of-one piece
 * could be promised to two shoppers and the sale only existed once a staff
 * member re-typed it. That button is gone: WhatsApp is kept only where it is
 * NOT an order (a sold piece → sourcing a similar one, an unmeasured piece →
 * asking for measurements, and the staff→customer confirmation that runs off
 * a real POS order).
 *
 * This suite fails if an "order on WhatsApp" control ever comes back to the
 * product page, the banner or the floating layer.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const productHtml = read("product.html");
const productJs = read("js/product.js");
const kitJs = read("js/product-kit.js");
const homepage = read("index.html");
const storefrontJs = read("js/storefront.js");
const storefrontCss = read("css/storefront.css");

const WA = "256758873398";

const settings = {
  store_name: "Adonai Store",
  whatsapp: WA,
  whatsapp_display: "+256 758 873398",
  hotline: "+256 765 652403",
  address: "Plot 45 Salama Road, Kibuli / Kampala",
  email: "info@adonaithrift-store.online"
};

function baseProduct(overrides) {
  return Object.assign({
    id: "PRD-TEST-1",
    sku: "ADN-TEST-1",
    slug: "test-jacket-adn-test-1",
    name: "Test jacket",
    brand: "Test",
    category: "Outerwear & Jackets",
    demographic: "Men",
    size: "L",
    color: "Black",
    condition: "Grade A — Excellent",
    item_condition: "PRE_LOVED",
    selling_price: 42500,
    compare_price: 45000,
    in_stock_count: 1,
    quantity_type: "PRE_LOVED",
    images: [],
    measurements: {},
    image_url: ""
  }, overrides || {});
}

/** Render the PDP for one product, exactly as the browser would. */
function renderPdp(product) {
  const dom = new JSDOM(productHtml, {
    url: `https://adonai-preview.example/product/${product.slug}`,
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.__ADONAI_PDP_PRODUCT__ = product;
  window.scrollTo = () => {};
  window.fetch = () => Promise.reject(new Error("offline test"));
  window.DB = {
    CATEGORIES: [], CONDITIONS: [], DEMOGRAPHICS: [],
    getSettings: () => settings,
    listProducts: () => [product],
    getProduct: () => product,
    on: () => () => {},
    ugx: value => "UGX " + Number(value || 0).toLocaleString("en-UG"),
    apiUrl: p => p,
    getPaymentConfig: () => Promise.resolve({ methods: ["cod"], channels: [] })
  };
  window.eval(kitJs);
  window.eval(productJs);
  return dom;
}

/* ---------------------------------------------------------------- in stock */

const liveDom = renderPdp(baseProduct());
const live = liveDom.window.document;

const liveActions = live.querySelectorAll(".buybox-actions > *");
assert.equal(liveActions.length, 1,
  "an available piece offers exactly one buying action (the cart)");
assert.equal(liveActions[0].id, "buyCart", "that action is Add to Cart");
assert.equal(liveActions[0].textContent.trim(), "Add to Cart", "Add to Cart is the only order control in the buy box");
assert.equal(live.querySelector("#buyEnquiry"), null, "no WhatsApp control sits next to a buyable piece");
assert.equal(live.querySelector(".buybox-actions a"), null, "no link competes with the cart on a buyable piece");

const liveBar = live.querySelector(".pdp-actionbar-btns");
assert.equal(live.querySelector("#pabWhatsApp").hidden, true,
  "the mobile action bar hides the WhatsApp control on a buyable piece");
assert.ok(liveBar.classList.contains("single"),
  "the action bar collapses to one full-width button so the cart is the only action");
assert.equal(live.querySelector("#pabCart").disabled, false, "Add to Cart stays enabled while stock is available");
assert.equal(live.querySelector("#pabCart").textContent.trim(), "Add to Cart", "the mobile bar's single action is Add to Cart");

assert.equal(/Order via WhatsApp/.test(live.body.textContent), false,
  "the words 'Order via WhatsApp' never reach a shopper");
assert.equal(/Real-time WhatsApp rider tracking/.test(live.body.textContent), false,
  "the PDP no longer claims live rider tracking over WhatsApp");
assert.ok(/Delivery updates on WhatsApp/.test(live.body.textContent),
  "the PDP states the delivery update it can actually deliver");

/* ----------------------------------------------------------------- sold out */

const soldDom = renderPdp(baseProduct({ in_stock_count: 0 }));
const sold = soldDom.window.document;
const soldCart = sold.querySelector("#buyCart");
const enquiry = sold.querySelector("#buyEnquiry");

assert.equal(soldCart.disabled, true, "a sold piece cannot be added to a cart");
assert.equal(soldCart.textContent.trim(), "Sold — no longer available", "the sold state is stated on the button");
assert.ok(enquiry, "a sold piece keeps a way to ask for something similar");
assert.equal(enquiry.textContent.trim(), "Ask for something similar", "the sold-out control is an enquiry, not an order");
assert.ok(enquiry.getAttribute("href").startsWith(`https://wa.me/${WA}`),
  "the sold-out enquiry opens the store's WhatsApp line");
assert.equal(/order this item/i.test(decodeURIComponent(enquiry.getAttribute("href"))), false,
  "the sold-out enquiry never pretends to place an order");

const soldWa = sold.querySelector("#pabWhatsApp");
assert.equal(soldWa.hidden, false, "the mobile bar offers the enquiry once the piece is gone");
assert.ok(soldWa.getAttribute("href").startsWith(`https://wa.me/${WA}`), "the mobile enquiry is wired to WhatsApp");
assert.equal(sold.querySelector(".pdp-actionbar-btns").classList.contains("single"), false,
  "a sold piece shows both the disabled cart state and the enquiry");

/* ------------------------------------------------- the rest of the surface */

assert.equal(/wa-fab/.test(homepage), false, "the floating WhatsApp order button is gone from the storefront");
assert.equal(/Order on WhatsApp|Order or track on WhatsApp/.test(homepage), false,
  "no storefront control promises an order over WhatsApp");
assert.equal(/wa-fab|wireWhatsAppLinks|updateFabVisibility/.test(storefrontJs), false,
  "no dead storefront code is left behind for the removed order buttons");
assert.equal(/wa-fab/.test(storefrontCss), false, "no orphaned floating-button styles remain");
assert.ok(/Free pickup at our Kampala store/.test(homepage),
  "the service strip keeps a promise the store can actually keep");

/* --------------------------------------- WhatsApp is still there, honestly */

assert.ok(/missingWhatsApp/.test(productHtml), "an unavailable piece still offers to source a similar one");
assert.ok(/measure it flat/.test(productJs), "an unmeasured piece still offers a WhatsApp measurement request");
assert.ok(/Send WhatsApp Confirmation/.test(read("app.js")),
  "staff still send the order confirmation on WhatsApp from a real POS order");

liveDom.window.close();
soldDom.window.close();

console.log("✓ PDP order path: cart is the only way to order, WhatsApp is enquiry-only, and the delivery claim is honest");
