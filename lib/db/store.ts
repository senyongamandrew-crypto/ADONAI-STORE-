import type { Channel, Role } from "@/lib/config";
import type { Analytics, Product, Profile, Sale, SaleStatus, Session, StockMovement } from "@/lib/db/types";

export type ProductInput = {
  id?: string;
  sku?: string;
  title: string;
  description?: string | null;
  category: string;
  condition: string;
  size: string;
  image_url?: string | null;
  cost_price: number;
  price: number;
  stock: number;
  min_stock?: number;
  barcode?: string;
  discount_pct?: number;
  active?: boolean;
};

export type SaleLineInput = { product_id: string; qty: number; unit_price?: number };

export type CreateSaleInput = {
  channel: Channel;
  tender?: string | null;
  status?: SaleStatus;
  customer_name?: string | null;
  customer_phone?: string | null;
  amount_received?: number;
  note?: string | null;
  discount_total?: number;
  lines: SaleLineInput[];
};

export type ProductQuery = {
  query?: string;
  category?: string;
  includeInactive?: boolean;
  inStockOnly?: boolean;
};

export type SaleQuery = { from?: string; to?: string; channel?: Channel; status?: SaleStatus; limit?: number };

/**
 * Separation of concerns: the app only ever talks to this interface.
 * `supabaseDriver` is production (Postgres + RLS + RPC); `localDriver` is the
 * zero-config file driver used when Supabase env vars are absent.
 */
export interface Store {
  readonly kind: "supabase" | "local";
  listProducts(q?: ProductQuery): Promise<Product[]>;
  findProduct(idOrSkuOrBarcode: string): Promise<Product | null>;
  upsertProduct(input: ProductInput): Promise<Product>;
  deleteProduct(id: string): Promise<void>;
  adjustStock(id: string, delta: number, reason: string, saleId?: string | null): Promise<Product>;
  listSales(q?: SaleQuery): Promise<Sale[]>;
  createSale(input: CreateSaleInput, actor?: Profile | null): Promise<Sale>;
  setSaleStatus(id: string, status: SaleStatus): Promise<Sale>;
  listMovements(limit?: number): Promise<StockMovement[]>;
  analytics(days?: number): Promise<Analytics>;
  signIn(email: string, password: string): Promise<Session | null>;
  getSession(token: string): Promise<Session | null>;
}
