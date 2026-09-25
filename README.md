# ADONAI THRIFT — unified dual-channel retail platform

One system, two sales channels, **one inventory**. A public digital showroom that dispatches
orders over WhatsApp, and a hardware-accelerated cashier POS that settles in-store — both
reading and writing the same stock table, with a back office for pricing, labels and analytics.

Built for a Kampala thrift shop: prices in **UGX** (whole shillings, no decimals), tenders are
Cash / MTN MoMo / Airtel Money / Bank, and every receipt prints on a thermal printer or goes
straight to the customer's WhatsApp.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

No accounts, no keys, no database server required. With no Supabase env vars present the app
runs on the **local file driver** (`.data/adonai.json`), which seeds 24 demo products and about
three weeks of mixed POS/online sales so the dashboard has something to show.

**Demo sign-ins** (local driver only — one click on `/login`):

| Role | Email | Password | Lands on |
| --- | --- | --- | --- |
| Admin | `admin@adonai.ug` | `adonai-admin` | `/admin` |
| Manager | `manager@adonai.ug` | `adonai-manager` | `/admin` |
| Cashier | `cashier@adonai.ug` | `adonai-cashier` | `/pos` |

Reset the demo data any time: `npm run db:reset-local`.

### Switching to Supabase (Postgres + Auth)

```bash
cp .env.example .env.local      # fill in the three values
```

```sql
-- Supabase SQL editor, in this order:
\i supabase/schema.sql          -- tables, indexes, RPCs, RLS
\i supabase/seed.sql            -- staff accounts, catalog, 3 weeks of demo sales
```

Restart `npm run dev`. `GET /api/health` reports `"mode": "supabase"` and every read/write now
goes to Postgres. The application code does not change — only the driver behind `lib/db` does.

---

## Verification

Two suites, both runnable here:

```bash
npm run dev          # terminal 1
npm run verify       # terminal 2 — 41 end-to-end checks over HTTP
npm run verify:sql   # 24 checks against a real ephemeral Postgres
npm run typecheck && npm run build
```

`npm run verify` (`scripts/verify.mjs`) drives the real routes: catalog reads, RBAC rejection of
anonymous POS/analytics/write calls, a POS settlement (totals + change), the atomic stock
decrement, the oversell guard, the online-order lifecycle (pending → approve decrements → refund
restocks), inventory CRUD with duplicate-SKU rejection, the analytics report, SVG barcode
rendering, and page rendering for each role.

`npm run verify:sql` (`scripts/verify-sql.mjs`) boots a throwaway Postgres via
`embedded-postgres` (`npm i -D embedded-postgres` — deliberately not a runtime dependency),
applies `supabase/schema.sql` and `supabase/seed.sql` verbatim, then exercises
`finalize_sale()`, `set_sale_status()`, `adjust_stock()`, the UNIQUE ref constraint, the
CHECK-based stock floor and the RLS policies for both `anon` and `authenticated`.

---

## Architecture

```
Browser ─┬─ Showroom (public)      ──┐
         ├─ POS terminal (cashier)   ├──► Next.js API routes ──► lib/db (Store interface)
         └─ Back office (manager)  ──┘         │                        ├─ supabaseStore → Postgres + RLS + RPC
                                               │                        └─ localStore    → .data/adonai.json
                                     RBAC (lib/auth.ts)
```

**Separation of concerns.** Nothing in `app/` or `components/` touches a database. Every page
and route talks to the `Store` interface in `lib/db/store.ts`; `lib/db/index.ts` picks the
driver from the environment. Money maths lives in `lib/money.ts` and `lib/margin.ts`, barcode
rendering in `lib/barcode.ts`, the WhatsApp encoder in `lib/whatsapp.ts`, and the analytics
aggregation in `lib/db/analytics.ts` — a pure function over `(sales, products)` so both drivers
produce identical reports.

**Where the write happens.** Stock only moves inside one atomic operation: `POST /api/sales`
for a counter sale, or approving a pending online order. In Postgres that is the
`finalize_sale()` / `set_sale_status()` RPCs (guarded by `stock >= qty` plus a `CHECK (stock >= 0)`
constraint); in the local driver it is a serialised transaction with the same guard.

### Directory map

```
app/
  page.tsx                  public showroom (server-rendered catalog)
  pos/page.tsx              cashier terminal
  login/page.tsx            staff sign-in
  admin/
    page.tsx                BI dashboard
    inventory/page.tsx      inventory data grid + editor
    sales/page.tsx          sales & orders ledger
    labels/page.tsx         barcode / QR label sheet
  api/
    products/               GET (public) · POST/PATCH/DELETE (manager+)
    sales/                  GET (staff) · POST (cashier+, or anonymous online)
    sales/[id]/             PATCH status — approve / cancel / refund
    stock/                  POST manual adjustment
    analytics/              GET (manager+)
    barcode/                GET SVG (Code 128 / QR)
    auth/{login,logout,me}  session cookie lifecycle
    health/                 driver + row counts
components/                 UI, including admin/ charts, grids and label sheet
lib/
  config.ts                 store identity, currency, categories, RBAC map
  db/                       Store interface, drivers, analytics, seed data
  supabase/                 env, clients, Postgres driver
  auth.ts                   cookie session + role guards
  money.ts margin.ts        UGX arithmetic, change, markups, net margin
  barcode.ts                Code 128 / QR / EAN-13 generation
  whatsapp.ts               order message encoder + wa.me deep links
  useBarcodeScanner.ts      scanner keystroke listener
  cart.ts                   persisted web cart + in-memory POS ledger
supabase/
  schema.sql                tables, indexes, RPCs, triggers, RLS
  seed.sql                  staff, catalog, demo sales
scripts/
  verify.mjs verify-sql.mjs reset-local.mjs
```

---

## Feature notes

**Showroom.** Sticky header with instant search (title/SKU/size/condition), category chips with
live counts, sort, in-stock filter, fluid 2→5 column grid, flyout cart drawer with quantity
controls, and a cart badge showing units and running subtotal. The grid re-reads
`GET /api/products` every 15 s, so an item the counter just sold out badges itself here within
seconds. Items whose stock hits zero stay listed but are disabled and greyed.

**WhatsApp order orchestrator.** `lib/whatsapp.ts` encodes the cart — line items, quantities,
unit prices, running total, customer details and note — into a structured message and opens
`wa.me/<store number>`. Set the real number in `lib/config.ts` (`STORE.whatsapp`). No live
payment gateway is wired: online orders are confirmed by the shop and settled by Mobile Money
or cash on collection, then logged from the sales ledger.

**POS terminal.** A view switcher flips between **counter mode** and a customer-facing
**catalogue mode**. A global keystroke listener catches USB/Bluetooth scanner bursts (payload
arriving within 60 ms and ending in Enter), matches against barcode → SKU → title, and rejects
unknown or out-of-stock codes with an inline message; a manual barcode field covers handhelds
and cameras. The left panel holds category tabs and touch tiles; the right panel is the live
ledger with quantity controls, per-line totals, discounts, four tenders, quick-cash buttons,
change calculation and one-tap settlement that prints or WhatsApps the receipt.

**Inventory engine.** One product table for both channels. Inline edits for cost, retail,
discount and stock (blur to save), ± stock buttons that write audit movements, a full editor
modal with a margin calculator that suggests a retail price for a target margin, duplicate-SKU
rejection, low-stock flags against a per-product reorder point, and Code 128 / QR label sheets
generated server-side for printing.

**Back office.** RBAC keeps pricing, stock edits and financial reports to admin/manager;
cashiers get the terminal only — enforced in the layout *and* re-checked in every API route.
The dashboard shows today's gross revenue, window revenue, average order value, realised
margin, a 14-day revenue chart, channel split, top categories, best sellers, inventory
valuation at cost and retail, low-stock queue, and pending online orders awaiting approval.

---

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key (browser-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** — used by the API routes |
| `LOCAL_AUTH_SECRET` | signing salt for the local driver's session cookie |

All three Supabase values must be set to leave the local driver. Money is always stored as an
integer count of shillings; `lib/config.ts` holds the store name, WhatsApp number, address,
categories, sizes, conditions, tenders and the route→role guard map.
