"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CartLine = {
  product_id: string;
  sku: string;
  title: string;
  size: string;
  unit_price: number;
  qty: number;
  stock: number;
};

type CartState = {
  lines: CartLine[];
  open: boolean;
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  setQty: (id: string, qty: number) => void;
  remove: (id: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
};

const merge = (lines: CartLine[], incoming: Omit<CartLine, "qty">, qty: number): CartLine[] => {
  const existing = lines.find((l) => l.product_id === incoming.product_id);
  if (!existing) return [...lines, { ...incoming, qty }];
  return lines.map((l) =>
    l.product_id === incoming.product_id
      ? { ...l, qty: Math.min(Math.max(l.qty + qty, 0), Math.max(incoming.stock, l.qty + qty)), stock: incoming.stock, unit_price: incoming.unit_price }
      : l,
  ).filter((l) => l.qty > 0);
};

export const useWebCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      open: false,
      add: (line, qty = 1) => set((s) => ({ lines: merge(s.lines, line, qty), open: true })),
      setQty: (id, qty) => set((s) => ({ lines: s.lines.map((l) => (l.product_id === id ? { ...l, qty: Math.max(0, qty) } : l)).filter((l) => l.qty > 0) })),
      remove: (id) => set((s) => ({ lines: s.lines.filter((l) => l.product_id !== id) })),
      clear: () => set({ lines: [] }),
      setOpen: (open) => set({ open }),
    }),
    { name: "adonai-web-cart" },
  ),
);

/** POS ledger lives in memory only — a new shift starts with an empty ticket. */
export const usePosLedger = create<{
  lines: CartLine[];
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  setQty: (id: string, qty: number) => void;
  remove: (id: string) => void;
  clear: () => void;
}>()((set) => ({
  lines: [],
  add: (line, qty = 1) => set((s) => ({ lines: merge(s.lines, line, qty) })),
  setQty: (id, qty) => set((s) => ({ lines: s.lines.map((l) => (l.product_id === id ? { ...l, qty: Math.max(0, qty) } : l)).filter((l) => l.qty > 0) })),
  remove: (id) => set((s) => ({ lines: s.lines.filter((l) => l.product_id !== id) })),
  clear: () => set({ lines: [] }),
}));

export const cartTotals = (lines: CartLine[]) => {
  const units = lines.reduce((a, l) => a + l.qty, 0);
  const subtotal = lines.reduce((a, l) => a + l.unit_price * l.qty, 0);
  return { units, subtotal };
};
