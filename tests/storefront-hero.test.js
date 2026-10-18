#!/usr/bin/env node
"use strict";

/**
 * Storefront hero — what the store stands for.
 *
 * The banner sells two very different things: brand-new apparel in depth
 * and curated one-of-one vintage. A first-time visitor has to leave it
 * knowing that, knowing what the vintage inspection is worth, and knowing
 * what happens once a piece is gone — otherwise "one-of-one" just sounds
 * like "good luck finding your size".
 *
 * This test locks in:
 *   · the promise block is present, labelled and legible;
 *   · it says the three things it is meant to say;
 *   · it does not restate the operational promises, which the trust strip
 *     below the banner already covers;
 *   · the old run-on paragraph is gone.
 *
 * Run: node tests/storefront-hero.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

const home = read("index.html");
const css = read("css/storefront.css");

let passed = 0;
const ok = label => { passed += 1; console.log("  ✓ " + label); };

/* ------------------------------------------------------------------ *
 * The block itself.
 * ------------------------------------------------------------------ */
assert.match(home, /class="masthead-promise"/, "the hero carries a promise block");
assert.match(home, /class="promise-label"/, "the promise block is labelled");
assert.match(home, /class="promise-line"/, "the promise block states the purpose");
assert.match(home, /class="promise-anchors"/, "the promise block carries its anchors");
ok("the hero carries a labelled promise block");

/* The label says whose promise it is, and it is marked as a moment of its own. */
assert.match(home, /promise-label">\s*<span class="promise-rule"[^>]*><\/span>\s*What Adonai stands for/, "the block says what Adonai stands for");
ok("the block is titled with the store's promise");

/* ------------------------------------------------------------------ *
 * What it has to say.
 * ------------------------------------------------------------------ */
const dom = new JSDOM(home, { url: "http://localhost/", virtualConsole: new VirtualConsole() });
const doc = dom.window.document;
const block = doc.querySelector(".masthead-promise");
assert.ok(block, "the promise block is in the document");

const line = block.querySelector(".promise-line").textContent.replace(/\s+/g, " ").trim();
const anchors = Array.from(block.querySelectorAll(".promise-anchors li")).map(li =>
  li.textContent.replace(/\s+/g, " ").trim()
);
const keys = Array.from(block.querySelectorAll(".promise-key")).map(el => el.textContent.trim());
const tails = Array.from(block.querySelectorAll(".promise-tail")).map(el => el.textContent.trim());

assert.equal(anchors.length, 3, "the promise is carried by three anchors");
assert.match(line, /one-of-one/i, "the purpose names the one-of-one stock");
assert.match(line, /Kampala/i, "the purpose says who delivers it");
assert.match(line, /packed/i, "the purpose says the order is packed by the store");
assert.match(line, /tracked/i, "the purpose says the order is tracked");
ok("the purpose names who delivers the order, and how it is handled");

/* The lede already names the stock. The purpose line must be about service,
   or the banner reads the same sentence twice in a row. */
const lede = (doc.querySelector(".lede").textContent.replace(/\s+/g, " ").trim());
for (const repeated of ["factory-tagged", "hand-inspected", "exist once"]) {
  assert.ok(
    !line.toLowerCase().includes(repeated),
    "the purpose line does not repeat the lede's '" + repeated + "'"
  );
}
assert.ok(!line.toLowerCase().includes("apparel"), "the purpose line does not repeat the lede's subject");
ok("the purpose line and the lede each say something different");

assert.ok(keys.some(k => /factory-new/i.test(k)), "an anchor covers factory-new");
assert.ok(keys.some(k => /inspected/i.test(k) && /graded/i.test(k)), "an anchor covers the inspection and grading");
assert.ok(keys.some(k => /one-of-one/i.test(k)), "an anchor covers one-of-one scarcity");
assert.ok(tails.some(t => /size/i.test(t)), "the new-stock anchor answers the size question");
assert.ok(tails.some(t => /condition/i.test(t)), "the vintage anchor answers the condition question");
assert.ok(tails.some(t => /gone/i.test(t)), "the one-of-one anchor says what happens when it leaves");
ok("the three anchors answer the three questions a first-time visitor has");

/* ------------------------------------------------------------------ *
 * It must not repeat what the trust strip already says.
 * ------------------------------------------------------------------ */
const trustStrip = (home.match(/<ul class="trust-strip[\s\S]*?<\/ul>/) || [""])[0];
assert.ok(trustStrip.length > 0, "the trust strip is still on the page");
const promiseText = (line + " " + anchors.join(" ")).toLowerCase();
for (const owned of ["2-day returns", "pay on delivery", "free pickup", "same-day"]) {
  assert.ok(
    !promiseText.includes(owned),
    "the promise does not restate the trust strip's '" + owned + "' promise"
  );
}
ok("the promise and the trust strip do not say the same thing twice");

/* ------------------------------------------------------------------ *
 * The old paragraph is gone, and the styling is in place.
 * ------------------------------------------------------------------ */
assert.doesNotMatch(home, /lede-more/, "the run-on paragraph is gone from the hero");
assert.doesNotMatch(css, /\.lede-more/, "the rule that hid the run-on paragraph is gone");
ok("the run-on paragraph is gone, and its rule with it");

assert.match(css, /\.masthead-promise::before/, "the promise block is separated by a fading hairline");
assert.match(css, /\.promise-label\s*\{[^}]*text-transform:\s*uppercase/, "the label is set as a small caps eyebrow");
assert.match(css, /\.promise-rule/, "the label is marked with a short rule");
assert.match(css, /\.promise-anchors\s*\{[^}]*max-width/, "the anchors are kept to a readable measure");
assert.match(css, /\.promise-anchors li::before/, "each anchor carries a brand-gold marker");
assert.match(css, /#DA9902/, "the marker uses the brand gold");
assert.match(css, /\.promise-line\s*\{[^}]*text-wrap:\s*balance/, "the purpose line is set with balanced lines");
ok("the promise block is styled like part of the brand");

/* It must stay on a phone, only trimmed — and the phone tuning has to come
   after the base rules or the cascade quietly ignores it. */
const phoneBlocks = (css.match(/@media \(max-width: 700px\)\s*\{[\s\S]*?\n\}/g) || [])
  .filter(block => /\.masthead-promise/.test(block));
assert.ok(phoneBlocks.length > 0, "the promise block is tuned for the phone");
assert.doesNotMatch(phoneBlocks[0], /\.masthead-promise\s*\{[^}]*display:\s*none/, "the promise block is not hidden on a phone");
const baseRule = css.indexOf(".masthead-promise {");
const phoneRule = css.indexOf(phoneBlocks[0]);
assert.ok(phoneRule > baseRule, "the phone tuning comes after the base rules");
ok("the promise survives on a phone, trimmed but present");

/* ------------------------------------------------------------------ *
 * The hero runs full bleed, so the photograph reaches the top of the
 * page and sits behind the buttons in the bar.
 * ------------------------------------------------------------------ */
const hero = doc.querySelector("section.masthead");
assert.ok(hero, "the hero is a section of its own");
assert.ok(!hero.classList.contains("wrap"), "the hero is not held to the narrow wrap");
assert.ok(hero.querySelector(":scope > .wrap"), "the hero still carries a wrap for the copy");
assert.ok(hero.querySelector(".masthead-inner"), "the copy column is intact");
assert.ok(hero.querySelector(".wrap .masthead-inner"), "the copy column sits inside the wrap, so it stays aligned with the bar");
ok("the hero is full bleed while the copy stays aligned with the header");

/* It slides up behind the bar by exactly the bar's height. */
const mastheadRule = (css.match(/\.masthead\s*\{([^}]*)\}/) || [, ""])[1];
assert.match(mastheadRule, /margin:\s*calc\(-1 \* var\(--head-h\)\)/, "the hero is pulled up behind the bar");
assert.match(mastheadRule, /padding:\s*calc\(50px \+ var\(--head-h\)\)/, "the copy keeps its 50px of room below the bar");
assert.match(mastheadRule, /storefront-editorial-bg\.jpg/, "the hero carries the editorial photograph");
assert.match(css, /:root\s*\{[^}]*--head-h:\s*76px/, "the bar's height is a variable the hero can use");
ok("the hero slides up behind the bar and keeps the photograph");

/* The bar has to be see-through for that to show. */
assert.match(home, /class="site-head site-head--hero"/, "the storefront's bar floats over the hero");
assert.match(css, /\.site-head--hero::after\s*\{[^}]*opacity:\s*0/, "the bar's surface is hidden over the hero");
ok("the bar is transparent over the hero, so the photograph shows behind the buttons");

console.log("\n✓ storefront hero promise holds (" + passed + " checks)\n");
