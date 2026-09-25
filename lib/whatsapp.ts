import { STORE, CURRENCY } from "@/lib/config";
import { fmtNumber } from "@/lib/money";

export type OrderLine = { sku: string; title: string; size?: string; qty: number; unit_price: number; line_total: number };

/**
 * WhatsApp Order Orchestrator Engine.
 * Converts the cart into a structured fulfilment message and returns a wa.me deep link.
 */
export function buildOrderMessage(lines: OrderLine[], customer: { name?: string; phone?: string; note?: string } = {}): string {
  const stamp = new Date().toLocaleString("en-GB", { timeZone: "Africa/Kampala" });
  const total = lines.reduce((s, l) => s + l.line_total, 0);
  const units = lines.reduce((s, l) => s + l.qty, 0);

  const out: string[] = [];
  out.push(`*NEW ORDER — ${STORE.name}*`);
  out.push(`${stamp} EAT`);
  out.push("");
  if (customer.name) out.push(`Customer: ${customer.name}`);
  if (customer.phone) out.push(`Phone: ${customer.phone}`);
  out.push("");
  out.push("Items:");
  lines.forEach((l, i) => {
    const size = l.size && l.size !== "One size" ? ` (${l.size})` : "";
    out.push(`${i + 1}. ${l.title}${size} — ${l.qty} x ${CURRENCY.symbol} ${fmtNumber(l.unit_price)} = ${CURRENCY.symbol} ${fmtNumber(l.line_total)}  [${l.sku}]`);
  });
  out.push("");
  out.push(`Units: ${units}`);
  out.push(`*TOTAL: ${CURRENCY.symbol} ${fmtNumber(total)}*`);
  if (customer.note) out.push(`\nNote: ${customer.note}`);
  out.push("\nPayment: Mobile Money (MTN/Airtel) or cash on collection.");
  out.push(`Please confirm availability — ${STORE.hours}.`);
  return out.join("\n");
}

/** wa.me requires digits only, no "+". */
export const waNumber = (phone: string = STORE.whatsapp): string => phone.replace(/[^\d]/g, "");

export function whatsappOrderUrl(lines: OrderLine[], customer: { name?: string; phone?: string; note?: string } = {}, phone?: string): string {
  const text = buildOrderMessage(lines, customer);
  return `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
}

/** Short "message the store" link (used on the empty cart / contact spots). */
export const whatsappChatUrl = (text = `Hello ${STORE.name}, I have a question about an item.`, phone?: string): string =>
  `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
