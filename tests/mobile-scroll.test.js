#!/usr/bin/env node
/* ======================================================================
   Regression tests for the mobile catalog scroll freeze.

   Covers the two halves of the bug:
     A. CSS invariants — no rule may immobilise the page (touch-action:none
        on a root/body scope, a nested scrollport on the catalog <main>, a
        position:fixed overlay with no closed state, an unhideable [hidden]
        element).
     B. Runtime invariants — the scroll lock actually engages, actually
        releases, is idempotent, is reference counted across overlapping
        overlays, and never stamps inline overflow on the catalog region.

   Run:  node tests/mobile-scroll.test.js
   ====================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const csstree = require("css-tree");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ---------------------------------------------------------------- CSS ---- */

const cssText = read("css/storefront.css");
const ast = csstree.parse(cssText, { positions: true });

/** Collect [{selector, declarations:{prop:{value, important}}, line}] */
function collectRules(parsedCss) {
  const collected = [];
  csstree.walk(parsedCss, {
    visit: "Rule",
    enter(node) {
      const selector = csstree.generate(node.prelude);
      const declarations = {};
      csstree.walk(node.block, {
        visit: "Declaration",
        enter(decl) {
          declarations[decl.property.toLowerCase()] = {
            value: csstree.generate(decl.value).trim().toLowerCase(),
            important: !!decl.important
          };
        }
      });
      collected.push({ selector, declarations, line: node.loc ? node.loc.start.line : 0 });
    }
  });
  return collected;
}

const rules = collectRules(ast);
const productRules = collectRules(csstree.parse(read("css/product.css"), { positions: true }));
const ruleWhere = pred => rules.filter(pred);
const productRuleWhere = pred => productRules.filter(pred);
const selectorsMatching = re => ruleWhere(r => re.test(r.selector));

console.log("\nCSS invariants (css/storefront.css)");

check("no rule applies `touch-action: none` at html/body scope", () => {
  const offenders = ruleWhere(r => {
    const ta = r.declarations["touch-action"];
    if (!ta || ta.value !== "none") return false;
    // A body/html-scoped selector is one whose rightmost compound is
    // html or body (optionally with classes) — i.e. it styles the element
    // every touch in the document is nested inside.
    return r.selector
      .split(",")
      .map(s => s.trim())
      .some(s => /(^|\s|>)(html|body)(\.[\w-]+)*$/.test(s));
  });
  assert(
    offenders.length === 0,
    `touch-action:none on a document-level element disables panning for every ` +
    `descendant, including nested scrollers. Offenders: ` +
    offenders.map(o => `"${o.selector}" (line ${o.line})`).join(", ")
  );
});

check("the page scroll lock is declared on the root element", () => {
  const lock = selectorsMatching(/^html\.scroll-locked$/);
  assert(lock.length > 0, "expected an `html.scroll-locked` rule");
  assert(
    lock.some(r => r.declarations.overflow && r.declarations.overflow.value === "hidden"),
    "`html.scroll-locked` must set overflow:hidden — body-level overflow is " +
    "inert because <html> owns the propagated viewport scrollport"
  );
});

check("catalog <main> is never a nested scroll container", () => {
  const catalog = selectorsMatching(/\.catalog-dashboard-region/);
  assert(catalog.length > 0, "expected a `.catalog-dashboard-region` rule");
  for (const r of catalog) {
    for (const prop of ["overflow", "overflow-y"]) {
      const d = r.declarations[prop];
      if (!d) continue;
      assert(
        /^(visible|initial|unset)$/.test(d.value),
        `"${r.selector}" sets ${prop}:${d.value} (line ${r.line}); the product ` +
        `grid wrapper has no height bound, so any scrolling value creates a ` +
        `dead scrollport that swallows touch`
      );
    }
  }
  assert(
    catalog.some(r => r.declarations.overflow && r.declarations.overflow.important),
    "`.catalog-dashboard-region { overflow: visible }` should be !important so " +
    "it outranks a stray inline style (this regression already happened once)"
  );
});

check("every position:fixed full-bleed overlay has a closed state", () => {
  // An overlay that is fixed and covers a large area must be taken out of
  // the hit-test surface when closed: transform/translate off-canvas,
  // visibility:hidden, display:none, pointer-events:none or opacity:0.
  const ESCAPES = ["transform", "visibility", "display", "pointer-events", "opacity"];
  const offenders = [];

  for (const r of rules) {
    const pos = r.declarations.position;
    if (!pos || pos.value !== "fixed") continue;

    const w = (r.declarations.width || {}).value || "";
    const h = (r.declarations.height || {}).value || "";
    const inset = (r.declarations.inset || {}).value || "";
    const big =
      inset === "0" ||
      /100(vw|vh|dvh|%)|85vw|min\(/.test(w) ||
      /100(vh|dvh|%)/.test(h);
    if (!big) continue;

    // Ignore state rules (".x.is-open") — they describe the OPEN state.
    if (/\.(is-active|is-open|open|show)\b/.test(r.selector)) continue;

    const hasEscape = ESCAPES.some(p => r.declarations[p]);
    if (!hasEscape) offenders.push(`"${r.selector}" (line ${r.line})`);
  }

  assert(
    offenders.length === 0,
    `fixed full-bleed overlay(s) with no way to leave the hit-test surface — ` +
    `they sit on top of the catalog and absorb every touch: ${offenders.join(", ")}`
  );
});

check("`[hidden]` cannot be overridden by a component's display rule", () => {
  const hiddenRules = ruleWhere(r =>
    r.selector.split(",").some(s => s.trim() === "[hidden]")
  );
  assert(hiddenRules.length > 0, "expected a global `[hidden]` rule");
  assert(
    hiddenRules.some(
      r => r.declarations.display &&
           r.declarations.display.value === "none" &&
           r.declarations.display.important
    ),
    "`[hidden] { display: none !important }` is required: author rules such as " +
    "`.consent { display: flex }` otherwise beat the UA [hidden] rule and leave " +
    "a position:fixed banner pinned over the catalog"
  );
});

check("overlay scrollers contain their overscroll", () => {
  const scrollers = [
    { selector: ".drawer-body", findRules: ruleWhere },
    { selector: ".plb-stage", findRules: productRuleWhere }
  ];
  for (const { selector, findRules } of scrollers) {
    const matched = findRules(r =>
      r.selector.split(",").some(s => s.trim() === selector)
    );
    assert(matched.length > 0, `expected a \`${selector}\` rule`);
    assert(
      matched.some(r => {
        const ob = r.declarations["overscroll-behavior"];
        return ob && /contain|none/.test(ob.value);
      }),
      `${selector} must set overscroll-behavior:contain so reaching its end does not ` +
      `chain the scroll to the page behind it`
    );
  }
});

check("no scrollable overlay panel sits under a `touch-action: none` ancestor", () => {
  /* touch-action is resolved by intersecting the value of the touched
     element with every ancestor, so `none` anywhere above a scroller
     computes to `none` on the scroller itself and kills it. Check the real
     storefront and product-detail trees against their combined stylesheets. */
  const pages = [
    { html: read("index.html"), rules, scrollers: [".drawer-body", ".sidebar-drawer"] },
    { html: read("product.html"), rules: [...rules, ...productRules], scrollers: [".plb-stage"] }
  ];
  const offenders = [];

  for (const page of pages) {
    const { window } = new JSDOM(page.html);
    const doc = window.document;
    /* Which selectors declare touch-action:none, ignoring state suffixes so
       ".x.open" counts as "could apply to .x". */
    const blockers = [];
    for (const r of page.rules) {
      const ta = r.declarations["touch-action"];
      if (!ta || ta.value !== "none") continue;
      for (const s of r.selector.split(",")) blockers.push(s.trim());
    }

    for (const sel of page.scrollers) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) {
        for (const b of blockers) {
          // Strip state classes to test "can this selector target the ancestor".
          const base = b.replace(/\.(open|is-active|is-open|show)\b/g, "").trim();
          if (!base || base === el.tagName.toLowerCase()) continue;
          let hit = false;
          try { hit = a.matches(base); } catch (e) { /* unsupported selector */ }
          if (hit) {
            offenders.push(
              `${sel} is nested inside <${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}> ` +
              `which matches "${b}"`
            );
          }
        }
      }
    }
    window.close();
  }

  assert(
    offenders.length === 0,
    `touch-action:none on an ANCESTOR makes the panel unscrollable on touch: ` +
    offenders.join("; ")
  );
});

check("the cart drawer has exactly one off-canvas model", () => {
  // #cartDrawer carries both `.cart-drawer` and `.drawer`. If one animates
  // `right` and the other `transform`, a half-applied state parks a fixed
  // panel over the catalog.
  const models = new Set();
  for (const sel of [".drawer", ".cart-drawer"]) {
    const base = ruleWhere(
      r => r.selector.split(",").some(s => s.trim() === sel) &&
           r.declarations.position
    );
    for (const r of base) {
      if (r.declarations.transform) models.add("transform");
      const right = r.declarations.right;
      if (right && /-?\d/.test(right.value) && parseFloat(right.value) !== 0) {
        models.add("offset");
      }
    }
  }
  assert(
    !(models.has("transform") && models.has("offset")),
    "`.drawer` and `.cart-drawer` apply to the same element but use competing " +
    "off-canvas models (transform vs right offset)"
  );
});

/* ------------------------------------------------------------ RUNTIME ---- */

console.log("\nRuntime invariants (scroll lock lifecycle)");

function buildDom() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
       <button id="cartBtn" data-action="open-cart">Cart</button>
       <main id="catalogDashboardRegion" class="rail catalog-dashboard-region"></main>
       <div class="cart-backdrop drawer-backdrop" id="cartBackdrop"></div>
       <aside class="cart-drawer drawer" id="cartDrawer">
         <button id="closeCart" data-action="close-cart">Close</button>
         <div class="drawer-body" id="cartBody"></div>
         <div class="drawer-foot" id="cartFoot"></div>
       </aside>
       <div class="prod-backdrop" id="prodBackdrop"></div>
     </body></html>`,
    { runScripts: "outside-only", url: "https://example.test/" }
  );
  const { window } = dom;
  window.eval(read("js/scrollLock.js"));
  window.eval(read("js/cartController.js"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  return window;
}

const click = (win, sel) =>
  win.document.querySelector(sel).dispatchEvent(
    new win.MouseEvent("click", { bubbles: true })
  );

check("page starts unlocked", () => {
  const win = buildDom();
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "root should not carry the lock on boot");
  assert(win.AdonaiScrollLock.isLocked() === false, "lock should start released");
});

check("opening the cart locks the root, closing it releases", () => {
  const win = buildDom();
  click(win, "#cartBtn");
  assert(win.document.documentElement.classList.contains("scroll-locked"),
    "root must be locked while the drawer is open");

  click(win, "#closeCart");
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "root must be released when the drawer closes — this is the freeze");
  assert(win.AdonaiScrollLock.isLocked() === false, "no lock owners may remain");
});

check("close never stamps inline overflow on the catalog region", () => {
  const win = buildDom();
  const catalog = win.document.getElementById("catalogDashboardRegion");
  click(win, "#cartBtn");
  click(win, "#closeCart");
  assert(
    catalog.style.overflowY === "" && catalog.style.overflow === "",
    `cartController left inline overflow on the catalog <main> ` +
    `(overflow="${catalog.style.overflow}", overflow-y="${catalog.style.overflowY}"), ` +
    `converting the product grid into a nested scrollport`
  );
});

check("close never leaves inline touch-action / overflow on <body>", () => {
  const win = buildDom();
  click(win, "#cartBtn");
  click(win, "#closeCart");
  const s = win.document.body.style;
  assert(
    !s.touchAction && !s.overflow && !s.position,
    `body retained inline styles after close: touch-action="${s.touchAction}", ` +
    `overflow="${s.overflow}", position="${s.position}"`
  );
});

check("open/close are idempotent", () => {
  const win = buildDom();
  click(win, "#cartBtn");
  click(win, "#cartBtn");          // double open must not double-count
  click(win, "#closeCart");
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "a repeated open left an unbalanced reference count, stranding the lock");

  click(win, "#closeCart");        // redundant close must not throw/underflow
  assert(win.AdonaiScrollLock.isLocked() === false, "lock should stay released");
});

check("lock is reference counted across overlapping overlays", () => {
  const win = buildDom();
  const L = win.AdonaiScrollLock;
  const prod = win.document.getElementById("prodBackdrop");

  prod.classList.add("open");
  L.lock("product-modal");
  click(win, "#cartBtn");                              // cart locks too
  click(win, "#closeCart");                            // cart releases
  assert(win.document.documentElement.classList.contains("scroll-locked"),
    "closing the cart released the product modal's lock as well");

  prod.classList.remove("open");
  L.unlock("product-modal");
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "root should unlock once the last overlay closes");
});

check("dynamically injected close buttons are wired (delegation)", () => {
  const win = buildDom();
  click(win, "#cartBtn");
  // renderCart() replaces the drawer footer long after boot.
  win.document.getElementById("cartFoot").innerHTML =
    '<button id="keepShopping" data-action="close-cart">Continue Browsing</button>';
  click(win, "#keepShopping");
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "a close button rendered after boot did not release the lock — the " +
    "original controller only bound buttons present at construction time");
});

check("a stale lock self-heals on boot", () => {
  const win = buildDom();
  // Simulate a page restored from bfcache with the lock still applied and
  // no overlay actually open.
  win.document.documentElement.classList.add("scroll-locked");
  win.document.body.classList.add("cart-drawer-open");
  win.AdonaiScrollLock.selfHeal();
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "self-heal must drop a lock held while nothing is open");
});

check("Escape releases a lock held with nothing open", () => {
  const win = buildDom();
  win.AdonaiScrollLock.lock("orphan");       // owner with no visible overlay
  win.document.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  assert(!win.document.documentElement.classList.contains("scroll-locked"),
    "Escape should be an escape hatch out of a stranded lock");
});

/* ------------------------------------------------------------- REPORT ---- */

console.log(
  `\n${passed} passed, ${failures.length} failed\n`
);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f.name}\n  ${f.message}`);
  process.exit(1);
}
