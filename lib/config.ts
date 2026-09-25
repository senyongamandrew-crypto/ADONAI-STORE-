/**
 * Single place to edit store identity + money rules.
 * Everything downstream (showroom, POS, receipts, WhatsApp messages) reads from here.
 */
export const STORE = {
  name: "ADONAI THRIFT",
  tagline: "Pre-loved fashion · Kampala",
  /** E.164, digits only — used by the WhatsApp order orchestrator. */
  whatsapp: "+2567XXXXXXXX",
  address: "Ntinda, Kampala, Uganda",
  phone: "+256 7XX XXX XXX",
  hours: "Mon–Sat 9:00–19:00",
} as const;

export const CURRENCY = {
  code: "UGX",
  symbol: "UGX",
  /** UGX has no minor units in practice — prices are whole shillings. */
  decimals: 0,
  /** Cashiers round change down to the nearest 50 UGX note at settlement. */
  cashRounding: 50,
} as const;

export const CATEGORIES = [
  "All",
  "Dresses",
  "Tops & Blouses",
  "Jeans & Denim",
  "Shirts",
  "Trousers",
  "Skirts",
  "Jackets & Coats",
  "Shoes",
  "Bags",
  "Kids",
  "Accessories",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CONDITIONS = ["New with tags", "Like new", "Good", "Fair"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "One size", "UK 6", "UK 8", "UK 10", "UK 12", "UK 14", "36", "37", "38", "39", "40", "41", "42"] as const;

export const TENDERS = ["Cash", "MTN MoMo", "Airtel Money", "Bank"] as const;
export type Tender = (typeof TENDERS)[number];

export const CHANNELS = ["pos", "online"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Default reorder threshold; per-product `min_stock` overrides it. */
export const DEFAULT_MIN_STOCK = 3;

export const ROLES = {
  ADMIN: "admin",
  MANAGER: "manager",
  CASHIER: "cashier",
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Route → minimum role required (RBAC map, enforced server-side). */
export const ROUTE_GUARDS: Record<string, Role[]> = {
  "/admin": [ROLES.ADMIN, ROLES.MANAGER],
  "/admin/inventory": [ROLES.ADMIN, ROLES.MANAGER],
  "/admin/sales": [ROLES.ADMIN, ROLES.MANAGER],
  "/admin/labels": [ROLES.ADMIN, ROLES.MANAGER],
  "/pos": [ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER],
};

/** Demo credentials seeded by the local driver (see scripts/seed-local.mjs). */
export const DEMO_USERS = [
  { email: "admin@adonai.ug", password: "adonai-admin", role: ROLES.ADMIN, name: "Andrew Senyonga" },
  { email: "manager@adonai.ug", password: "adonai-manager", role: ROLES.MANAGER, name: "Grace Nabirye" },
  { email: "cashier@adonai.ug", password: "adonai-cashier", role: ROLES.CASHIER, name: "Ivan Kato" },
] as const;
