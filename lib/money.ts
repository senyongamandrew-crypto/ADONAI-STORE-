import { CURRENCY } from "@/lib/config";

/** UGX is stored and computed as whole shillings (integers). */
export const toShillings = (n: number | string | null | undefined): number => {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return Number.isFinite(v) ? Math.round(v) : 0;
};

export const fmt = (amount: number | string | null | undefined): string => {
  const v = toShillings(amount);
  return `${CURRENCY.symbol} ${v.toLocaleString("en-UG")}`;
};

export const fmtNumber = (amount: number | string | null | undefined): string =>
  toShillings(amount).toLocaleString("en-UG");

/** Effective unit price after product-level discount. */
export const unitPrice = (price: number, discount_pct = 0): number =>
  toShillings(price * (1 - Math.min(Math.max(discount_pct, 0), 100) / 100));

export const lineTotal = (price: number, qty: number, discount_pct = 0): number =>
  toShillings(unitPrice(price, discount_pct) * qty);

export const changeFor = (total: number, received: number): number =>
  Math.max(0, toShillings(received) - toShillings(total));

/** Common tender shortcuts for the POS keypad. */
export const quickTenders = (total: number): number[] => {
  const notes = [500, 1000, 2000, 5000, 10000, 20000, 50000];
  const exact = toShillings(total);
  const nextNote = notes.find((n) => n >= exact) ?? Math.ceil(exact / 50000) * 50000;
  const set = new Set<number>([exact, nextNote]);
  for (const m of [2, 5, 10]) if (nextNote * m < 1_000_000) set.add(nextNote * m);
  return [...set].sort((a, b) => a - b).slice(0, 6);
};
