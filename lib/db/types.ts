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
  /**
   * Advisory counters — they never touch `stock`, so the counter can still ring
   * up a piece that is on the fitting-room rail or the QC bench. They exist so
   * the back office can see where every unit physically is.
   */
  on_trial: number;
  in_inspection: number;
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

/** One row per enrolled authenticator. Public material only — never a private key. */
export type PasskeyCredential = {
  /** base64url credentialID, unique per authenticator. */
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  user_role: Role | null;
  /** base64url COSE public key. */
  public_key: string;
  /** Sign count, replay defence. Must be persisted and checked on every assertion. */
  counter: number;
  transports: string[];
  /** Operator-friendly label, e.g. "Andrew's MacBook". */
  name: string;
  device_type: "singleDevice" | "multiDevice" | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
  /** Soft delete: revoked credentials stay for the audit trail and can never sign in. */
  revoked_at: string | null;
  revoked_by: string | null;
};

/** What the admin Security panel shows per staff member. */
export type UserSummary = {
  id: string;
  email: string;
  name: string;
  role: Role;
  passkeys: number;
  active_passkeys: number;
  revoked_passkeys: number;
  last_used_at: string | null;
  sessions_invalid_before: string | null;
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
