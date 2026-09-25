import { DEFAULT_MIN_STOCK } from "@/lib/config";
import { toShillings } from "@/lib/money";
import { buildAnalytics } from "@/lib/db/analytics";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { CreateSaleInput, ProductInput, ProductQuery, SaleQuery, Store } from "@/lib/db/store";
import type { Analytics, Product, Profile, Sale, SaleLine, SaleStatus, Session, StockMovement } from "@/lib/db/types";

type ProductRow = Record<string, unknown>;
type SaleRow = Record<string, unknown> & { id: string; created_at: string };

const toProduct = (r: ProductRow): Product => ({
  id: String(r.id),
  sku: String(r.sku),
  title: String(r.title),
  description: (r.description as string) ?? null,
  category: String(r.category ?? "Accessories"),
  condition: String(r.condition ?? "Good") as Product["condition"],
  size: String(r.size ?? "One size"),
  image_url: (r.image_url as string) ?? null,
  cost_price: toShillings(r.cost_price as number),
  price: toShillings(r.price as number),
  stock: toShillings(r.stock as number),
  min_stock: toShillings((r.min_stock as number) ?? DEFAULT_MIN_STOCK),
  barcode: String(r.barcode ?? ""),
  discount_pct: toShillings((r.discount_pct as number) ?? 0),
  active: Boolean(r.active ?? true),
  created_at: String(r.created_at ?? new Date().toISOString()),
  updated_at: String(r.updated_at ?? new Date().toISOString()),
});

const toSale = (r: SaleRow, lines: SaleLine[]): Sale => ({
  id: r.id,
  ref: String(r.ref),
  channel: (r.channel as Sale["channel"]) ?? "pos",
  tender: (r.tender as Sale["tender"]) ?? null,
  status: (r.status as SaleStatus) ?? "completed",
  customer_name: (r.customer_name as string) ?? null,
  customer_phone: (r.customer_phone as string) ?? null,
  subtotal: toShillings(r.subtotal as number),
  discount_total: toShillings(r.discount_total as number),
  total: toShillings(r.total as number),
  amount_received: toShillings(r.amount_received as number),
  change_due: toShillings(r.change_due as number),
  note: (r.note as string) ?? null,
  cashier_id: (r.cashier_id as string) ?? null,
  cashier_name: (r.cashier_name as string) ?? null,
  lines,
  created_at: r.created_at,
});

const toLine = (r: Record<string, unknown>): SaleLine => ({
  product_id: String(r.product_id),
  sku: String(r.sku),
  title: String(r.title),
  qty: toShillings(r.qty as number),
  unit_price: toShillings(r.unit_price as number),
  line_total: toShillings(r.line_total as number),
});

async function fetchSales(db: ReturnType<typeof supabaseAdmin>, query: SaleQuery): Promise<Sale[]> {
  let q = db.from("sales").select("*").order("created_at", { ascending: false });
  if (query.channel) q = q.eq("channel", query.channel);
  if (query.status) q = q.eq("status", query.status);
  if (query.from) q = q.gte("created_at", query.from);
  if (query.to) q = q.lte("created_at", query.to);
  if (query.limit) q = q.limit(query.limit);

  const { data, error } = await q;
  if (error) throw new Error(`sales: ${error.message}`);
  const sales = (data ?? []) as SaleRow[];
  if (!sales.length) return [];

  const ids = sales.map((s) => s.id);
  const { data: lines, error: lineErr } = await db.from("sale_lines").select("*").in("sale_id", ids);
  if (lineErr) throw new Error(`sale_lines: ${lineErr.message}`);

  const grouped = new Map<string, SaleLine[]>();
  for (const l of (lines ?? []) as Record<string, unknown>[]) {
    const key = String(l.sale_id);
    grouped.set(key, [...(grouped.get(key) ?? []), toLine(l)]);
  }
  return sales.map((s) => toSale(s, grouped.get(s.id) ?? []));
}

async function fetchProducts(db: ReturnType<typeof supabaseAdmin>, query: ProductQuery): Promise<Product[]> {
  let q = db.from("products").select("*");
  if (!query.includeInactive) q = q.eq("active", true);
  if (query.inStockOnly) q = q.gt("stock", 0);
  if (query.category && query.category !== "All") q = q.eq("category", query.category);
  if (query.query?.trim()) {
    const s = query.query.trim().replace(/[%,()]/g, " ");
    q = q.or(`title.ilike.%${s}%,sku.ilike.%${s}%,barcode.ilike.%${s}%`);
  }
  const { data, error } = await q.order("title");
  if (error) throw new Error(`products: ${error.message}`);
  return ((data ?? []) as ProductRow[]).map(toProduct);
}

export const supabaseStore: Store = {
  kind: "supabase",

  listProducts: (q = {}) => fetchProducts(supabaseAdmin(), q),

  async findProduct(key) {
    const k = key.trim();
    const { data, error } = await supabaseAdmin()
      .from("products")
      .select("*")
      .or(`id.eq.${k},sku.ilike.${k},barcode.eq.${k}`)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findProduct: ${error.message}`);
    return data ? toProduct(data) : null;
  },

  async upsertProduct(input: ProductInput) {
    const db = supabaseAdmin();
    const row = {
      sku: (input.sku || "").trim().toUpperCase(),
      title: input.title.trim(),
      description: input.description ?? null,
      category: input.category || "Accessories",
      condition: input.condition || "Good",
      size: input.size || "One size",
      image_url: input.image_url ?? null,
      cost_price: toShillings(input.cost_price),
      price: toShillings(input.price),
      stock: Math.max(0, Math.floor(input.stock ?? 0)),
      min_stock: Math.max(0, Math.floor(input.min_stock ?? DEFAULT_MIN_STOCK)),
      discount_pct: Math.min(Math.max(input.discount_pct ?? 0, 0), 90),
      active: input.active ?? true,
    };
    const { data, error } = await db.from("products").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw new Error(error.message.includes("duplicate") ? `SKU ${row.sku} already exists.` : error.message);
    return toProduct(data);
  },

  async deleteProduct(id) {
    const { error } = await supabaseAdmin().from("products").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  async adjustStock(id, delta, reason, saleId = null) {
    const db = supabaseAdmin();
    const { error } = await db.rpc("adjust_stock", { p_product: id, p_delta: delta, p_reason: reason });
    if (error) throw new Error(error.message);
    if (saleId) {
      /* sale_id is recorded by decrement_stock inside finalize_sale */
    }
    const { data } = await db.from("products").select("*").eq("id", id).single();
    return toProduct(data);
  },

  listSales: (q = {}) => fetchSales(supabaseAdmin(), q),

  async createSale(input, actor) {
    const db = supabaseAdmin();
    const payload = {
      channel: input.channel,
      tender: input.tender ?? null,
      status: input.status ?? (input.channel === "pos" ? "completed" : "pending"),
      customer_name: input.customer_name ?? null,
      customer_phone: input.customer_phone ?? null,
      amount_received: input.amount_received ?? 0,
      discount_total: input.discount_total ?? 0,
      note: input.note ?? null,
      lines: input.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price ?? null })),
    };
    const { data, error } = await db.rpc("finalize_sale", {
      payload,
      actor: { id: actor?.id ?? "", name: actor?.name ?? "" },
    });
    if (error) throw new Error(/INSUFFICIENT_STOCK/.test(error.message) ? "Insufficient stock for one of the scanned items." : error.message);
    const sale = await db.from("sales").select("*").eq("id", (data as { id: string }).id).single();
    if (sale.error) throw new Error(sale.error.message);
    const lines = await db.from("sale_lines").select("*").eq("sale_id", (data as { id: string }).id);
    return toSale(sale.data as SaleRow, ((lines.data ?? []) as Record<string, unknown>[]).map(toLine));
  },

  async setSaleStatus(id, status) {
    const db = supabaseAdmin();
    const { data: found } = await db.from("sales").select("id").or(`id.eq.${id},ref.eq.${id}`).maybeSingle();
    if (!found) throw new Error("Sale not found.");
    const { error } = await db.rpc("set_sale_status", { p_sale: found.id, p_status: status });
    if (error) throw new Error(error.message);
    const sale = await fetchSales(db, { limit: 500 });
    const row = sale.find((s) => s.id === found.id);
    if (!row) throw new Error("Sale not found after update.");
    return row;
  },

  async listMovements(limit = 100) {
    const { data, error } = await supabaseAdmin().from("stock_movements").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      product_id: String(r.product_id),
      sku: String(r.sku ?? ""),
      delta: toShillings(r.delta as number),
      reason: String(r.reason ?? ""),
      sale_id: (r.sale_id as string) ?? null,
      created_at: String(r.created_at),
    })) as StockMovement[];
  },

  async analytics(days = 30) {
    const db = supabaseAdmin();
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [sales, products] = await Promise.all([
      fetchSales(db, { from: since, limit: 5000 }),
      fetchProducts(db, { includeInactive: true }),
    ]);
    return buildAnalytics(sales, products, days) satisfies Analytics;
  },

  async signIn(email, password) {
    const db = supabaseAdmin();
    const { data, error } = await db.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.user) return null;
    const { data: profile } = await db.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
    if (!profile) return null;
    return {
      user: { id: profile.id as string, email: profile.email as string, name: (profile.name as string) ?? "", role: profile.role as Profile["role"] },
      token: data.session!.access_token,
    } satisfies Session;
  },

  async getSession(token) {
    const db = supabaseAdmin();
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return null;
    const { data: profile } = await db.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
    if (!profile) return null;
    return { user: { id: profile.id as string, email: profile.email as string, name: (profile.name as string) ?? "", role: profile.role as Profile["role"] } };
  },
};
