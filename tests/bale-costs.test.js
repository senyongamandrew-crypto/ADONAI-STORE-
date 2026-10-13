#!/usr/bin/env node
/* Bale Costs panel: structure, owned-form preservation, cash-share rendering,
 * consignment gating and payout controls. Runs admin.html in jsdom with a stubbed
 * finance API. Run: node tests/bale-costs.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
const bundle = fs.readFileSync(path.join(ROOT, "js", "bale-costs.js"), "utf8");

let passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${label}`); }
  catch (error) { console.log(`  FAIL  ${label}\n        ${error.message}`); process.exitCode = 1; }
}

// ---- Structure (static) -----------------------------------------------------
check("panel exposes owned and consignment mode toggles", () => {
  assert.ok(html.includes('id="bcModeOwned"') && html.includes('id="bcModeConsign"'));
  assert.ok(html.includes('data-bc-mode="owned"') && html.includes('data-bc-mode="consignment"'));
});

check("owned-bale form keeps every element the existing intake logic depends on", () => {
  for (const id of ["stockLotForm", "lotSupplier", "lotDescription", "lotAcquisition", "lotShipping", "lotPayment", "lotDate", "lotGradeRows", "lotSubmit", "stockLotList"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

check("consignment form exposes the agreed controls (partner, agreement, locked funding, media)", () => {
  for (const id of ["bcConsignForm", "bcSupplier", "bcSavePartner", "bcAgreement", "bcItemPrice", "bcItemReference", "bcMedia", "bcMediaChecklist", "bcAddGarment", "bcSubmitLot"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes("🔒 no cash leaves the till"), "funding lock message missing");
});

check("cash share, reconciliation and payout queue are present", () => {
  for (const id of ["bcKpis", "bcCashShare", "bcRecon", "bcPayouts", "bcPayoutForm", "bcPayPartner", "bcPayAmount"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

check("stylesheet and module are wired into the admin console", () => {
  assert.ok(html.includes('href="css/bale-costs.css'));
  assert.ok(html.includes('src="js/bale-costs.js'));
});

// ---- Behaviour (jsdom) --------------------------------------------------------
function buildWindow(overview, lots, suppliers) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/admin.html?view=finance", pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.eval("window.toastCalls = [];");
  window.adonaiToast = (message, ok) => { calls.push({ message, ok }); };
  window.DB = {
    financeRequest(path, options) {
      calls.push({ path, options });
      if (path === "stock-lots") return Promise.resolve({ stock_lots: lots });
      if (path === "consignment/overview") return overview.error ? Promise.reject(overview.error) : Promise.resolve(overview.data);
      if (path === "consignment/suppliers") return Promise.resolve({ suppliers });
      return Promise.reject(new Error("unexpected " + path));
    },
  };
  window.__mediaMountOptions = null;
  window.GarmentMedia = { mount: (root, opts) => { window.__mediaMountOptions = opts || null; return { snapshot: () => ({ images: [], video_id: "" }), reset() {}, pause() {} }; } };
  window.eval(bundle);
  return { window, calls };
}

const baseOverview = {
  // Fulfilled shares 123,500; 40,000 approved but unpaid → payable now 83,500.
  kpis: { partner_payable_now: 83500, partner_in_fulfilment: 0, partner_cancelled_to_reverse: 0, commission_earned: 6500, paid_out: 0, payouts_open: 40000, stock_on_floor: 2, stock_on_floor_reference_value: 90000 },
  suppliers: [
    { id: "SUP-1", partner_name: "Derek Corrections", payout_channel: "MOBILE_MONEY", payout_account: "•••••••456", kyc_status: "VERIFIED", eligible: 123500, in_fulfilment: 0, paid: 0, open: 40000, payable_now: 83500, cancelled: 0 },
    { id: "SUP-2", partner_name: "New Partner", payout_channel: "CASH", payout_account: "", kyc_status: "PENDING_KYC", eligible: 0, in_fulfilment: 0, paid: 0, open: 0, payable_now: 0, cancelled: 0 },
  ],
  lots: [],
  payouts: [{ id: "PAY-1", supplier_id: "SUP-1", amount: 40000, channel: "MOBILE_MONEY", account: "•••••••456", status: "APPROVED", requested_by_name: "Manager One", approved_by_name: "Manager Two", payment_reference: "", created_at: new Date().toISOString() }],
  reconciliation: {
    partner_payable: { expected_payable: 123500, journal_payable: 123500, difference: 0, balanced: true },
    commission: { expected: 6500, journal: 6500, difference: 0, balanced: true },
  },
  policy: { commission_rate: 0.05, dual_approval_threshold: 300000, photo_min: 5, photo_max: 6, video_max_seconds: 15 },
};

const lots = [
  { id: "LOT-OWN", lot_code: "BALE-1", lot_type: "OWNED_BALE", supplier: "Market Source", description: "Denim bale", status: "OPEN", item_count: 10, allocated_count: 4, total_landed_cost: 300000, acquired_at: new Date().toISOString(), grades: [] },
  { id: "LOT-CON", lot_code: "CON-1", lot_type: "PARTNER_CONSIGNMENT", supplier: "Derek Corrections", description: "Outerwear", status: "ALLOCATED", item_count: 2, allocated_count: 2, total_landed_cost: 0, acquired_at: new Date().toISOString(), agreement_ref: "AGR-1", grades: [] },
];
const overviewLots = [{ id: "LOT-CON", items: 2, sold: 1, on_floor: 1, sell_through_pct: 50, commission: 4000, partner_share: 76000 }];

async function tick(window) { for (let i = 0; i < 5; i += 1) await new Promise(r => window.setTimeout(r, 0)); }

(async () => {
  console.log("\nBehaviour");

  // Preview maths (mirrors consignment.py; the server recalculates on save)
  const { window: w0 } = buildWindow({ data: baseOverview }, lots, baseOverview.suppliers);
  check("preview split: 80,000 → 4,000 commission / 76,000 partner", () => {
    const split = w0.BaleCosts._test.previewSplit(80000);
    assert.strictEqual(split.commission, 4000);
    assert.strictEqual(split.partner, 76000);
  });
  check("preview split reconciles odd amounts (12,350 → 618 / 11,732)", () => {
    const s = w0.BaleCosts._test.previewSplit(12350);
    assert.strictEqual(s.commission, 618);
    assert.strictEqual(s.commission + s.partner, 12350);
  });
  check("escaping neutralises markup from partner-supplied names", () => {
    assert.strictEqual(w0.BaleCosts._test.esc("<img src=x onerror=1>"), "&lt;img src=x onerror=1&gt;");
  });

  // Rendering with a manager session
  const { window, calls } = buildWindow({ data: baseOverview }, lots, baseOverview.suppliers);
  await window.BaleCosts.refresh();
  await tick(window);

  check("KPI strip shows the owed balance and a balanced ledger", () => {
    const text = window.document.querySelector("#bcKpis").textContent;
    assert.ok(text.includes("Owed to partners now"));
    assert.ok(text.includes("UGX 83,500"), text);
    assert.ok(text.includes("Balanced"));
  });

  check("lots register shows both owned and consignment lots with the right type badges", () => {
    const text = window.document.querySelector("#stockLotList").textContent;
    assert.ok(text.includes("BALE-1") && text.includes("CON-1"));
    assert.ok(text.includes("Owned bale") && text.includes("Consignment"));
    assert.ok(text.includes("UGX 0 · no upfront cost"));
  });

  check("lot filter narrows the register to consignment only", () => {
    const select = window.document.querySelector("#bcLotFilter");
    select.value = "PARTNER_CONSIGNMENT";
    select.dispatchEvent(new window.Event("change"));
    const text = window.document.querySelector("#stockLotList").textContent;
    assert.ok(text.includes("CON-1") && !text.includes("BALE-1"));
  });

  check("cash share: verified partner can request payout, pending partner cannot", () => {
    const rows = Array.from(window.document.querySelectorAll("#bcCashShare tbody tr"));
    assert.strictEqual(rows.length, 2);
    const verifiedBtn = rows[0].querySelector("[data-bc-request]");
    const pendingBtn = rows[1].querySelector("[data-bc-request]");
    assert.strictEqual(verifiedBtn.disabled, false);
    assert.strictEqual(pendingBtn.disabled, true);
    assert.ok(rows[1].textContent.includes("Pending KYC"));
  });

  check("payout queue: approved payout asks for a payment reference before recording", () => {
    const row = window.document.querySelector("#bcPayouts tbody tr");
    assert.ok(row.querySelector("[data-bc-pay-form]"), "pay form missing");
    assert.ok(row.querySelector('input[name="reference"]').hasAttribute("required"));
  });

  check("payout partner selector only lists KYC-verified partners", () => {
    const options = Array.from(window.document.querySelectorAll("#bcPayPartner option")).map(o => o.textContent);
    assert.ok(options.includes("Derek Corrections"));
    assert.ok(!options.includes("New Partner"));
  });

  check("consignment submit stays disabled until a verified partner, agreement and garment exist", () => {
    window.BaleCosts.setMode("consignment");
    assert.strictEqual(window.document.querySelector("#bcSubmitLot").disabled, true);
  });

  check("media gate: add-garment is disabled with no photos or video", () => {
    assert.strictEqual(window.document.querySelector("#bcAddGarment").disabled, true);
    assert.ok(window.document.querySelector("#bcMediaChecklist").textContent.includes("Photos 0 of 5"));
  });

  check("mode toggle switches the visible intake form and preserves the owned form", () => {
    window.BaleCosts.setMode("owned");
    assert.strictEqual(window.document.querySelector("#bcOwnedIntake").hidden, false);
    assert.strictEqual(window.document.querySelector("#bcConsignIntake").hidden, true);
    assert.ok(window.document.querySelector("#stockLotForm"), "owned form detached");
  });

  // Restricted (cashier) view
  const restricted = buildWindow({ error: Object.assign(new Error("Manager or administrator authorization is required"), { status: 403 }) }, lots, []);
  await restricted.window.BaleCosts.refresh();
  await tick(restricted.window);
  check("cashier sees lots but cash share and payouts are restricted", () => {
    assert.ok(restricted.window.document.querySelector("#bcKpis").textContent.includes("finance managers only"));
    assert.ok(restricted.window.document.querySelector("#bcCashShare").textContent.includes("finance managers only"));
    assert.ok(restricted.window.document.querySelector("#stockLotList").textContent.includes("CON-1"));
  });

  // Reconciliation failure is surfaced, not hidden
  const broken = JSON.parse(JSON.stringify(baseOverview));
  broken.reconciliation.partner_payable = { expected_payable: 83500, journal_payable: 80000, difference: -3500, balanced: false };
  const bad = buildWindow({ data: broken }, lots, broken.suppliers);
  await bad.window.BaleCosts.refresh();
  await tick(bad.window);
  check("a ledger mismatch is shown as an attention state with the difference", () => {
    assert.ok(bad.window.document.querySelector("#bcKpis").textContent.includes("Attention"));
    assert.ok(bad.window.document.querySelector("#bcRecon").textContent.includes("difference"));
  });

  check("the consignment media uploader is limited to the 15-second policy", () => {
    assert.equal(window.__mediaMountOptions && window.__mediaMountOptions.maxVideoSeconds, 15);
  });

  console.log(`\n${passed} bale-costs checks ${process.exitCode ? "FAILED" : "passed"}.`);
})();
