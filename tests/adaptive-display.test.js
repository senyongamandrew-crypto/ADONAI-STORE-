#!/usr/bin/env node
/* ======================================================================
   Regression tests for the device-fit display layer.

   Covers the cross-device sizing fix:
     A. CSS — mobile font inflation is disabled, and every type value is a
        fluid `vmin` token multiplied by --ui-font-scale, so a phone in
        landscape (or any short screen) can no longer be served the laptop
        type scale. Component rules stay scoped to the staff shells.
     B. JS — the device class follows the SHORT side of the screen, and the
        Display size control (Compact / Standard / Large) applies, persists
        and restores without touching any sale/stock logic.

   Run:  node tests/adaptive-display.test.js
   ====================================================================== */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const csstree = require("css-tree");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

const CSS_FILE = "css/adaptive-display.css";
const LINK = "css/adaptive-display.css";

/* ---------------------------------------------------------------- CSS ---- */

const cssText = read(CSS_FILE);

function collectRules(parsedCss) {
  const collected = [];
  csstree.walk(parsedCss, {
    visit: "Rule",
    enter(node) {
      const declarations = {};
      csstree.walk(node.block, {
        visit: "Declaration",
        enter(decl) {
          declarations[decl.property.toLowerCase()] = csstree.generate(decl.value).trim();
        }
      });
      collected.push({ selector: csstree.generate(node.prelude), declarations });
    }
  });
  return collected;
}

function declarationsFor(rules, selector) {
  const hit = rules.find(rule => rule.selector.split(",").map(s => s.trim()).includes(selector));
  return hit ? hit.declarations : null;
}

console.log("\nCSS: device-fit display layer");

const ast = csstree.parse(cssText, { positions: true });
const rules = collectRules(ast);
assert(rules.length > 20, "the display layer must ship real component rules");
console.log("✓ css/adaptive-display.css parses as valid CSS");

const htmlRule = declarationsFor(rules, "html");
assert(htmlRule, "expected an `html` rule");
assert.equal(htmlRule["-webkit-text-size-adjust"], "100%", "iOS landscape text inflation must be disabled");
assert.equal(htmlRule["text-size-adjust"], "100%", "standard text-size-adjust must be disabled");
console.log("✓ mobile font inflation (iOS landscape / Android boosting) is switched off at the root");

const rootRule = declarationsFor(rules, ":root");
assert(rootRule, "expected the `:root` token block");
const tokens = Object.keys(rootRule).filter(name => name.startsWith("--fs-"));
assert(tokens.length >= 12, `expected the full fluid type scale, found ${tokens.length}`);
for (const token of tokens) {
  const value = rootRule[token];
  assert(/vmin/.test(value), `${token} must scale with the short side of the screen (vmin)`);
  assert(/clamp\(/.test(value), `${token} must be clamped between a floor and a ceiling`);
  assert(value.includes("var(--ui-font-scale)"), `${token} must answer the Display size control`);
}
assert.equal(rootRule["--ui-font-scale"], "1", "Standard density is the default multiplier");
console.log(`✓ ${tokens.length} fluid vmin type tokens, all driven by --ui-font-scale`);

const posRules = rules.filter(rule => /\.pos-app\b/.test(rule.selector));
assert(posRules.length >= 25, "expected the POS register typography to be tokenised");
for (const rule of posRules) {
  assert(
    rule.selector.includes("html[data-display-size]") &&
    rule.selector.includes(".pos-app"),
    `POS rule must stay scoped to the register shell: ${rule.selector}`
  );
}
console.log(`✓ ${posRules.length} POS rules apply the scale inside .pos-app only`);

const adminRules = rules.filter(rule => /#shell|\.suite-gate|#modalBackdrop/.test(rule.selector));
assert(adminRules.length >= 20, "expected the Admin Suite typography to be tokenised");
for (const rule of adminRules) {
  assert(
    /\.suite-gate|#shell|#modalBackdrop/.test(rule.selector),
    `admin rule must stay scoped to a console shell: ${rule.selector}`
  );
}
console.log(`✓ ${adminRules.length} Admin Suite rules stay inside #shell / .suite-gate / #modalBackdrop`);

const unscoped = rules.filter(rule => {
  const selector = rule.selector;
  if (/\.ds-|html\[data-display-size\]|^html$|^:root$|^body,|^body$|^img|^\*/.test(selector)) return false;
  if (/pos-app|#shell|suite-gate|modalBackdrop/.test(selector)) return false;
  return true;
});
assert.deepEqual(
  unscoped.map(rule => rule.selector), [],
  "no rule may leak into the storefront, rider app or print sheets"
);
console.log("✓ no rule leaks outside the staff shells (storefront, rider app and print rules untouched)");

const touchFloor = rules.filter(rule => /max\(16px,\s*var\(--fs-input\)\)/.test(JSON.stringify(rule.declarations)));
assert(touchFloor.length > 0, "16px input floor must survive the scale (mobile focus auto-zoom)");
console.log("✓ inputs keep the 16px touch floor that stops mobile focus auto-zoom");

/* -------------------------------------------------------------- SHELLS ---- */

function stylesheetOrder(file) {
  const html = read(file);
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1].split("?")[0]);
  return { html, links };
}

for (const file of ["pos.html", "admin.html"]) {
  const { html, links } = stylesheetOrder(file);
  assert(links.includes(LINK), `${file} must load ${LINK}`);
  assert.equal(links[links.length - 1], LINK, `${file} must load the display layer last so it wins the cascade`);
  assert(
    /<html lang="en" data-display-size="standard">/.test(html),
    `${file} must publish a default density before js/adaptive.js boots`
  );
  for (const size of ["compact", "standard", "large"]) {
    assert(
      html.includes(`data-display-size-option="${size}"`),
      `${file} must offer the ${size} density control`
    );
  }
  assert(/data-display-size-option="standard"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-display-size-option="standard"/.test(html),
    `${file} must mark Standard as the pressed default`);
  console.log(`✓ ${file} loads the layer last and ships the Compact / Standard / Large control`);
}

const icons = read("js/icons.js");
assert(icons.includes('"monitor"'), "the density control icon must exist in js/icons.js");
console.log("✓ density control icon ships with the shared icon set");

/* ------------------------------------------------------------ RUNTIME ---- */

const adaptiveSource = read("js/adaptive.js");

function boot({ url = "https://appassets.androidplatform.net/pos.html", innerWidth = 360, innerHeight = 740, touch = true, stored = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="en" data-display-size="standard"><body>
    <div class="ds-panel" role="group" aria-label="Display size">
      <button type="button" data-display-size-option="compact" aria-pressed="false">Compact</button>
      <button type="button" data-display-size-option="standard" aria-pressed="true">Standard</button>
      <button type="button" data-display-size-option="large" aria-pressed="false">Large</button>
    </div>
  </body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });

  const { window } = dom;
  Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", { value: touch ? 5 : 0, configurable: true });
  if (touch) window.ontouchstart = null;
  if (stored) window.localStorage.setItem("adonai.ui.display-size", stored);

  window.eval(adaptiveSource);
  return dom;
}

const devices = [
  { name: "phone portrait 360x740", innerWidth: 360, innerHeight: 740, touch: true, expect: "phone" },
  { name: "phone landscape 780x360", innerWidth: 780, innerHeight: 360, touch: true, expect: "phone" },
  { name: "tablet 834x1112", innerWidth: 834, innerHeight: 1112, touch: true, expect: "tablet" },
  { name: "laptop 1440x900", innerWidth: 1440, innerHeight: 900, touch: false, expect: "desktop" },
  { name: "desktop window 1000x700", innerWidth: 1000, innerHeight: 700, touch: false, expect: "desktop" }
];

for (const device of devices) {
  const dom = boot(device);
  try {
    assert.equal(
      dom.window.document.documentElement.getAttribute("data-device"), device.expect,
      `${device.name} must be handled as ${device.expect}`
    );
  } finally { dom.window.close(); }
}
console.log("✓ device class follows the SHORT side of the screen (landscape phones stay phones)");

{
  const dom = boot({ innerWidth: 780, innerHeight: 360, touch: true });
  try {
    const root = dom.window.document.documentElement;
    assert.equal(root.getAttribute("data-viewport"), "compact", "short screens publish the compact viewport class");
    assert.equal(root.getAttribute("data-pointer"), "touch");
    assert.equal(root.getAttribute("data-orientation"), "landscape");
  } finally { dom.window.close(); }
  console.log("✓ short landscape screens publish data-viewport=compact for the compact type scale");
}

{
  const dom = boot({ innerWidth: 1440, innerHeight: 900, touch: false });
  try {
    assert.equal(dom.window.document.documentElement.getAttribute("data-viewport"), "wide");
  } finally { dom.window.close(); }
  console.log("✓ laptops publish data-viewport=wide and keep the full-size type scale");
}

{
  const dom = boot({ stored: "large" });
  const { window } = dom;
  try {
    const root = window.document.documentElement;
    assert.equal(root.getAttribute("data-display-size"), "large", "saved density applies on boot");
    assert.equal(root.style.getPropertyValue("--ui-font-scale"), "1.15", "Large publishes the 1.15 multiplier");
    assert.equal(root.style.getPropertyValue("--app-vh"), "740px", "existing viewport-height contract is preserved");
    assert.equal(
      window.document.querySelector('[data-display-size-option="large"]').getAttribute("aria-pressed"), "true",
      "the control paints the saved density"
    );
  } finally { window.close(); }
  console.log("✓ a saved Display size is restored on boot and painted on the control");
}

{
  const dom = boot({ url: "https://appassets.androidplatform.net/pos.html?display=compact" });
  const { window } = dom;
  try {
    const root = window.document.documentElement;
    assert.equal(root.getAttribute("data-display-size"), "compact", "?display= URL override applies");
    assert.equal(root.style.getPropertyValue("--ui-font-scale"), "0.86", "Compact publishes the 0.86 multiplier");
    assert.equal(window.localStorage.getItem("adonai.ui.display-size"), null, "a URL override never rewrites the saved choice");
  } finally { window.close(); }
  console.log("✓ ?display=compact previews a density without saving it");
}

{
  const dom = boot();
  const { window } = dom;
  try {
    const root = window.document.documentElement;
    const events = [];
    window.addEventListener("adonai:display-size", event => events.push(event.detail.size));

    window.document.querySelector('[data-display-size-option="large"]').click();
    assert.equal(root.getAttribute("data-display-size"), "large", "tapping Large switches the density");
    assert.equal(root.style.getPropertyValue("--ui-font-scale"), "1.15");
    assert.equal(window.localStorage.getItem("adonai.ui.display-size"), "large", "the choice is saved on this device");
    assert.equal(window.AdonaiDisplay.get(), "large");

    window.document.querySelector('[data-display-size-option="compact"]').click();
    assert.equal(root.getAttribute("data-display-size"), "compact", "tapping Compact switches back down");
    assert.equal(window.localStorage.getItem("adonai.ui.display-size"), "compact");
    assert.equal(
      window.document.querySelector('[data-display-size-option="compact"]').getAttribute("aria-pressed"), "true",
      "the active option is announced to assistive tech"
    );
    assert.equal(
      window.document.querySelector('[data-display-size-option="large"]').getAttribute("aria-pressed"), "false"
    );

    window.AdonaiDisplay.reset();
    assert.equal(root.getAttribute("data-display-size"), "standard");
    assert.deepEqual(events, ["large", "compact", "standard"], "every change announces itself to the shells");
  } finally { window.close(); }
  console.log("✓ the Display size control applies, persists, animates the pressed state and announces changes");
}

{
  const dom = boot({ url: "https://appassets.androidplatform.net/pos.html?fit=off" });
  const { window } = dom;
  try {
    assert.equal(
      window.document.documentElement.getAttribute("data-display-size"), null,
      "?fit=off must render the shell without the display layer (before/after comparison)"
    );
    assert.equal(window.AdonaiDisplay.disabled(), true, "the layer reports that it is disabled for this load");
  } finally { window.close(); }
  console.log("✓ ?fit=off reproduces the pre-fix rendering for one load");
}

{
  const dom = boot({ stored: "nonsense" });
  const { window } = dom;
  try {
    assert.equal(
      window.document.documentElement.getAttribute("data-display-size"), "standard",
      "an unknown saved value falls back to Standard instead of breaking the shell"
    );
  } finally { window.close(); }
  console.log("✓ an unknown stored density degrades to Standard");

  const noTouch = boot({ innerWidth: 900, innerHeight: 700, touch: false });
  try {
    assert.equal(
      noTouch.window.document.documentElement.getAttribute("data-device"), "desktop",
      "a 900x700 desktop window is not misread as a tablet"
    );
  } finally { noTouch.window.close(); }
  console.log("✓ desktop windows are not misread as tablets");
}

/* ----------------------------------------------------------- HARNESS ---- */

{
  const harness = new JSDOM(read("device-preview.html"), {
    url: "https://appassets.androidplatform.net/device-preview.html",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const { window } = harness;
  try {
    const doc = window.document;
    const frames = doc.querySelectorAll("iframe");
    assert.equal(frames.length, 4, "the harness must render four device frames");
    const viewports = [...frames].map(frame => `${frame.getAttribute("width")}x${frame.getAttribute("height")}`);
    assert.deepEqual(
      viewports,
      ["360x740", "780x360", "834x1112", "1280x800"],
      "phone portrait, phone landscape, tablet and laptop viewports must all be covered"
    );
    for (const frame of frames) {
      assert.match(frame.getAttribute("src"), /(pos|admin)\.html\?display=(compact|standard|large)/,
        "every frame must preview a real shell at the chosen density");
    }
    doc.querySelector('#sizeSeg button[data-size="compact"]').click();
    assert.equal(window.localStorage.getItem("adonai.ui.display-size"), "compact",
      "the harness writes the same saved density the app reads");
    assert.match(doc.querySelector("iframe").getAttribute("src"), /pos\.html\?display=compact/,
      "switching density must reload the frames with the new value");
    doc.querySelector('#pageSeg button[data-page="admin.html"]').click();
    assert.match(doc.querySelector("iframe").getAttribute("src"), /admin\.html\?display=compact/,
      "the page switch must retarget the frames");
    doc.querySelector('#fitSeg button[data-fit="off"]').click();
    assert.match(doc.querySelector("iframe").getAttribute("src"), /admin\.html\?display=compact&fit=off/,
      "the before/after switch must request the pre-fix rendering");
  } finally { window.close(); }
  console.log("✓ device-preview.html builds the four real-device frames and drives the saved density");
}

console.log("\nAll adaptive display checks passed.\n");
