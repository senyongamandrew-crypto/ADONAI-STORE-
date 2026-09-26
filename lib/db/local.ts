/**
 * Local file-backed driver.
 * Used when NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent, so the
 * system is fully runnable (and demoable) with zero cloud accounts. Same `Store`
 * contract as the Supabase driver, including atomic stock decrement.
 */
import { createHash, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_MIN_STOCK, DEMO_USERS } from "@/lib/config";
import { generateBarcode } from "@/lib/barcode";
import { toShillings } from "@/lib/money";
import type { CreateSaleInput, ProductInput, ProductQuery, SaleQuery, Store } from "@/lib/db/store";
import type { Analytics, Product, Profile, Sale, SaleStatus, Session, StockMovement } from "@/lib/db/types";
import { SEED_PRODUCTS, seedSales } from "@/lib/db/seed-data";
import { buildAnalytics } from "@/lib/db/analytics";
import { publishStock } from "@/lib/events";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "adonai.json");
const SECRET = process.env.LOCAL_AUTH_SECRET || "adonai-local-dev-secret";

type Db = {
  products: Product[];
  sales: Sale[];
  movements: StockMovement[];
  users: ({ id: string; password_hash: string } & Profile)[];
  seq: number;
};

/** Push a stock change to any connected browser (showroom, second terminal). */
const announce = (p: { id: string; sku: string; stock: number }, reason: string) =>
  publishStock({ product_id: p.id, sku: p.sku, stock: p.stock, reason });

const hash = (pw: string) => scryptSync(pw, SECRET, 32).toString("hex");
const now = () => new Date().toISOString();

function blankDb(): Db {
  const products = SEED_PRODUCTS.map((p) => ({ ...p }));
  const { sales, movements } = seedSales(products);
  return {
    products,
    sales,
    movements,
    users: DEMO_USERS.map((u, i) => ({
      id: `usr_${u.role}${i ? i : ""}`,
      email: u.email,
      name: u.name,
      role: u.role,
      password_hash: hash(u.password),
    })),
    seq: 1,
  };
}

let cache: Db | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Serialises writes so stock decrement + sale insert stay atomic inside the process. */
function tx<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const db = load();
    const out = await fn(db);
    persist(db);
    return out;
  });
  chain = next.catch(() => undefined);
  return next;
}

function load(): Db {
  if (cache) return cache;
  if (existsSync(DATA_FILE)) {
    try {
      cache = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Db;
      return cache;
    } catch {
      /* fall through to reseed */
    }
  }
  cache = blankDb();
  persist(cache);
  return cache;
}

function persist(db: Db) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DATA_FILE);
  cache = db;
}

const matches = (p: Product, q: ProductQuery) => {
  if (!q.includeInactive && !p.active) return false;
  if (q.inStockOnly && p.stock <= 0) return false;
  if (q.category && q.category !== "All" && p.category !== q.category) return false;
  if (q.query) {
    const s = q.query.trim().toLowerCase();
    if (s) {
      const hay = `${p.title} ${p.sku} ${p.barcode} ${p.category} ${p.size} ${p.description ?? ""}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
  }
  return true;
};

/** Same allocation rule as the Postgres next_sale_ref(): per-channel sequence, never reused. */
function nextRef(db: Db, channel: "pos" | "online"): string {
  const prefix = channel === "pos" ? "POS" : "ONL";
  const used = new Set(db.sales.map((s) => s.ref));
  let n = db.sales.filter((s) => s.channel === channel).length + 1;
  while (used.has(`${prefix}-${String(n).padStart(5, "0")}`)) n++;
  return `${prefix}-${String(n).padStart(5, "0")}`;
}

function makeSale(db: Db, input: CreateSaleInput, actor?: Profile | null): Sale {
  if (!input.lines?.length) throw new Error("Sale needs at least one line item.");
  const lines = input.lines.map((l) => {
    const p = db.products.find((x) => x.id === l.product_id || x.sku === l.product_id || x.barcode === l.product_id);
    if (!p) throw new Error(`Unknown product: ${l.product_id}`);
    const qty = Math.max(1, Math.floor(l.qty));
    const unit = l.unit_price != null ? toShillings(l.unit_price) : toShillings(p.price * (1 - p.discount_pct / 100));
    return { product_id: p.id, sku: p.sku, title: p.title, qty, unit_price: unit, line_total: unit * qty, _product: p };
  });

  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const discount = Math.min(toShillings(input.discount_total ?? 0), subtotal);
  const total = subtotal - discount;
  const channel = input.channel === "online" ? "online" : "pos";
  const status: SaleStatus = input.status ?? (channel === "pos" ? "completed" : "pending");
  db.seq++;
  const ref = nextRef(db, channel);
  const received = toShillings(input.amount_received ?? (status === "completed" ? total : 0));

  const sale: Sale = {
    id: randomUUID(),
    ref,
    channel,
    tender: (input.tender as Sale["tender"]) ?? null,
    status,
    customer_name: input.customer_name ?? null,
    customer_phone: input.customer_phone ?? null,
    subtotal,
    discount_total: discount,
    total,
    amount_received: received,
    change_due: Math.max(0, received - total),
    note: input.note ?? null,
    cashier_id: actor?.id ?? null,
    cashier_name: actor?.name ?? null,
    lines: lines.map(({ _product, ...rest }) => rest),
    created_at: now(),
  };

  if (status === "completed") applyStock(db, lines, sale);
  db.sales.unshift(sale);
  return sale;
}

function applyStock(db: Db, lines: { product_id: string; qty: number; sku: string }[], sale: Sale) {
  for (const l of lines) {
    const p = db.products.find((x) => x.id === l.product_id)!;
    if (p.stock < l.qty) throw new Error(`Insufficient stock for ${p.title} (${p.stock} left, ${l.qty} requested).`);
    p.stock -= l.qty;
    p.updated_at = now();
    const reason = `${sale.channel === "pos" ? "Counter sale" : "Online order"} ${sale.ref}`;
    db.movements.unshift({
      id: randomUUID(),
      product_id: p.id,
      sku: p.sku,
      delta: -l.qty,
      reason,
      sale_id: sale.id,
      created_at: sale.created_at,
    });
    announce(p, reason);
  }
}

function reverseStock(db: Db, sale: Sale) {
  for (const l of sale.lines) {
    const p = db.products.find((x) => x.id === l.product_id);
    if (!p) continue;
    p.stock += l.qty;
    p.updated_at = now();
    const reason = `Stock returned from ${sale.ref}`;
    db.movements.unshift({
      id: randomUUID(),
      product_id: p.id,
      sku: p.sku,
      delta: l.qty,
      reason,
      sale_id: sale.id,
      created_at: now(),
    });
    announce(p, reason);
  }
}

function sign(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHash("sha256").update(`${body}.${SECRET}`).digest("base64url");
  return `${body}.${sig}`;
}

function verify<T>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = createHash("sha256").update(`${body}.${SECRET}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp: number };
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export const localStore: Store = {
  kind: "local",

  async listProducts(q = {}) {
    const db = load();
    return db.products.filter((p) => matches(p, q)).sort((a, b) => a.title.localeCompare(b.title));
  },

  async findProduct(key) {
    const db = load();
    const k = key.trim().toLowerCase();
    return db.products.find((p) => p.id === key || p.sku.toLowerCase() === k || p.barcode === k) ?? null;
  },

  async upsertProduct(input: ProductInput) {
    return tx((db) => {
      if (!input.title?.trim()) throw new Error("Product title is required.");
      const sku = (input.sku || `AD-${String(db.products.length + 1).padStart(3, "0")}`).trim().toUpperCase();
      const existing = input.id ? db.products.find((p) => p.id === input.id) : undefined;
      const dupSku = db.products.find((p) => p.sku.toUpperCase() === sku && p.id !== existing?.id);
      if (dupSku) throw new Error(`SKU ${sku} is already used by "${dupSku.title}".`);

      const record: Product = {
        id: existing?.id ?? `prd_${randomUUID().slice(0, 8)}`,
        sku,
        title: input.title.trim(),
        description: input.description ?? existing?.description ?? null,
        category: input.category || "Accessories",
        condition: (input.condition || "Good") as Product["condition"],
        size: input.size || "One size",
        image_url: input.image_url ?? existing?.image_url ?? null,
        cost_price: toShillings(input.cost_price),
        price: toShillings(input.price),
        stock: Math.max(0, Math.floor(input.stock ?? 0)),
        min_stock: Math.max(0, Math.floor(input.min_stock ?? existing?.min_stock ?? DEFAULT_MIN_STOCK)),
        barcode: (input.barcode || existing?.barcode || generateBarcode(sku)).trim(),
        discount_pct: Math.min(Math.max(input.discount_pct ?? existing?.discount_pct ?? 0, 0), 90),
        active: input.active ?? existing?.active ?? true,
        created_at: existing?.created_at ?? now(),
        updated_at: now(),
      };
      if (existing) Object.assign(existing, record);
      else db.products.push(record);
      announce(record, existing ? "Product updated" : "Product added");
      return record;
    });
  },

  async deleteProduct(id) {
    return tx((db) => {
      const i = db.products.findIndex((p) => p.id === id);
      if (i === -1) throw new Error("Product not found.");
      db.products.splice(i, 1);
    });
  },

  async adjustStock(id, delta, reason, saleId = null) {
    return tx((db) => {
      const p = db.products.find((x) => x.id === id);
      if (!p) throw new Error("Product not found.");
      const next = p.stock + delta;
      if (next < 0) throw new Error(`Cannot remove ${Math.abs(delta)} — only ${p.stock} in stock.`);
      p.stock = next;
      p.updated_at = now();
      db.movements.unshift({ id: randomUUID(), product_id: p.id, sku: p.sku, delta, reason, sale_id: saleId, created_at: now() });
      announce(p, reason);
      return p;
    });
  },

  async listSales(q: SaleQuery = {}) {
    const db = load();
    let rows = [...db.sales];
    if (q.channel) rows = rows.filter((s) => s.channel === q.channel);
    if (q.status) rows = rows.filter((s) => s.status === q.status);
    if (q.from) rows = rows.filter((s) => s.created_at >= q.from!);
    if (q.to) rows = rows.filter((s) => s.created_at <= q.to!);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return q.limit ? rows.slice(0, q.limit) : rows;
  },

  async createSale(input, actor) {
    return tx((db) => makeSale(db, input, actor));
  },

  async setSaleStatus(id, status) {
    return tx((db) => {
      const sale = db.sales.find((s) => s.id === id || s.ref === id);
      if (!sale) throw new Error("Sale not found.");
      const wasCompleted = sale.status === "completed";
      const nowCompleted = status === "completed";
      if (!wasCompleted && nowCompleted) applyStock(db, sale.lines, sale);
      if (wasCompleted && (status === "cancelled" || status === "refunded")) reverseStock(db, sale);
      sale.status = status;
      return sale;
    });
  },

  async listMovements(limit = 100) {
    const db = load();
    return db.movements.slice(0, limit);
  },

  async analytics(days = 30) {
    const db = load();
    return buildAnalytics(db.sales, db.products, days);
  },

  async signIn(email, password) {
    const db = load();
    const user = db.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user) return null;
    const a = Buffer.from(user.password_hash);
    const b = Buffer.from(hash(password));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const profile: Profile = { id: user.id, email: user.email, name: user.name, role: user.role };
    return { user: profile, token: sign({ sub: user.id, exp: Date.now() + 12 * 3600 * 1000 }) };
  },

  async getSession(token) {
    const payload = verify<{ sub: string }>(token);
    if (!payload) return null;
    const db = load();
    const user = db.users.find((u) => u.id === payload.sub);
    if (!user) return null;
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  },
};
