/* Daily receipt reprints. Rendering is read-only, scoped and self-contained.
   Browser print / Save as PDF or Android's isolated system print document. */
(function (global) {
  "use strict";
  const doc = global.document;
  const MAX_RECEIPTS = 250, MAX_HTML = 1024 * 1024;
  let printing = false, previousTitle = null;
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
  const amount = value => "UGX " + (Number(value) || 0).toLocaleString("en-UG");
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const allowed = () => !global.PosAccess || global.PosAccess.canUse("orders");
  const paymentName = sale => {
    const type = String(sale.payment_method || sale.tender_type || sale.tender?.type || sale.payment?.provider || "Recorded");
    return ({cash:"Cash", mtn:"MTN MoMo", airtel:"Airtel Money", flutterwave:"Online payment", mobile_money:"Mobile money", card:"Card"})[type.toLowerCase()] || type;
  };
  function header(settings) {
    return `<header class="rp-store"><h1>${esc(settings.store_name || "ADONAI STORE")}</h1>${settings.address ? `<p>${esc(settings.address)}</p>` : ""}${settings.hotline ? `<p>Phone: ${esc(settings.hotline)}</p>` : ""}</header>`;
  }
  function receipt(sale, settings = {}) {
    if (!sale || !sale.id || !global.AuditExports.posted(sale)) throw new Error("Choose a saved, posted sale to print its receipt.");
    const items = Array.isArray(sale.items) ? sale.items : [];
    const date = global.AuditExports.postingDate(sale);
    const cashier = sale.cashier_name || sale.cashier?.name || "";
    const subtotal = sale.subtotal == null ? number(sale.total) - number(sale.delivery_fee) : number(sale.subtotal);
    const registered = sale.channel === "pos";
    return `<article class="rp-invoice" data-receipt-ref="${esc(sale.id)}">
      ${header(settings)}
      <div class="rp-ref"><span>SALES RECEIPT / INVOICE</span><strong>${esc(sale.order_number || sale.id)}</strong></div>
      <p class="rp-date">Posted: ${esc(global.AuditExports.stamp(date))}</p>
      ${sale.created_at && global.AuditExports.dateOf(sale.created_at).getTime() !== global.AuditExports.dateOf(date).getTime() ? `<p class="rp-order-date">Order created: ${esc(global.AuditExports.stamp(sale.created_at))}</p>` : ""}
      <dl class="rp-customer"><div><dt>Customer</dt><dd>${esc(sale.customer_name || "Walk-in customer")}</dd></div>${sale.customer_phone ? `<div><dt>Phone</dt><dd>${esc(sale.customer_phone)}</dd></div>` : ""}${sale.customer_address ? `<div><dt>Address</dt><dd>${esc(sale.customer_address)}</dd></div>` : ""}${cashier ? `<div><dt>Cashier</dt><dd>${esc(cashier)}</dd></div>` : ""}<div><dt>Channel</dt><dd>${registered ? "In-store POS" : "Online store"}</dd></div></dl>
      <table class="rp-items"><thead><tr><th>Garment / Item</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>${items.map(item => `<tr><td><strong>${esc(item.name || "Item")}</strong>${item.sku || item.barcode_id ? `<small>${esc(item.sku || item.barcode_id)}</small>` : ""}</td><td>${number(item.qty)}</td><td>${amount(item.unit_price)}</td><td>${amount(item.line_total == null ? number(item.unit_price) * number(item.qty) : item.line_total)}</td></tr>`).join("")}</tbody></table>
      <div class="rp-totals"><p><span>Item subtotal</span><strong>${amount(subtotal)}</strong></p>${number(sale.delivery_fee) ? `<p><span>Delivery fee</span><strong>${amount(sale.delivery_fee)}</strong></p>` : ""}<p class="rp-grand"><span>Total</span><strong>${amount(sale.total)}</strong></p></div>
      <p class="rp-payment">${esc(paymentName(sale))} · ${registered ? "Completed POS checkout" : "Payment confirmed"}</p>
      <footer class="rp-footer">Saved receipt copy · ${esc(sale.id)}<br>Thank you for shopping with ${esc(settings.store_name || "Adonai Store")}.</footer>
    </article>`;
  }
  function summary(sales, selection, settings = {}) {
    const total = sales.reduce((sum, sale) => sum + number(sale.total), 0);
    const units = sales.reduce((sum, sale) => sum + (sale.items || []).reduce((count, item) => count + number(item.qty), 0), 0);
    const payments = new Map();
    sales.forEach(sale => { const key = paymentName(sale); payments.set(key, (payments.get(key) || 0) + number(sale.total)); });
    return `<article class="rp-summary">
      ${header(settings)}<h2>Daily posted sales summary</h2>
      <p class="rp-period">${esc(selection.label || "Selected dates")} · Kampala time (EAT)</p>
      <p class="rp-window">Full calendar days: 00:00 up to midnight. Includes all morning and evening receipts.</p>
      ${selection.search ? `<p>Search filter: ${esc(selection.search)}. This is a filtered summary, not the full day's total.</p>` : ""}
      <div class="rp-kpis"><p><strong>${sales.length}</strong> receipt${sales.length === 1 ? "" : "s"}</p><p><strong>${units}</strong> item${units === 1 ? "" : "s"}</p><p><strong>${amount(total)}</strong> posted value</p></div>
      <table class="rp-summary-table"><thead><tr><th>Receipt / Invoice</th><th>Posted date (EAT)</th><th>Customer</th><th>Payment</th><th>Total (UGX)</th></tr></thead><tbody>${sales.map(sale => `<tr><td>${esc(sale.order_number || sale.id)}</td><td>${esc(global.AuditExports.stamp(global.AuditExports.postingDate(sale)))}</td><td>${esc(sale.customer_name || "Walk-in customer")}</td><td>${esc(paymentName(sale))}</td><td>${number(sale.total).toLocaleString("en-UG")}</td></tr>`).join("")}</tbody><tfoot><tr><th colspan="4">Total posted sales</th><th>${total.toLocaleString("en-UG")}</th></tr></tfoot></table>
      <h3>Recorded payment methods</h3><div class="rp-payment-totals">${Array.from(payments, ([name, value]) => `<p><span>${esc(name)}</span><strong>${amount(value)}</strong></p>`).join("")}</div>
      <footer class="rp-footer">${selection.lastSynced ? `Records last refreshed: ${esc(global.AuditExports.stamp(selection.lastSynced))}.<br>` : ""}${selection.offline ? "Saved copy: connection unavailable; the day's list may be incomplete.<br>" : ""}Printed copies do not close, delete, or change the books. Previous days remain in saved history and date-filtered exports.</footer>
    </article>`;
  }
  const BASE_CSS = `
    .rp-invoice,.rp-summary{font-family:Arial,sans-serif;color:#000;background:#fff;box-sizing:border-box;font-size:10pt;line-height:1.5;overflow-wrap:anywhere;text-align:left}
    .rp-store{text-align:center;border-bottom:1px solid #111;padding-bottom:4mm;margin-bottom:5mm}.rp-store h1{font-size:21pt;letter-spacing:.03em;margin:0 0 2mm;font-family:Arial,sans-serif}.rp-store p{margin:0;font-size:9pt}
    .rp-ref{display:flex;justify-content:space-between;flex-wrap:wrap;gap:2mm}.rp-ref span{font-size:8pt}.rp-ref strong{font-size:13pt}
    .rp-date{font-weight:700;margin:2mm 0}.rp-order-date{font-size:8pt;margin:0 0 2mm}
    .rp-customer{padding:3mm 0;margin:3mm 0;border-top:1px dashed #777;border-bottom:1px dashed #777}.rp-customer div{display:flex;gap:4mm;margin:1mm 0}.rp-customer dt{min-width:18mm;color:#333}.rp-customer dd{margin:0}
    .rp-items,.rp-summary-table{width:100%;border-collapse:collapse;table-layout:fixed;margin:4mm 0}.rp-items th,.rp-items td,.rp-summary-table th,.rp-summary-table td{padding:2mm 1mm;border-bottom:1px solid #ccc;vertical-align:top}.rp-items th{text-align:left;font-size:8pt}.rp-items th:first-child{width:45%}.rp-items th:nth-child(2){width:8%}.rp-items td:not(:first-child),.rp-items th:not(:first-child){text-align:right}.rp-items small{display:block;font-size:8pt;color:#333}.rp-items thead,.rp-summary-table thead{display:table-header-group}.rp-items tr,.rp-summary-table tr{break-inside:avoid}
    .rp-totals{margin:4mm 0}.rp-totals p,.rp-payment-totals p{display:flex;justify-content:space-between;gap:3mm;margin:1mm 0}.rp-grand{border-top:1px solid #111;padding-top:3mm;font-size:14pt}.rp-payment{font-weight:700;text-align:center;border:1px solid #888;padding:2mm}.rp-footer{margin-top:5mm;padding-top:3mm;border-top:1px dashed #888;text-align:center;font-size:8pt;color:#222}
    .rp-summary h2{font-size:17pt;margin:0 0 2mm}.rp-summary h3{font-size:11pt;margin:5mm 0 2mm}.rp-period{font-weight:700}.rp-window{font-size:9pt}.rp-kpis{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4mm;border:1px solid #555;padding:3mm;margin:4mm 0}.rp-kpis p{margin:0}.rp-kpis strong{display:block;font-size:15pt}.rp-summary-table{font-size:8pt}.rp-summary-table th{text-align:left}.rp-summary-table td:last-child,.rp-summary-table th:last-child{text-align:right;width:18%}.rp-summary-table tfoot th{border-top:1px solid #111}.rp-payment-totals{max-width:100mm}
  `;
  function printCSS(paper, batch) {
    return `#receiptSheet{display:none}
    @media print {
      @page{size:${paper === "receipt" ? "80mm 297mm" : "A4"};margin:${paper === "receipt" ? "3mm" : "12mm"}}
      html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;overflow:visible!important;background:#fff!important}
      body.rp-printing > *{display:none!important}
      body.rp-printing > #receiptSheet{display:block!important;visibility:visible!important;position:static!important;width:auto!important;max-width:none!important;margin:0!important;padding:0!important;background:#fff!important}
      body.rp-printing #receiptSheet *{visibility:visible!important}
      ${BASE_CSS}
      .rp-invoice{max-width:${paper === "receipt" ? "74mm" : "180mm"};margin:0 auto;${batch ? "break-after:page;page-break-after:always;" : ""}}
      .rp-invoice:last-child{break-after:auto;page-break-after:auto}
      ${paper === "receipt" ? ".rp-store h1{font-size:15pt}.rp-invoice{font-size:8pt}.rp-items td{font-size:7pt}.rp-grand{font-size:11pt}" : ""}
    }`;
  }
  function cleanup() {
    printing = false;
    doc.body.classList.remove("rp-printing");
    const style = doc.getElementById("receiptPrintStyle"); if (style) style.remove();
    const sheet = doc.getElementById("receiptSheet"); if (sheet && sheet.dataset.receiptPrint === "1") { sheet.innerHTML = ""; delete sheet.dataset.receiptPrint; }
    if (previousTitle != null) { doc.title = previousTitle; previousTitle = null; }
  }
  function print(markup, options = {}) {
    if (!allowed()) throw new Error("This area is locked. Unlock Orders & audit before printing receipts.");
    if (printing || doc.body.classList.contains("gt-printing")) throw new Error("Finish the open print dialog, then try again.");
    if (!markup || markup.length > MAX_HTML) throw new Error("This print job is too large. Choose a smaller date range or print invoices individually.");
    const paper = options.paper === "receipt" ? "receipt" : "a4";
    const title = String(options.title || "Adonai posted receipts").slice(0, 180);
    const styles = printCSS(paper, !!options.batch);
    if (global.Android) {
      if (typeof global.Android.printReceipts !== "function") throw new Error("This app build needs the receipt-print update. Open Posting Audit Logs in your phone browser, or download Excel and print from your spreadsheet app.");
      const html = `<!doctype html><html><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${styles}</style></head><body class="rp-printing"><div id="receiptSheet">${markup}</div></body></html>`;
      if (html.length > MAX_HTML) throw new Error("This print job is too large. Print a smaller selection.");
      printing = true;
      try {
        if (!global.Android.printReceipts(html, title, paper)) throw new Error("The app could not open printing. Finish any other print job, then try again.");
      } catch (error) { printing = false; throw error; }
      return {mode:"native"};
    }
    cleanup();
    let sheet = doc.getElementById("receiptSheet");
    if (!sheet) { sheet = doc.createElement("div"); sheet.id = "receiptSheet"; doc.body.appendChild(sheet); }
    sheet.innerHTML = markup; sheet.dataset.receiptPrint = "1";
    const style = doc.createElement("style"); style.id = "receiptPrintStyle"; style.textContent = styles; doc.head.appendChild(style);
    previousTitle = doc.title; doc.title = title; doc.body.classList.add("rp-printing"); printing = true;
    try { global.print(); }
    catch (_) { cleanup(); throw new Error("Printing could not open. Try your phone browser or download Excel to print it there."); }
    return {mode:"browser"};
  }
  function printReceipt(sale, settings, paper) { return print(receipt(sale, settings), {paper, title:`Adonai receipt ${sale.id}`}); }
  function printInvoices(sales, selection, settings, paper) {
    if (!sales.length) throw new Error("No posted receipts in this selection. Choose a day with sales to print.");
    if (sales.length > MAX_RECEIPTS) throw new Error("Print at most 250 invoices per job. Narrow the search or print receipts individually.");
    const ordered = sales.slice().sort((a,b) => global.AuditExports.dateOf(global.AuditExports.postingDate(a)) - global.AuditExports.dateOf(global.AuditExports.postingDate(b)));
    return print(ordered.map(sale => receipt(sale, settings)).join(""), {paper, batch:true, title:`Adonai receipts ${selection.label}`});
  }
  function printSummary(sales, selection, settings) {
    if (!sales.length) throw new Error("No posted receipts in this selection. Choose a day with sales to print.");
    return print(summary(sales, selection, settings), {paper:"a4", title:`Adonai daily sales ${selection.label}`});
  }
  global.addEventListener("afterprint", cleanup);
  global.addEventListener("pagehide", cleanup);
  global.__adonaiReceiptPrintResult = (status, message) => {
    printing = false;
    global.dispatchEvent(new CustomEvent("adonai-receipt-print-result", {detail:{status, message}}));
  };
  global.addEventListener("pos-access-change", () => {
    if (!allowed()) {
      cleanup();
      if (global.Android && typeof global.Android.cancelReceiptPrint === "function") global.Android.cancelReceiptPrint();
    }
  });
  global.ReceiptPrinter = {receipt, summary, printReceipt, printInvoices, printSummary, cleanup, paymentName, MAX_RECEIPTS};
})(typeof window !== "undefined" ? window : globalThis);
