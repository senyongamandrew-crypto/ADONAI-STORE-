import { toShillings } from "@/lib/money";

export type Margin = {
  cost: number;
  retail: number;
  markupPct: number;   // over cost
  grossProfit: number; // retail - cost
  marginPct: number;   // gross profit as % of retail
};

/** Dynamic pricing engine: retail markup, promo discount and net margin in UGX. */
export function computeMargin(cost: number, retail: number, discountPct = 0): Margin {
  const c = toShillings(cost);
  const sticker = toShillings(retail);
  const sell = toShillings(sticker * (1 - Math.min(Math.max(discountPct, 0), 100) / 100));
  const grossProfit = sell - c;
  return {
    cost: c,
    retail: sell,
    markupPct: c > 0 ? Math.round((sell / c - 1) * 1000) / 10 : 0,
    grossProfit,
    marginPct: sell > 0 ? Math.round((grossProfit / sell) * 1000) / 10 : 0,
  };
}

/** Suggest a retail price from cost using a target margin. */
export const priceForTargetMargin = (cost: number, targetMarginPct: number): number => {
  const c = toShillings(cost);
  const m = Math.min(Math.max(targetMarginPct, 0), 95) / 100;
  const raw = c / (1 - m);
  return toShillings(Math.ceil(raw / 500) * 500); // round up to the nearest 500 UGX
};
