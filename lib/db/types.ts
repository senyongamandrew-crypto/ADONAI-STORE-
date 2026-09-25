import type { Channel, Condition, Role, Tender } from "@/lib/config";

export type Product = {
  id: string;
  sku: string;
  title: string;
  description: string | null;
  category: string;
  condition: Condition;
  size: string;
  image_url: string | null;
  /** Wholesale/base cost in UGX (whole shillings). */
  cost_price: number;
  /** Retail price in UGX. */
  price: number;
  stock: number;
  min_stock: number;
  barcode: string;
  /** Percentage discount applied on top of `price` (0 = none). */
  discount_pct: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type SaleLine = {
  product_id: string;
  sku: string;
  title: string;
  qty: number;
  unit_price: number;
  line_total: number;
};

export type SaleStatus = "completed" | "pending" | "cancelled" | "refunded";

export type Sale = {
  id: string;
  ref: string;
  channel: Channel;
  tender: Tender | null;
  status: SaleStatus;
  customer_name: string | null;
  customer_phone: string | null;
  subtotal: number;
  discount_total: number;
  total: number;
  amount_received: number;
  change_due: number;
  note: string | null;
  cashier_id: string | null;
  cashier_name: string | null;
  lines: SaleLine[];
  created_at: string;
};

export type StockMovement = {
  id: string;
  product_id: string;
  sku: string;
  delta: number;
  reason: string;
  sale_id: string | null;
  created_at: string;
};

export type Profile = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

export type Session = { user: Profile; token?: string };

export type Analytics = {
  today: { revenue: number; transactions: number; units: number; aov: number };
  window: { revenue: number; transactions: number; units: number; aov: number };
  byChannel: { channel: Channel; revenue: number; transactions: number }[];
  byTender: { tender: string; revenue: number; transactions: number }[];
  byCategory: { category: string; revenue: number; units: number }[];
  topProducts: { title: string; sku: string; revenue: number; units: number }[];
  daily: { date: string; revenue: number; transactions: number }[];
  stockValue: { atCost: number; atRetail: number };
  lowStock: { id: string; sku: string; title: string; stock: number; min_stock: number }[];
};
