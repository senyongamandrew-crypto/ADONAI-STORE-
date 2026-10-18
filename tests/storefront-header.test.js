#!/usr/bin/env node
"use strict";

/**
 * Storefront header — design contract.
 *
 * The bar is the one piece of chrome every shopper sees. This test locks in
 * the contract that makes it read as a designed header rather than three
 * loose buttons:
 *
 *   · a clear hierarchy — the brand is a quiet anchor, "Install App" is a
 *     secondary affordance, the cart is the single primary action;
 *   · the cart count rides the cart icon as a superscript badge and is not
 *     shown at all while the cart is empty;
 *   · the badge is a live region, so adding a piece is announced;
 *   · the pages that own the count (storefront, product page) keep the
 *     existing DOM contract: #installBtn, #cartBtn, #cartCount;
 *   · the static pages reuse .site-head / .head-row / .head-pill and must
 *     not break.
 *
 * Run: node tests/storefront-header.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

const storefrontHtml = read("index.html");
const productHtml = read("product.html");
const headerCss = read("css/storefront.css");
const headerJs = read("js/header.js");

let passed = 0;
const ok = label => { passed += 1; console.log("  ✓ " + label); };

/* ------------------------------------------------------------------ *
 * 1. The markup contract both pages depend on.
 * ------------------------------------------------------------------ */
for (const [name, html] of [["storefront", storefrontHtml], ["product page", productHtml]]) {
  assert.match(html, /class="site-head[ "]/, name + " keeps the .site-head bar");
  assert.match(html, /class="wrap head-row"/, name + " keeps the .wrap .head-row layout");
  assert.match(html, /class="brand"/, name + " keeps the .brand link");
  assert.match(html, /brand-logo-img/, name + " keeps the .brand-logo-img");
  assert.match(html, /id="cartBtn"/, name + " keeps #cartBtn");
  assert.match(html, /id="cartCount"/, name + " keeps #cartCount");
  assert.match(html, /class="cart-ico"/, name + " wraps the cart icon for the badge");
  assert.match(html, /id="cartStatus"/, name + " carries the spoken count");
  assert.match(html, /role="status"[^>]*aria-live="polite"/, name + " announces the count politely");
  assert.match(html, /aria-atomic="true"/, name + " announces the count atomically");
  assert.match(html, /id="cartBtn"[^>]*aria-label="Cart"/, name + " names the cart button");
}
ok("storefront and product page both keep the header DOM contract");

/* The storefront owns the Install App button; the product page keeps a
   back link and the cart. */
assert.match(storefrontHtml, /id="installBtn"/, "the storefront keeps #installBtn");
assert.match(storefrontHtml, /head-install-label/, "the install button has a collapsible label");
assert.match(productHtml, /pdp-back-link/, "the product page keeps its back link");
ok("the install button lives on the storefront, the back link on the product page");

/* The cart button is the primary action and keeps its open-cart contract. */
assert.match(storefrontHtml, /id="cartBtn"[^>]*data-action="open-cart"/, "the cart button keeps data-action=open-cart");
assert.match(storefrontHtml, /<span class="cart-label"[^>]*>Cart<\/span>/, "the cart button keeps its label");
ok("the cart button keeps its open-cart contract and label");

/* ------------------------------------------------------------------ *
 * 2. The CSS: hierarchy, surface, badge, responsive rules.
 * ------------------------------------------------------------------ */
assert.match(headerCss, /\.site-head::after\s*\{[^}]*backdrop-filter/, "the bar's sheet has a blurred translucent surface");
assert.match(headerCss, /\.site-head::before/, "the bar carries a brand-gold hairline");
assert.match(headerCss, /#DA9902/, "the hairline uses the brand gold");
assert.match(headerCss, /\.site-head\.is-scrolled/, "the bar has a scroll-elevation state");
assert.match(headerCss, /\.cart-btn\s*\{[^}]*background:\s*var\(--ink\)/, "the cart is the dark primary action");
assert.match(headerCss, /\.head-pill\s*\{[^}]*background:\s*rgba\(255, 255, 255, \.65\)/, "the install button is a quiet secondary action");
assert.match(headerCss, /\.cart-count\s*\{[^}]*position:\s*absolute/, "the count is a superscript badge on the icon");
assert.match(headerCss, /\.cart-count\.is-empty/, "the badge is hidden while the cart is empty");
assert.match(headerCss, /\.cart-count\.bump/, "the badge pops when a piece is added");
assert.match(headerCss, /\.brand:focus-visible/, "the brand has a visible focus ring");
assert.match(headerCss, /\.head-pill:focus-visible/, "the install button has a visible focus ring");
assert.match(headerCss, /\.cart-btn:focus-visible/, "the cart has a visible focus ring");
assert.match(headerCss, /prefers-reduced-motion/, "the header respects reduced-motion");
ok("the header stylesheet carries the surface, hierarchy, badge and focus states");

/* The surface is a separate sheet so it can fade in: over the hero the bar
   must be see-through, and on every other page it must be solid. */
assert.match(headerCss, /\.site-head--hero::after\s*\{[^}]*opacity:\s*0/, "over the hero the bar starts transparent");
assert.match(headerCss, /\.site-head--hero\.is-scrolled::after\s*\{[^}]*opacity:\s*1/, "the bar's sheet returns once the page moves");
assert.match(headerCss, /\.site-head--hero \.head-pill\s*\{[^}]*background:\s*rgba\(255, 255, 255, \.88\)/, "the secondary button carries its own surface over the photograph");
assert.match(storefrontHtml, /class="site-head site-head--hero"/, "the storefront opts the bar into the hero treatment");
for (const [name, html] of [["product page", productHtml], ["404", read("404.html")], ["500", read("500.html")]]) {
  assert.doesNotMatch(html, /site-head--hero/, name + " does not opt into the hero treatment");
}
ok("only the storefront floats its bar over the hero");

/* The badge is decoration; the count is carried to assistive technology by
   .cart-status, so the badge itself may be display:none when empty. */
const emptyRule = (headerCss.match(/\.cart-count\.is-empty\s*\{([^}]*)\}/) || [, ""])[1];
assert.match(emptyRule, /display:\s*none/, "the empty badge is hidden outright");
assert.match(headerCss, /\.cart-status\s*\{[^}]*clip-path/, "the spoken count is visually hidden");
ok("the badge is decoration and the spoken count lives in its own live region");

/* Touch targets. The bar's height is a variable, because the hero uses it
   to slide up behind the bar. */
const headRow = (headerCss.match(/\.head-row\s*\{([^}]*)\}/) || [, ""])[1];
assert.match(headRow, /height:\s*var\(--head-h\)/, "the desktop bar is as tall as --head-h");
assert.match(headerCss, /:root\s*\{[^}]*--head-h:\s*76px/, "the desktop bar is 76px tall");
assert.match(headerCss, /\.cart-btn\s*\{[^}]*min-height:\s*44px/, "the cart is at least a 44px touch target");
assert.match(headerCss, /\.head-pill\s*\{[^}]*min-height:\s*42px/, "the install button is at least a 42px touch target");
assert.match(headerCss, /\.head-install\s*\{[^}]*width:\s*42px/, "the collapsed install button keeps a 42px target");
ok("the header meets the touch-target floor");

/* The phone breakpoint collapses the install label to an icon. */
const mobileBlock = (headerCss.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/) || [, ""])[1];
assert.match(mobileBlock, /\.head-install-label\s*\{\s*display:\s*none/, "the install label is hidden on a phone");
assert.match(headerCss, /@media \(max-width: 640px\)\s*\{\s*:root\s*\{\s*--head-h:\s*66px/, "the bar tightens on a phone");
ok("the phone breakpoint collapses Install App to an icon-only button");

/* ------------------------------------------------------------------ *
 * 3. The behaviour.
 * ------------------------------------------------------------------ */
assert.match(headerJs, /classList\.toggle\("is-scrolled"/, "the script drives the scroll elevation");
assert.match(headerJs, /MutationObserver/, "the script watches the count the pages write");
assert.match(headerJs, /classList\.toggle\("is-empty"/, "the script hides the badge when the cart is empty");
assert.match(headerJs, /classList\.add\("bump"\)/, "the script pops the badge when the count rises");
assert.match(headerJs, /setAttribute\("aria-label"/, "the script keeps the cart button's name accurate");
assert.match(headerJs, /status\.textContent/, "the script writes the spoken count");
ok("js/header.js owns the scroll elevation and the badge state");

/* Both pages must load the shared script. */
assert.match(storefrontHtml, /js\/header\.js/, "the storefront loads the shared header script");
assert.match(productHtml, /js\/header\.js/, "the product page loads the shared header script");
ok("both pages load the shared header script");

/* The pages that write the count must still be the ones writing it. */
assert.match(read("js/storefront.js"), /\$\("#cartCount"\)\.textContent/, "the storefront still writes #cartCount");
assert.match(read("js/product.js"), /cartCount/, "the product page still writes #cartCount");
ok("the existing count writers are untouched");

/* ------------------------------------------------------------------ *
 * 4. Behaviour, exercised in a DOM.
 * ------------------------------------------------------------------ */
async function boot(html) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/",
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.eval(headerJs);
  await new Promise(r => setTimeout(r, 60));
  return w;
}

(async () => {
  const w = await boot(storefrontHtml);
  const doc = w.document;
  const head = doc.querySelector(".site-head");
  const count = doc.querySelector("#cartCount");
  const tick = () => new Promise(r => setTimeout(r, 60));

  assert.ok(count.classList.contains("is-empty"), "the badge starts hidden");
  ok("the badge starts hidden for an empty cart");

  Object.defineProperty(w, "scrollY", { value: 240, configurable: true });
  w.dispatchEvent(new w.Event("scroll"));
  await tick();
  assert.ok(head.classList.contains("is-scrolled"), "the bar lifts once the page is scrolled");
  ok("the bar lifts once the shopper starts reading");

  count.textContent = "1";
  await tick();
  assert.ok(!count.classList.contains("is-empty"), "the badge shows once there is a piece in the cart");
  assert.ok(count.classList.contains("bump"), "the badge pops on the first piece");
  assert.equal(doc.getElementById("cartBtn").getAttribute("aria-label"), "Cart, 1 item", "the button names the piece");
  assert.equal(doc.getElementById("cartStatus").textContent, "1 item in your cart", "the count is spoken");
  ok("adding a piece reveals the badge, pops it, and is announced");

  count.textContent = "4";
  await tick();
  assert.equal(count.textContent, "4", "the count is still written by the page");
  assert.ok(!count.classList.contains("is-empty"), "the badge stays visible");
  assert.equal(doc.getElementById("cartBtn").getAttribute("aria-label"), "Cart, 4 items", "the button names the pieces");
  assert.equal(doc.getElementById("cartStatus").textContent, "4 items in your cart", "the count is spoken");
  ok("the page keeps writing the count and the badge follows");

  count.textContent = "0";
  await tick();
  assert.ok(count.classList.contains("is-empty"), "the badge disappears when the cart empties");
  assert.equal(doc.getElementById("cartBtn").getAttribute("aria-label"), "Cart, empty", "the button says the cart is empty");
  ok("emptying the cart hides the badge again");

  /* The static pages reuse the bar; they must not break it. */
  for (const file of ["404.html", "500.html"]) {
    const page = read(file);
    assert.match(page, /class="site-head"/, file + " reuses the bar");
    assert.match(page, /class="head-pill"/, file + " reuses the quiet pill");
  }
  ok("the 404 and 500 pages reuse the redesigned bar without breaking");

  /* A cart restored as the page boots is not an action: the badge should
     appear without popping at a shopper who touched nothing. */
  const booting = new JSDOM(storefrontHtml, {
    runScripts: "outside-only",
    url: "http://localhost/",
    virtualConsole: new VirtualConsole(),
  });
  Object.defineProperty(booting.window.document, "readyState", { value: "loading", configurable: true });
  booting.window.scrollTo = () => {};
  booting.window.eval(headerJs);
  const bootingCount = booting.window.document.getElementById("cartCount");
  bootingCount.textContent = "3";
  await new Promise(r => setTimeout(r, 60));
  assert.ok(!bootingCount.classList.contains("is-empty"), "a restored cart still shows its badge");
  assert.ok(!bootingCount.classList.contains("bump"), "a restored cart does not pop the badge");
  ok("a cart restored on page load appears quietly, without popping");

  console.log("\n✓ storefront header contract holds (" + passed + " checks)\n");
})().catch(err => {
  console.error("\n✗ storefront header contract broken\n");
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
