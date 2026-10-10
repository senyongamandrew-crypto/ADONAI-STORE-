#!/usr/bin/env node
/* Regression test for the mobile POS checkout dock's presentation bridge.
 * It must mirror the live cart values and delegate actions to the original
 * cart toggle / charge button without owning any sale state.
 * Run: node tests/pos-ui.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="appShell" class="pos-app">
    <main class="pos-dashboard-layout"></main>
    <aside id="posCart">
      <button id="cartToggle" aria-expanded="false"></button>
      <span id="ctCount">0</span><span id="ctTotal">UGX 0</span>
      <button id="btnCharge" disabled>Charge · UGX 0</button>
    </aside>
    <div id="posCheckoutBar" aria-hidden="true">
      <button id="posQuickCart" aria-expanded="false"><span id="posQuickCount">0</span></button>
      <strong id="posQuickTotal">UGX 0</strong>
      <button id="posQuickCharge" disabled>Charge</button>
    </div>
  </div>
</body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });

const { window } = dom;
const doc = window.document;
const tick = () => new Promise(resolve => window.setTimeout(resolve, 0));

async function main() {
  let drawerClicks = 0;
  let chargeClicks = 0;
  const cartToggle = doc.querySelector("#cartToggle");
  const chargeButton = doc.querySelector("#btnCharge");

  // Stand-ins for the existing controls' handlers, used to assert delegation.
  cartToggle.addEventListener("click", () => {
    drawerClicks++;
    cartToggle.setAttribute("aria-expanded", cartToggle.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });
  chargeButton.addEventListener("click", () => { chargeClicks++; });

  window.eval(fs.readFileSync(path.join(ROOT, "js/pos-ui.js"), "utf8"));
  const layout = doc.querySelector(".pos-dashboard-layout");
  const dock = doc.querySelector("#posCheckoutBar");
  const quickCart = doc.querySelector("#posQuickCart");
  const quickCharge = doc.querySelector("#posQuickCharge");

  assert.equal(dock.getAttribute("aria-hidden"), "true", "empty cart dock starts hidden");
  assert.equal(quickCharge.disabled, true, "empty cart cannot be charged");

  layout.classList.add("has-cart-items");
  doc.querySelector("#ctCount").textContent = "2";
  doc.querySelector("#ctTotal").textContent = "UGX 75,000";
  chargeButton.disabled = false;
  await tick();

  assert.equal(dock.getAttribute("aria-hidden"), "false", "dock becomes available with cart items");
  assert.equal(doc.querySelector("#posQuickCount").textContent, "2", "dock mirrors item count");
  assert.equal(doc.querySelector("#posQuickTotal").textContent, "UGX 75,000", "dock mirrors cart total");
  assert.equal(quickCharge.disabled, false, "dock charge follows original button enabled state");

  quickCart.click();
  quickCharge.click();
  await tick();
  assert.equal(drawerClicks, 1, "cart shortcut delegates to original drawer toggle");
  assert.equal(chargeClicks, 1, "charge shortcut delegates to original charge action");
  assert.equal(quickCart.getAttribute("aria-expanded"), "true", "drawer state is mirrored accessibly");

  layout.classList.remove("has-cart-items");
  chargeButton.disabled = true;
  await tick();
  assert.equal(dock.getAttribute("aria-hidden"), "true", "dock hides again when the cart is cleared");
  assert.equal(quickCharge.disabled, true, "charge is disabled again when the cart is cleared");

  console.log("✓ POS quick-checkout dock mirrors cart UI and delegates to existing actions");
  dom.window.close();
}

main().catch(error => {
  console.error(error);
  dom.window.close();
  process.exitCode = 1;
});
