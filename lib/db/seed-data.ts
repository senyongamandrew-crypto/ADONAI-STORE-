import { DEFAULT_MIN_STOCK } from "@/lib/config";
import { generateBarcode } from "@/lib/barcode";
import type { Product, Sale, SaleLine, StockMovement } from "@/lib/db/types";

type SeedRow = [title: string, category: string, condition: string, size: string, cost: number, price: number, stock: number, discount?: number];

const ROWS: SeedRow[] = [
  ["Floral Midi Wrap Dress", "Dresses", "Like new", "UK 10", 12000, 35000, 6],
  ["Ankara Print Party Dress", "Dresses", "Good", "UK 8", 9000, 28000, 4],
  ["Linen Shift Dress — Beige", "Dresses", "New with tags", "UK 12", 16000, 48000, 3],
  ["Denim Button Front Dress", "Dresses", "Good", "UK 10", 11000, 32000, 0],
  ["Silk Blouse — Emerald", "Tops & Blouses", "Like new", "M", 8000, 24000, 9],
  ["Cotton Peplum Top", "Tops & Blouses", "Good", "L", 6000, 18000, 12, 10],
  ["Off-Shoulder Summer Blouse", "Tops & Blouses", "Fair", "S", 4500, 14000, 7],
  ["High-Waist Skinny Jeans", "Jeans & Denim", "Good", "UK 10", 10000, 29000, 8],
  ["Boyfriend Jeans — Faded", "Jeans & Denim", "Like new", "UK 12", 12500, 36000, 5],
  ["Denim Jacket — Vintage Wash", "Jackets & Coats", "Good", "M", 18000, 52000, 2],
  ["Trench Coat — Camel", "Jackets & Coats", "Like new", "L", 26000, 75000, 1],
  ["Oxford Shirt — White", "Shirts", "New with tags", "L", 7000, 22000, 14],
  ["Floral Shirt — Short Sleeve", "Shirts", "Good", "M", 5500, 17000, 10],
  ["Cigarette Trousers — Black", "Trousers", "Like new", "UK 10", 8500, 26000, 6],
  ["Wide-Leg Linen Trousers", "Trousers", "Good", "UK 12", 9500, 28000, 4],
  ["Pleated Midi Skirt", "Skirts", "Good", "UK 8", 7000, 21000, 5],
  ["Denim A-Line Skirt", "Skirts", "Fair", "UK 10", 5000, 15000, 9],
  ["Leather Ankle Boots", "Shoes", "Good", "38", 22000, 62000, 3],
  ["White Canvas Sneakers", "Shoes", "Like new", "39", 18000, 52000, 4],
  ["Block Heel Pumps", "Shoes", "Good", "37", 15000, 45000, 2],
  ["Tote Handbag — Tan", "Bags", "Like new", "One size", 16000, 48000, 3],
  ["Crossbody Satchel", "Bags", "Good", "One size", 9000, 27000, 6],
  ["Kids Denim Overalls (4-5y)", "Kids", "Good", "S", 5000, 16000, 11],
  ["Kids Tracksuit Set (6-7y)", "Kids", "New with tags", "M", 7000, 22000, 8],
];

export const SEED_PRODUCTS: Product[] = ROWS.map((r, i) => {
  const sku = `AD-${String(i + 1).padStart(3, "0")}`;
  return {
    id: `prd_${String(i + 1).padStart(3, "0")}`,
    sku,
    title: r[0],
    description: `${r[1]} · ${r[2]} · Size ${r[3]}. Sourced from our bale selection, washed and quality-checked in store.`,
    category: r[1],
    condition: r[2] as Product["condition"],
    size: r[3],
    image_url: null,
    cost_price: r[4],
    price: r[5],
    stock: r[6],
    min_stock: DEFAULT_MIN_STOCK,
    barcode: generateBarcode(sku),
    discount_pct: r[7] ?? 0,
    active: true,
    created_at: new Date(Date.now() - (ROWS.length - i) * 86400000).toISOString(),
    updated_at: new Date().toISOString(),
  };
});

/** Deterministic PRNG so demo analytics look stable between reseeds. */
function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Doreen A.", "Moses K.", "Sarah N.", "Peter O.", "Aisha M.", "Brian T.", "Joan W.", "Ronald S.", "Esther B.", "Samuel L."];

/** Builds ~21 days of mixed POS + online demo transactions so the dashboard is meaningful. */
export function seedSales(products: Product[], days = 21): { sales: Sale[]; movements: StockMovement[] } {
  const rnd = mulberry(20260925);
  const sales: Sale[] = [];
  const movements: StockMovement[] = [];
  let seq = 1;
  let posSeq = 1;
  let onlSeq = 1;

  for (let d = days - 1; d >= 0; d--) {
    const txCount = 3 + Math.floor(rnd() * 7); // 3–9 transactions/day
    for (let t = 0; t < txCount; t++) {
      const day = new Date(Date.now() - d * 86400000);
      day.setHours(9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), 0, 0);
      const channel = rnd() > 0.34 ? "pos" : "online";
      const lineCount = 1 + Math.floor(rnd() * 3);
      const lines: SaleLine[] = [];
      for (let l = 0; l < lineCount; l++) {
        const p = products[Math.floor(rnd() * products.length)];
        if (lines.some((x) => x.product_id === p.id)) continue;
        const qty = 1 + (rnd() > 0.85 ? 1 : 0);
        const unit = Math.round((p.price * (1 - p.discount_pct / 100)) / 100) * 100;
        lines.push({ product_id: p.id, sku: p.sku, title: p.title, qty, unit_price: unit, line_total: unit * qty });
      }
      if (!lines.length) continue;
      const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
      const prefix = channel === "pos" ? "POS" : "ONL";
      const n = (channel === "pos" ? posSeq++ : onlSeq++);
      const ref = `${prefix}-${String(n).padStart(5, "0")}`;
      const sale: Sale = {
        id: `sale_${String(seq).padStart(5, "0")}`,
        ref,
        channel,
        tender: channel === "pos" ? (rnd() > 0.45 ? "Cash" : rnd() > 0.5 ? "MTN MoMo" : "Airtel Money") : null,
        status: channel === "pos" ? "completed" : rnd() > 0.2 ? "completed" : "pending",
        customer_name: channel === "online" ? NAMES[Math.floor(rnd() * NAMES.length)] : null,
        customer_phone: channel === "online" ? `+2567${String(Math.floor(rnd() * 9000000 + 1000000))}` : null,
        subtotal,
        discount_total: 0,
        total: subtotal,
        amount_received: channel === "pos" ? Math.ceil((subtotal * 1.02) / 500) * 500 : 0,
        change_due: 0,
        note: null,
        cashier_id: "usr_cashier",
        cashier_name: "Ivan Kato",
        lines,
        created_at: day.toISOString(),
      };
      sale.change_due = Math.max(0, sale.amount_received - sale.total);
      sales.push(sale);
      if (sale.status === "completed") {
        for (const l of lines) {
          movements.push({
            id: `mv_${movements.length + 1}`,
            product_id: l.product_id,
            sku: l.sku,
            delta: -l.qty,
            reason: `${channel === "pos" ? "Counter sale" : "Online order"} ${ref}`,
            sale_id: sale.id,
            created_at: sale.created_at,
          });
        }
      }
      seq++;
    }
  }
  return { sales: sales.reverse(), movements };
}
