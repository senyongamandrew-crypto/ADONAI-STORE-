/*
 * Bale Costs panel — owned bale intake, partner consignment intake, registered
 * lots, cash share and the payout queue (Financial Ledgers, manager console).
 *
 * The server is authoritative for every amount, rule and approval. This file
 * only renders state, guides the operator, and previews figures that the
 * server will recalculate on save.
 */
(function (global) {
  "use strict";

  // Mirrors consignment.py. Preview hints only; the server enforces these.
  const POLICY = { commissionRate: 0.05, dualApprovalThreshold: 300000, photoMin: 5, photoMax: 6, videoMaxSeconds: 15 };

  const state = {
    mode: "owned",
    overview: null,
    overviewError: "",
    suppliers: [],
    ownedLots: [],
    consignLots: [],
    queue: [],
    mediaMounted: false,
    media: null,
    mediaSnapshot: null,
    busy: new Set(),
    lotFilter: "ALL",
    payoutKey: "",
    refreshing: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  function ugx(value) {
    return "UGX " + Math.round(Number(value) || 0).toLocaleString("en-UG");
  }

  function dateLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    return isNaN(date) ? "—" : date.toLocaleDateString("en-UG", { day: "2-digit", month: "short", year: "numeric" });
  }

  function ageDays(value) {
    const date = value ? new Date(value) : null;
    if (!date || isNaN(date)) return 0;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  }

  function previewSplit(amount) {
    // Preview only: commission rounded half-up to whole shillings, partner gets the remainder.
    const total = Math.max(0, Math.round(Number(amount) || 0));
    const commission = Math.floor(total * POLICY.commissionRate + 0.5);
    return { commission, partner: total - commission };
  }

  function api(path, options) {
    const opts = Object.assign({ method: "GET" }, options || {});
    if (opts.body !== undefined && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return DB.financeRequest(path, opts);
  }

  function notify(message, ok = true) {
    if (typeof global.adonaiToast === "function") global.adonaiToast(message, ok);
  }

  function setBusy(key, value) {
    if (value) state.busy.add(key); else state.busy.delete(key);
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const lotsPromise = api("stock-lots", { method: "GET" }).catch(error => ({ error }));
      const overviewPromise = api("consignment/overview", { method: "GET" }).then(data => ({ data })).catch(error => ({ error }));
      const suppliersPromise = api("consignment/suppliers", { method: "GET" }).catch(() => ({ suppliers: [] }));
      const [lotsResult, overviewResult, suppliersResult] = await Promise.all([lotsPromise, overviewPromise, suppliersPromise]);

      if (lotsResult && lotsResult.error) throw lotsResult.error;
      const allLots = (lotsResult && lotsResult.stock_lots) || [];
      state.ownedLots = allLots.filter(lot => (lot.lot_type || "OWNED_BALE") !== "PARTNER_CONSIGNMENT");
      state.consignLots = allLots.filter(lot => lot.lot_type === "PARTNER_CONSIGNMENT");
      state.suppliers = (suppliersResult && suppliersResult.suppliers) || [];

      if (overviewResult.error) {
        state.overview = null;
        state.overviewError = overviewResult.error.status === 403
          ? "Cash share and payouts are visible to finance managers only."
          : (overviewResult.error.message || "Cash share could not be loaded.");
      } else {
        state.overview = overviewResult.data;
        state.overviewError = "";
      }
      renderAll();
    } catch (error) {
      const host = $("#stockLotList");
      if (host) host.innerHTML = `<div class="finance-empty">${esc(error.message || "Stock lots could not be loaded.")}</div>`;
    } finally {
      state.refreshing = false;
    }
  }

  // ------------------------------------------------------------------
  // Mode toggle
  // ------------------------------------------------------------------
  function setMode(mode) {
    state.mode = mode === "consignment" ? "consignment" : "owned";
    const owned = state.mode === "owned";
    $("#bcOwnedIntake").hidden = !owned;
    $("#bcConsignIntake").hidden = owned;
    $("#bcModeOwned").classList.toggle("active", owned);
    $("#bcModeConsign").classList.toggle("active", !owned);
    $("#bcModeOwned").setAttribute("aria-selected", String(owned));
    $("#bcModeConsign").setAttribute("aria-selected", String(!owned));
    if (!owned) mountMedia();
  }

  // ------------------------------------------------------------------
  // KPIs and policy
  // ------------------------------------------------------------------
  function renderKpis() {
    const host = $("#bcKpis");
    const o = state.overview;
    if (!o) {
      host.innerHTML = `<div class="bc-kpi bc-kpi-note"><span>Cash share</span><strong>Restricted</strong><small>${esc(state.overviewError)}</small></div>`;
      return;
    }
    const k = o.kpis;
    const recon = o.reconciliation;
    const balanced = recon.partner_payable.balanced && recon.commission.balanced;
    const cards = [
      ["Owed to partners now", ugx(k.partner_payable_now), "Fulfilled sales, less payouts made or pending", "bc-kpi-owed"],
      ["Commission earned", ugx(k.commission_earned), `${Math.round(o.policy.commission_rate * 100)}% of consignment sale lines`, "bc-kpi-good"],
      ["Paid out to partners", ugx(k.paid_out), `${ugx(k.payouts_open)} awaiting approval or payment`, ""],
      ["Consignment on floor", `${k.stock_on_floor} pcs`, `${ugx(k.stock_on_floor_reference_value)} at partner value · not Adonai stock`, ""],
      ["Awaiting fulfilment", ugx(k.partner_in_fulfilment), "Not payable until the order is completed", ""],
      ["Ledger check", balanced ? "Balanced" : "Attention", balanced ? "Payable and commission match the journal" : "Journal and sales records differ — see below", balanced ? "bc-kpi-good" : "bc-kpi-bad"],
    ];
    host.innerHTML = cards.map(([label, value, note, cls]) => (
      `<div class="bc-kpi ${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`
    )).join("");
    $("#bcPolicy").textContent = `Policy: ${Math.round(o.policy.commission_rate * 100)}% commission on sale line · dual approval at ${ugx(o.policy.dual_approval_threshold)} or more · consignment media ${o.policy.photo_min}–${o.policy.photo_max} photos and a video of ${o.policy.video_max_seconds} seconds or less.`;
  }

  // ------------------------------------------------------------------
  // Lots register
  // ------------------------------------------------------------------
  function renderLots() {
    const host = $("#stockLotList");
    if (!host) return;
    const consignById = new Map((state.overview && state.overview.lots || []).map(row => [row.id, row]));
    let rows = [];
    if (state.lotFilter !== "PARTNER_CONSIGNMENT") rows = rows.concat(state.ownedLots.map(lot => ({ lot, type: "OWNED_BALE" })));
    if (state.lotFilter !== "OWNED_BALE") rows = rows.concat(state.consignLots.map(lot => ({ lot, type: "PARTNER_CONSIGNMENT", detail: consignById.get(lot.id) })));
    rows.sort((a, b) => new Date(b.lot.acquired_at || 0) - new Date(a.lot.acquired_at || 0));
    if (!rows.length) {
      host.innerHTML = `<div class="finance-empty">No lots yet for this filter. Register an owned bale or a partner consignment intake.</div>`;
      return;
    }
    host.innerHTML = `<div class="bc-lot-table-wrap"><table class="bc-table bc-lot-table">
      <thead><tr><th>Lot</th><th>Type</th><th>Partner / source</th><th>Status</th><th class="num">Pieces</th><th class="num">Sold</th><th>Sell-through</th><th class="num">Cost basis</th><th class="num">Commission</th><th class="num">Partner share</th><th class="num">Age</th></tr></thead>
      <tbody>${rows.map(row => lotRow(row)).join("")}</tbody></table></div>`;
  }

  function lotRow({ lot, type, detail }) {
    const consign = type === "PARTNER_CONSIGNMENT";
    const pieces = consign ? (detail ? detail.items : lot.item_count) : lot.item_count;
    const sold = consign ? (detail ? detail.sold : 0) : null;
    const pct = consign ? (detail ? detail.sell_through_pct : 0) : (lot.item_count ? Math.round(100 * (lot.allocated_count || 0) / lot.item_count) : 0);
    const tiers = (lot.grades || []).length;
    const costBasis = consign ? "UGX 0 · no upfront cost" : ugx(lot.total_landed_cost);
    const status = consign ? (detail && detail.sold === detail.items && detail.items ? "SOLD OUT" : lot.status) : lot.status;
    const retBy = consign && lot.return_by_date ? `<small class="muted">Return by ${esc(dateLabel(lot.return_by_date))}</small>` : "";
    const typeBadge = consign
      ? `<span class="bc-badge bc-badge-consign">🤝 Consignment</span>`
      : `<span class="bc-badge bc-badge-owned">📦 Owned bale</span>`;
    return `<tr>
      <td><strong>${esc(lot.lot_code)}</strong><br><small class="muted">${esc(lot.description || "")}</small>${consign && lot.agreement_ref ? `<br><small class="muted">Agreement ${esc(lot.agreement_ref)}</small>` : ""}${retBy}</td>
      <td>${typeBadge}</td>
      <td>${esc(lot.supplier)}${tiers && !consign ? `<br><span class="lot-grade-pill">${tiers} tiers</span>` : ""}</td>
      <td><span class="fin-status">${esc(status)}</span></td>
      <td class="num">${Number(pieces || 0)}</td>
      <td class="num">${consign ? Number(sold || 0) : "—"}</td>
      <td><div class="bc-bar" role="img" aria-label="${pct}% sold"><span style="width:${Math.min(100, Math.max(0, pct))}%"></span></div><small>${pct}%</small></td>
      <td class="num">${esc(costBasis)}</td>
      <td class="num">${consign ? ugx(detail ? detail.commission : 0) : "—"}</td>
      <td class="num">${consign ? ugx(detail ? detail.partner_share : 0) : "—"}</td>
      <td class="num">${ageDays(lot.acquired_at)} d</td>
    </tr>`;
  }

  // ------------------------------------------------------------------
  // Cash share and reconciliation
  // ------------------------------------------------------------------
  function renderCashShare() {
    const host = $("#bcCashShare");
    const recon = $("#bcRecon");
    if (!state.overview) {
      host.innerHTML = `<div class="finance-empty">${esc(state.overviewError || "Loading…")}</div>`;
      recon.innerHTML = "";
      return;
    }
    const rows = state.overview.suppliers;
    if (!rows.length) {
      host.innerHTML = `<div class="finance-empty">No consignment partners yet. Add a partner in Partner Consignment Intake.</div>`;
    } else {
      host.innerHTML = `<div class="bc-lot-table-wrap"><table class="bc-table">
        <thead><tr><th>Partner</th><th>KYC</th><th class="num">Fulfilled share</th><th class="num">In fulfilment</th><th class="num">Paid out</th><th class="num">Awaiting payout</th><th class="num">Payable now</th><th></th></tr></thead>
        <tbody>${rows.map(row => `<tr>
          <td><strong>${esc(row.partner_name)}</strong><br><small class="muted">${esc(row.payout_channel.replace(/_/g, " "))} · ${esc(row.payout_account || "cash")}</small></td>
          <td><span class="bc-badge ${row.kyc_status === "VERIFIED" ? "bc-badge-good" : "bc-badge-warn"}">${row.kyc_status === "VERIFIED" ? "Verified" : "Pending KYC"}</span></td>
          <td class="num">${ugx(row.eligible)}</td>
          <td class="num">${ugx(row.in_fulfilment)}</td>
          <td class="num">${ugx(row.paid)}</td>
          <td class="num">${ugx(row.open)}</td>
          <td class="num"><strong>${ugx(row.payable_now)}</strong>${row.cancelled ? `<br><small class="bc-warn-text">${ugx(row.cancelled)} on cancelled orders to reverse</small>` : ""}</td>
          <td><button class="btn ghost sm" type="button" data-bc-request="${esc(row.id)}" ${row.kyc_status !== "VERIFIED" || row.payable_now <= 0 ? "disabled" : ""}>Request payout</button></td>
        </tr>`).join("")}</tbody></table></div>`;
    }
    const r = state.overview.reconciliation;
    recon.innerHTML = `
      <div class="bc-recon-item ${r.partner_payable.balanced ? "ok" : "bad"}"><strong>${r.partner_payable.balanced ? "✔" : "✖"} Partner payable</strong>
        <span>Ledger account 2100: ${ugx(r.partner_payable.journal_payable)} · expected from sales less payouts: ${ugx(r.partner_payable.expected_payable)}${r.partner_payable.balanced ? "" : ` · difference ${ugx(r.partner_payable.difference)}`}</span></div>
      <div class="bc-recon-item ${r.commission.balanced ? "ok" : "bad"}"><strong>${r.commission.balanced ? "✔" : "✖"} Commission</strong>
        <span>Ledger account 4200: ${ugx(r.commission.journal)} · from sale splits: ${ugx(r.commission.expected)}</span></div>`;
  }

  // ------------------------------------------------------------------
  // Payouts
  // ------------------------------------------------------------------
  function renderPayoutSelect() {
    const select = $("#bcPayPartner");
    if (!select) return;
    const current = select.value;
    const verified = (state.overview ? state.overview.suppliers : state.suppliers).filter(s => s.kyc_status === "VERIFIED");
    select.innerHTML = `<option value="">Choose…</option>` + verified.map(s => `<option value="${esc(s.id)}">${esc(s.partner_name)}</option>`).join("");
    if (verified.some(s => s.id === current)) select.value = current;
  }

  function renderPayouts() {
    const host = $("#bcPayouts");
    if (!state.overview) { host.innerHTML = `<div class="finance-empty">${esc(state.overviewError || "Loading…")}</div>`; return; }
    const payouts = state.overview.payouts;
    if (!payouts.length) { host.innerHTML = `<div class="finance-empty">No payouts requested yet.</div>`; return; }
    const names = new Map(state.overview.suppliers.map(s => [s.id, s.partner_name]));
    host.innerHTML = `<div class="bc-lot-table-wrap"><table class="bc-table">
      <thead><tr><th>Requested</th><th>Partner</th><th class="num">Amount</th><th>Channel · account</th><th>Status</th><th>People</th><th>Action</th></tr></thead>
      <tbody>${payouts.map(p => payoutRow(p, names.get(p.supplier_id) || "Partner")).join("")}</tbody></table></div>`;
  }

  function payoutRow(p, partnerName) {
    const pill = { REQUESTED: "bc-badge-warn", APPROVED: "bc-badge-info", PAID: "bc-badge-good", REJECTED: "bc-badge-bad" }[p.status] || "";
    let action = "";
    if (p.status === "REQUESTED") {
      action = `<button class="btn sm" type="button" data-bc-approve="${esc(p.id)}">Approve</button> <button class="btn ghost sm" type="button" data-bc-reject="${esc(p.id)}">Reject</button>`;
    } else if (p.status === "APPROVED") {
      action = `<form class="bc-pay-inline" data-bc-pay-form="${esc(p.id)}"><input class="sel-full" name="reference" maxlength="120" placeholder="MoMo / bank ref or receipt no." aria-label="Payment reference" required /><button class="btn primary sm" type="submit">Record payment</button></form>`;
    } else if (p.status === "PAID") {
      action = `<span class="muted small">Ref ${esc(p.payment_reference)}</span>`;
    }
    return `<tr>
      <td>${esc(dateLabel(p.created_at))}</td>
      <td>${esc(partnerName)}</td>
      <td class="num">${ugx(p.amount)}</td>
      <td>${esc(p.channel.replace(/_/g, " "))}<br><small class="muted">${esc(p.account || "cash")}</small></td>
      <td><span class="bc-badge ${pill}">${esc(p.status)}</span></td>
      <td><small>Requested by ${esc(p.requested_by_name || "—")}${p.approved_by_name ? `<br>Approved by ${esc(p.approved_by_name)}` : ""}${p.paid_by_name ? `<br>Paid by ${esc(p.paid_by_name)}` : ""}</small></td>
      <td>${action}</td>
    </tr>`;
  }

  // ------------------------------------------------------------------
  // Consignment intake
  // ------------------------------------------------------------------
  function renderPartnerSelect() {
    const select = $("#bcSupplier");
    const current = select.value;
    select.innerHTML = `<option value="">Choose a partner…</option>` + state.suppliers.map(s => (
      `<option value="${esc(s.id)}">${esc(s.partner_name)}${s.kyc_status === "VERIFIED" ? "" : " — pending KYC"}</option>`
    )).join("");
    if (state.suppliers.some(s => s.id === current)) select.value = current;
    renderPartnerStatus();
  }

  function selectedPartner() {
    const id = $("#bcSupplier").value;
    return state.suppliers.find(s => s.id === id) || null;
  }

  function renderPartnerStatus() {
    const host = $("#bcPartnerStatus");
    const partner = selectedPartner();
    if (!partner) { host.innerHTML = `<span class="muted small">Select the partner who owns this stock.</span>`; return; }
    if (partner.kyc_status === "VERIFIED") {
      host.innerHTML = `<span class="bc-badge bc-badge-good">KYC verified</span> <span class="muted small">Payouts go to ${esc(partner.payout_channel.replace(/_/g, " "))} ${esc(partner.payout_account || "")}</span>`;
    } else {
      host.innerHTML = `<span class="bc-badge bc-badge-warn">Pending KYC</span> <span class="muted small">A different manager must verify this file before intake.</span> <button class="btn ghost sm" type="button" id="bcVerifyPartner" data-partner="${esc(partner.id)}">Verify KYC</button>`;
    }
    updateSubmitState();
  }

  async function savePartner() {
    if (state.busy.has("savePartner")) return;
    const payload = {
      partner_name: $("#bcpName").value.trim(),
      business_name: $("#bcpBusiness").value.trim(),
      phone_whatsapp: $("#bcpPhone").value.trim(),
      identity_reference: $("#bcpIdentity").value.trim(),
      payout_channel: $("#bcpChannel").value,
      payout_account: $("#bcpAccount").value.trim(),
    };
    setBusy("savePartner", true);
    try {
      const data = await api("consignment/suppliers", { method: "POST", body: payload });
      notify("Partner saved — pending KYC verification");
      $("#bcNewPartner").hidden = true;
      ["#bcpName", "#bcpBusiness", "#bcpPhone", "#bcpIdentity", "#bcpAccount"].forEach(sel => { $(sel).value = ""; });
      await refresh();
      $("#bcSupplier").value = data.supplier.id;
      renderPartnerStatus();
    } catch (error) {
      showFormError("#bcFormError", error.message);
    } finally {
      setBusy("savePartner", false);
    }
  }

  async function verifyPartner(id) {
    setBusy("verify:" + id, true);
    try {
      await api(`consignment/suppliers/${encodeURIComponent(id)}/verify`, { method: "POST", body: {} });
      notify("KYC verified");
      await refresh();
      $("#bcSupplier").value = id;
      renderPartnerStatus();
    } catch (error) {
      notify(error.message || "Verification failed", false);
    } finally {
      setBusy("verify:" + id, false);
    }
  }

  function mountMedia() {
    if (state.mediaMounted || !global.GarmentMedia) return;
    state.mediaMounted = true;
    state.media = global.GarmentMedia.mount($("#bcMedia"), {
      onChange: () => { state.mediaSnapshot = null; renderMediaChecklist(); },
      onBusy: () => updateAddButton(),
      onError: message => notify(message, false),
    });
    renderMediaChecklist();
  }

  function currentMedia() {
    if (!state.media) return { photos: 0, video: false, busy: false, error: "" };
    // Read the uploader's busy flag directly; snapshot() throws for both busy and failed uploads.
    if (state.media.busy) {
      return { photos: 0, video: false, busy: true, error: "Please wait for your photos and video to finish uploading." };
    }
    try {
      const snap = state.media.snapshot();
      return { photos: (snap.images || []).length, video: !!snap.video_id, snap, busy: false, error: "" };
    } catch (error) {
      return { photos: 0, video: false, busy: false, error: error.message };
    }
  }

  function renderMediaChecklist() {
    const host = $("#bcMediaChecklist");
    const m = currentMedia();
    const photoOk = m.photos >= POLICY.photoMin && m.photos <= POLICY.photoMax;
    const chip = (ok, text) => `<span class="bc-check ${ok ? "ok" : "todo"}">${ok ? "✔" : "•"} ${esc(text)}</span>`;
    host.innerHTML = [
      chip(photoOk, `Photos ${m.photos} of ${POLICY.photoMin}–${POLICY.photoMax}`),
      chip(m.video, m.video ? `Video attached · checked to ${POLICY.videoMaxSeconds}s on save` : `Garment video required (${POLICY.videoMaxSeconds}s or less)`),
    ].join("");
    updateAddButton();
  }

  function updateAddButton() {
    const m = currentMedia();
    const ready = m.photos >= POLICY.photoMin && m.photos <= POLICY.photoMax && m.video && !m.busy;
    $("#bcAddGarment").disabled = !ready;
    $("#bcAddHint").textContent = ready ? "Media standard met. Check the price, then add." :
      (m.photos > POLICY.photoMax ? `Use at most ${POLICY.photoMax} photos for consignment items.` :
        "Add 5–6 photos and one garment video (15 seconds or less) to continue.");
  }

  function addGarment() {
    const name = $("#bcItemName").value.trim();
    const price = Math.round(Number($("#bcItemPrice").value));
    const reference = Math.round(Number($("#bcItemReference").value || 0));
    if (!name) return showFormError("#bcFormError", "Describe the garment.");
    if (!(price > 0)) return showFormError("#bcFormError", "Enter the selling price (UGX), greater than zero.");
    if (!(reference >= 0)) return showFormError("#bcFormError", "Partner reference value cannot be negative.");
    const m = currentMedia();
    if (!m.snap) return showFormError("#bcFormError", m.error || "Wait for the photos and video to finish uploading.");
    state.queue.push({
      name,
      size: $("#bcItemSize").value.trim() || "-",
      selling_price: price,
      reference_value: reference,
      images: m.snap.images || [],
      image_url: (m.snap.images || [])[0] || "",
      video_id: m.snap.video_id || "",
      photos: (m.snap.images || []).length,
    });
    clearFormError("#bcFormError");
    ["#bcItemName", "#bcItemSize", "#bcItemPrice", "#bcItemReference"].forEach(sel => { $(sel).value = ""; });
    state.media.reset(null);
    renderMediaChecklist();
    renderQueue();
  }

  function removeGarment(index) {
    state.queue.splice(index, 1);
    renderQueue();
  }

  function renderQueue() {
    const host = $("#bcQueue");
    if (!state.queue.length) {
      host.innerHTML = `<div class="finance-empty">No garments added yet.</div>`;
    } else {
      const totals = state.queue.reduce((t, g) => {
        const split = previewSplit(g.selling_price);
        t.sale += g.selling_price; t.reference += g.reference_value; t.commission += split.commission; t.partner += split.partner;
        return t;
      }, { sale: 0, reference: 0, commission: 0, partner: 0 });
      host.innerHTML = `<div class="bc-lot-table-wrap"><table class="bc-table">
        <thead><tr><th>#</th><th>Garment</th><th>Size</th><th class="num">Sale price</th><th class="num">Partner reference</th><th class="num">Photos</th><th>Video</th><th></th></tr></thead>
        <tbody>${state.queue.map((g, i) => `<tr><td>${i + 1}</td><td>${esc(g.name)}</td><td>${esc(g.size)}</td><td class="num">${ugx(g.selling_price)}</td><td class="num">${ugx(g.reference_value)}</td><td class="num">${g.photos}</td><td>${g.video_id ? "✔" : "—"}</td><td><button class="btn ghost sm" type="button" data-bc-remove="${i}">Remove</button></td></tr>`).join("")}</tbody>
        <tfoot><tr><th colspan="3">Preview total (server recalculates on save)</th><th class="num">${ugx(totals.sale)}</th><th class="num">${ugx(totals.reference)}</th><th colspan="3"><small>Adonai ${ugx(totals.commission)} · partner ${ugx(totals.partner)}</small></th></tr></tfoot>
      </table></div>`;
    }
    updateSubmitState();
  }

  function updateSubmitState() {
    const partner = selectedPartner();
    const ready = !!partner && partner.kyc_status === "VERIFIED" && state.queue.length > 0 && $("#bcAgreement").value.trim().length > 0;
    $("#bcSubmitLot").disabled = !ready || state.busy.has("submitLot");
  }

  async function submitLot(event) {
    event.preventDefault();
    if (state.busy.has("submitLot")) return;
    clearFormError("#bcFormError");
    const payload = {
      supplier_id: $("#bcSupplier").value,
      agreement_ref: $("#bcAgreement").value.trim(),
      description: $("#bcLotDescription").value.trim() || "Consignment intake",
      return_by_date: $("#bcReturnBy").value ? new Date($("#bcReturnBy").value + "T23:59:59+03:00").toISOString() : null,
      lot_code: $("#bcLotCode").value.trim() || undefined,
      items: state.queue.map(g => ({ name: g.name, size: g.size, selling_price: g.selling_price, reference_value: g.reference_value, images: g.images, image_url: g.image_url, video_id: g.video_id })),
    };
    setBusy("submitLot", true);
    updateSubmitState();
    try {
      const data = await api("consignment/lots", { method: "POST", body: payload });
      notify(`Consignment lot ${data.lot.lot_code} registered · ${data.product_ids.length} piece(s) on the POS catalogue`);
      state.queue = [];
      ["#bcAgreement", "#bcLotDescription", "#bcReturnBy", "#bcLotCode"].forEach(sel => { $(sel).value = ""; });
      renderQueue();
      await refresh();
    } catch (error) {
      showFormError("#bcFormError", error.message);
    } finally {
      setBusy("submitLot", false);
      updateSubmitState();
    }
  }

  // ------------------------------------------------------------------
  // Payout actions
  // ------------------------------------------------------------------
  function newPayoutKey(partnerId) {
    return `pay-${partnerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function submitPayoutRequest(event) {
    event.preventDefault();
    clearFormError("#bcPayError");
    const supplierId = $("#bcPayPartner").value;
    const amount = Math.round(Number($("#bcPayAmount").value));
    if (!supplierId) return showFormError("#bcPayError", "Choose a partner.");
    if (!(amount > 0)) return showFormError("#bcPayError", "Enter a payout amount greater than zero.");
    if (state.busy.has("payRequest")) return;
    // One key per intended payout: a double-click reuses it and the server returns the same payout.
    if (!state.payoutKey || state.payoutKey.partner !== supplierId || state.payoutKey.amount !== amount) {
      state.payoutKey = { partner: supplierId, amount, key: newPayoutKey(supplierId) };
    }
    setBusy("payRequest", true);
    try {
      const data = await api("consignment/payouts", { method: "POST", body: { supplier_id: supplierId, amount, note: $("#bcPayNote").value.trim(), idempotency_key: state.payoutKey.key } });
      notify(data.status === "existing" ? "This payout request already exists" : "Payout requested — awaiting approval");
      state.payoutKey = null;
      $("#bcPayAmount").value = "";
      $("#bcPayNote").value = "";
      await refresh();
    } catch (error) {
      showFormError("#bcPayError", error.message);
    } finally {
      setBusy("payRequest", false);
    }
  }

  async function payoutAction(id, action, body) {
    const key = `${action}:${id}`;
    if (state.busy.has(key)) return;
    setBusy(key, true);
    try {
      await api(`consignment/payouts/${encodeURIComponent(id)}/${action}`, { method: "POST", body: body || {} });
      notify({ approve: "Payout approved", reject: "Payout rejected", pay: "Payment recorded and ledgered" }[action]);
      await refresh();
    } catch (error) {
      notify(error.message || "Action failed", false);
    } finally {
      setBusy(key, false);
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function showFormError(selector, message) {
    const el = $(selector);
    el.textContent = message;
    el.hidden = false;
  }

  function clearFormError(selector) {
    const el = $(selector);
    el.textContent = "";
    el.hidden = true;
  }

  function renderAll() {
    renderKpis();
    renderLots();
    renderCashShare();
    renderPartnerSelect();
    renderPayoutSelect();
    renderPayouts();
    renderQueue();
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wire() {
    const root = $("#finance-lots");
    if (!root || root.dataset.bcWired) return;
    root.dataset.bcWired = "1";

    $$("[data-bc-mode]", root).forEach(button => button.addEventListener("click", () => setMode(button.dataset.bcMode)));
    $("#bcRefresh").addEventListener("click", () => refresh());
    $("#bcLotFilter").addEventListener("change", event => { state.lotFilter = event.target.value; renderLots(); });
    $("#bcToggleNewPartner").addEventListener("click", () => { $("#bcNewPartner").hidden = !$("#bcNewPartner").hidden; });
    $("#bcpChannel").addEventListener("change", () => {
      $("#bcpAccountField").hidden = $("#bcpChannel").value === "CASH";
    });
    $("#bcSavePartner").addEventListener("click", savePartner);
    $("#bcSupplier").addEventListener("change", renderPartnerStatus);
    $("#bcPartnerStatus").addEventListener("click", event => {
      const btn = event.target.closest("#bcVerifyPartner");
      if (btn) verifyPartner(btn.dataset.partner);
    });
    $("#bcAgreement").addEventListener("input", updateSubmitState);
    $("#bcAddGarment").addEventListener("click", addGarment);
    $("#bcQueue").addEventListener("click", event => {
      const btn = event.target.closest("[data-bc-remove]");
      if (btn) removeGarment(Number(btn.dataset.bcRemove));
    });
    $("#bcConsignForm").addEventListener("submit", submitLot);
    $("#bcPayoutForm").addEventListener("submit", submitPayoutRequest);
    $("#bcCashShare").addEventListener("click", event => {
      const btn = event.target.closest("[data-bc-request]");
      if (!btn) return;
      $("#bcPayPartner").value = btn.dataset.bcRequest;
      $("#bcPayAmount").focus();
    });
    $("#bcPayouts").addEventListener("click", event => {
      const approve = event.target.closest("[data-bc-approve]");
      const reject = event.target.closest("[data-bc-reject]");
      if (approve) payoutAction(approve.dataset.bcApprove, "approve");
      if (reject) payoutAction(reject.dataset.bcReject, "reject", { reason: "Rejected by manager" });
    });
    $("#bcPayouts").addEventListener("submit", event => {
      const form = event.target.closest("[data-bc-pay-form]");
      if (!form) return;
      event.preventDefault();
      const reference = form.elements.reference.value.trim();
      if (reference.length < 4) return notify("Enter the transaction reference (at least 4 characters)", false);
      payoutAction(form.dataset.bcPayForm, "pay", { payment_reference: reference });
    });
    setMode("owned");
  }

  global.BaleCosts = {
    refresh,
    setMode,
    // Pure helpers exposed for tests.
    _test: { previewSplit, POLICY, esc, ugx },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
