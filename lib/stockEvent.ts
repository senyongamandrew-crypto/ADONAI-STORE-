/**
 * Wire format for stock pushes. Shared by the server bus, the SSE endpoint and
 * the browser hook, so it must stay free of server-only imports.
 */
export type StockEvent = {
  product_id: string;
  sku: string;
  stock: number;
  /** Advisory counters, carried so the Trial / Inspection tabs need no refetch. */
  on_trial?: number;
  in_inspection?: number;
  /** Lets a listener flag low stock without a second round trip. */
  min_stock?: number;
  reason: string;
  at: string;
};

export const isStockEvent = (value: unknown): value is StockEvent => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.product_id === "string" && typeof v.stock === "number";
};
