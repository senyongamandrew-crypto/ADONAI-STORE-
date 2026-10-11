/* Inclusive audit dates are Africa/Kampala (UTC+03), not the device timezone. */
(function (global) {
  "use strict";
  const AREAS = {sales:"orders", orders:"orders", customers:"orders", ledger:"finance", expenses:"finance", journal:"finance", stock:"stock", staff:"security"};
  function kampalaDay(now = new Date()) { return new Date(now.getTime() + 3 * 3600000).toISOString().slice(0, 10); }
  function shift(day, days) { return new Date(new Date(day + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10); }
  function preset(name, now) {
    const today = kampalaDay(now);
    if (name === "today") return {from:today, to:today};
    if (name === "yesterday") return {from:shift(today, -1), to:shift(today, -1)};
    if (name === "7" || name === "30") return {from:shift(today, 1 - Number(name)), to:today};
    return {from:"", to:""};
  }
  function relative(name) { return ["today", "yesterday", "7", "30"].includes(name); }
  function untilMidnight(now = new Date()) {
    const elapsed = ((now.getTime() + 3 * 3600000) % 86400000 + 86400000) % 86400000;
    return 86400000 - elapsed + 50;
  }
  function dayLabel(day) {
    return new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", {timeZone:"Africa/Kampala", day:"numeric", month:"long", year:"numeric"});
  }
  function dayTitle(dates, now = new Date()) {
    if (dates.from && dates.from === dates.to) {
      if (dates.from === kampalaDay(now)) return "Today's receipts";
      if (dates.from === shift(kampalaDay(now), -1)) return "Yesterday's receipts";
      return "Receipts for " + dayLabel(dates.from);
    }
    return dates.from || dates.to ? "Receipts in selected dates" : "Saved receipt history";
  }
  function range(from, to) {
    for (const day of [from, to]) {
      if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day + "T00:00:00Z")) || new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day)) throw new Error("Choose valid start and end dates.");
    }
    if (from && to && from > to) throw new Error("The start date must be on or before the end date.");
    return {from:from || "", to:to || "", label:from && from === to ? from : from || to ? `${from || "Beginning"} to ${to || "Latest"}` : "All dates"};
  }
  function dateOf(value) {
    if (value instanceof Date) return value;
    let text = String(value || "");
    // SQL serializes UTC timestamps without a zone; do not interpret them as
    // local phone time. Older browser-created ISO dates already end with Z.
    if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(text) && !/(Z|[+-]\d\d:\d\d)$/.test(text)) text += "Z";
    return new Date(text);
  }
  function within(value, dates) {
    const date = dateOf(value);
    if (!Number.isFinite(date.getTime())) return !dates.from && !dates.to;
    const day = kampalaDay(date);
    return (!dates.from || day >= dates.from) && (!dates.to || day <= dates.to);
  }
  function stamp(value) {
    const date = dateOf(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("en-GB", {timeZone:"Africa/Kampala", dateStyle:"medium", timeStyle:"short"}) + " EAT" : "Date not recorded";
  }
  function posted(sale) {
    if (["cancelled", "canceled", "void", "expired"].includes(String(sale.status || "").toLowerCase())) return false;
    const status = String(sale.payment_status || sale.payment?.status || "").toLowerCase();
    return status === "paid" || (["", "unpaid"].includes(status) && sale.channel === "pos" && String(sale.status || "").toLowerCase() === "completed");
  }
  function postingDate(sale) { return sale.paid_at || sale.payment?.paid_at || sale.created_at || sale.createdAt; }
  function searchFields(sale) {
    const date = dateOf(postingDate(sale));
    const iso = Number.isFinite(date.getTime()) ? new Date(date.getTime() + 3 * 3600000).toISOString().slice(0, 19).replace("T", " ") + " +03:00" : "";
    const items = sale.items || [];
    return [sale.id, iso, sale.customer_name || "Walk-in customer", sale.customer_phone, sale.customer_address,
      sale.channel, sale.payment_status || sale.payment?.status || "", sale.payment_method || sale.tender_type || sale.tender?.type || "",
      sale.status, sale.dispatch_status, sale.cashier_name || sale.cashier?.name,
      items.map(item => `${item.name} × ${item.qty} @ ${Number(item.unit_price || 0)} UGX`).join("; "),
      items.reduce((total, item) => total + Number(item.qty || 0), 0), Number(sale.subtotal || 0), Number(sale.delivery_fee || 0), Number(sale.total || 0)];
  }
  function note(kind) {
    if (kind === "customers") return "Customer contacts captured from orders in this period, grouped by phone (or name + address). Paid spend excludes unpaid or cancelled orders.";
    if (kind === "stock") return "Current prices and quantities for garments whose intake date falls in this period — not a historical stock balance.";
    if (kind === "staff") return "Staff created in this period. Optional administrator protection applies. No passwords, PINs or secret keys are exported.";
    if (kind === "ledger") return "Actual ledger postings in this period, including sales, expenses, refunds and adjustments. Signed UGX amounts are preserved.";
    if (kind === "expenses") return "Expense records by expense date, with vendor, status and payment details.";
    if (kind === "journal") return "Actual journal lines by posting date, with separate debit and credit columns.";
    if (kind === "orders") return "All orders created in this period, including unpaid, cancelled and completed orders, with customer and fulfillment details.";
    return "Completed POS checkouts and confirmed paid online orders, by posting/payment date. Pending or cancelled orders are excluded.";
  }
  global.AuditExports = {AREAS, kampalaDay, preset, relative, untilMidnight, dayLabel, dayTitle, range, dateOf, within, stamp, posted, postingDate, searchFields, note};
})(typeof window !== "undefined" ? window : globalThis);
