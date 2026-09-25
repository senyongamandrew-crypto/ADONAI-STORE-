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
npm run verify       # terminal 2 — 52 end-to-end checks over HTTP
npm run verify:sql   # 24 checks against a real ephemeral Postgres
npm run typecheck && npm run build
```

`npm run verify` (`scripts/verify.mjs`) drives the real routes: catalog reads, RBAC rejection of
anonymous POS/analytics/write calls, a POS settlement (totals + change), the atomic stock
decrement, absurd-quantity and oversell rejection, **six simultaneous buys against three units
(exactly three win, stock lands on zero, refs stay distinct)**, the online-order lifecycle
(pending → approve decrements → refund restocks), anonymous-order validation and rate limiting,
inventory CRUD with duplicate-SKU rejection, the analytics report, SVG barcode rendering, and
page rendering for each role. Runs are independent — each presents its own client IP, so a
repeat run does not inherit the previous run's rate-limit bucket.

`npm run verify:driver` (`scripts/verify-driver.mjs`) is the check that stands in for the one
thing this environment cannot do — run the Supabase driver against a live Supabase project. It
applies `schema.sql` to the same ephemeral Postgres, then asserts against the live catalog that
every table, column, RPC, RPC argument and `finalize_sale` payload key the driver names actually
exists. A renamed column or a typo'd RPC fails here instead of in production. It is deliberately
self-checking: it fails if its own parser extracts nothing, and it was mutation-tested — renaming
`change_due` in the driver, renaming a column in the schema, and adding an unread payload key each
turn it red.

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

**Closing the online loop.** The cart drawer's *reserve* option posts the same basket to
`POST /api/sales` as a **pending** order alongside the WhatsApp message, so the shop can see it
on the till and approve it — and staff can log a phone/WhatsApp order from the sales ledger with
the same *Log order* form. Pending orders never move stock; approving them runs the identical
decrement path as a counter sale.

**Back office.** RBAC keeps pricing, stock edits and financial reports to admin/manager;
cashiers get the terminal only — enforced in the layout *and* re-checked in every API route.
The dashboard shows today's gross revenue, window revenue, average order value, realised
margin, a 14-day revenue chart, channel split, **tender mix (cash in the drawer vs MTN MoMo vs
Airtel Money vs Bank, for end-of-day reconciliation)**, top categories, best sellers, inventory
valuation at cost and retail, low-stock queue, and pending online orders awaiting approval.

---

## Guarantees, and where they stop

- **No oversell, verified.** Concurrent settlements are serialised: in Postgres by the
  `stock >= qty` guard plus `CHECK (stock >= 0)` inside one transaction, in the local driver by a
  promise-chain transaction. The suite fires six parallel buys at a three-unit product and
  asserts exactly three succeed.
- **Single process.** The local driver's serialisation, the in-memory order rate limiter and the
  session cookie are all per-process. Correct for `next dev` and a single `next start`; if you
  scale horizontally, move to the Supabase driver and put a shared store behind
  `lib/ratelimit.ts`.
- **Rate limiting is a speed bump.** `x-forwarded-for` is trustworthy behind a proxy and
  spoofable if this app is ever exposed directly.
- **No live payment gateway** by design: online orders are confirmed by the shop and settled by
  Mobile Money or cash, then logged. `lib/whatsapp.ts` and `POST /api/sales` are the two seams
  where a gateway would slot in.
- **Stock mirroring is polling** (15 s showroom, 20 s POS), not Supabase Realtime — swap the
  interval for a `postgres_changes` subscription in `components/Showroom.tsx` if you want pushes.

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
