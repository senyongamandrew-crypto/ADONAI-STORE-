# ADONAI STORE — Dual-Target Architecture (Web Storefront + Android Native POS)

A production-grade unified retail and e-commerce system for **Adonai Store** (Plot 45 Salama Road / Kibuli, Kampala, Uganda) built on a **Dual-Target Architecture**. The catalog supports **Brand-New Apparel** (factory-fresh, tagged, multi-quantity) and **Curated Pre-Loved / Vintage Garments** (hand-inspected, unique 1-of-1 pieces):

1. 🛍️ **Public Web Storefront (Render Deployment)**: Lightweight, mobile-responsive, customer-facing e-commerce application served at `/` on Render. Public storefront contains **zero POS/admin links or authentication triggers**.
2. 📱 **Android POS App (Native APK shell)**: Standalone cashier register and catalog intake terminal packaged into a real, signed Android APK (`com.adonaithrift.pos`).
3. 🌐 **Cross-Navigation (POS to Website Only)**: The Android POS app includes a **"🌐 Open Live Web Storefront ↗"** button that triggers an external Android intent to open the live Render site in the phone's default browser. The public website has no return mechanism to the POS app.
4. 🔒 **Real-Time Data Sync & Endpoint Security**: Atomically decrements database stock across both channels. Checkout stays PIN-free. Admins can optionally create area passwords in Store Settings; protected workspaces use server-validated, scoped database sessions. No environment-key setup is needed.

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│             Public Web Storefront (Render)             │
│   • Customer Catalog (GET /api/products)               │
│   • Website Checkout & Bag (POST /api/orders, web)     │
│   • 100% Customer-facing (No POS links)                │
└───────────────────────────┬────────────────────────────┘
                            │
                            │ (Atomic Stock Decr. / Read)
                            ▼
┌────────────────────────────────────────────────────────┐
│             Shared Backend REST API & DB               │
│   • PostgreSQL (Render) / SQLite Engine                │
│   • JWT / Staff Terminal Key Verification              │
│   • High-concurrency Connection Pool                   │
└───────────────────────────▲────────────────────────────┘
                            │
                            │ (JWT / X-Terminal-Key Auth)
┌───────────────────────────┴────────────────────────────┐
│             Android POS App (Native APK)               │
│   • Cashier Checkout Register & Barcode Scanning       │
│   • Cash & MTN / Airtel MoMo Tender Settlement         │
│   • Camera Catalog Intake & Photo Compression          │
│   • 80mm Thermal Receipt Printing                      │
│   • "Open Live Web Storefront" (External Intent)       │
└────────────────────────────────────────────────────────┘
```

---

## 1. Public Web Storefront (Render Deployment)

- **Entry Route**: `/`
- **Features**: Live dual-inventory catalog, Brand-New / Vintage filter chips, demographic and category filters, search by title/brand/barcode, responsive shopping bag drawer, web cart reservations, and direct POS fulfillment sync.
- **Payments at checkout**: **Card** and **mobile money** collected instantly by the gateway (the shopper approves the MoMo prompt on their own phone with their own PIN), **mobile money to the store merchant line**, **bank transfer**, and a **system-issued merchant pay code** (`ADN-XXXXXX`) — alongside **Pay on delivery/pickup** exactly as before. Confirming a collect-now order goes straight to a pay step showing the exact amount, the pay-to details or code, and a place to submit the transaction reference; reserved pieces are released automatically if the payment window lapses, and nothing is marked paid until the gateway verifies it or staff confirm the money landed. **Setup guide: [FLUTTERWAVE_PAYMENTS.md](FLUTTERWAVE_PAYMENTS.md).**
- **Privacy & Security**: All POS links, admin navigation, and staff login prompts have been completely stripped from the storefront.

---

## 1b. Product Detail Page (PDP)

Every piece gets a crawlable permalink at **`/product/<slug>`** (for example
`/product/indigo-type-iii-trucker-jacket-adn-men-1001`). Because thrift stock is
one-of-one, the page is built to answer the two questions that block a sale:
*will it fit me?* and *what is wrong with it?*

### Layout

| Breakpoint | Structure |
| --- | --- |
| `≥1024px` | Three-column asymmetric grid — **45%** sticky gallery with a vertical thumbnail strip, **30%** specifications and storytelling, **25%** sticky buy box (`position: sticky; top: 92px`). |
| `≤1023px` | Single column — edge-to-edge swipeable carousel with a dynamic photo/video counter, pricing, urgency badges, accordion specs, and a **fixed bottom action bar** with a single full-width `Add to Cart` (the one order path). A sold piece swaps in `Ask for something similar`. |

The body is never given `overflow: hidden` or a fixed height, so the whole
specification stack stays scrollable behind the mobile action bar. The only
scroll lock is `body.pdp-lightbox-open`, applied while the full-screen zoom is open.

### Thrift-specific components

- **Condition grades** — BNWT `#059669`, Grade A / Like New `#2563EB`,
  Grade B / Gentle Wear `#D97706`, Vintage / Collector `#7C3AED`.
- **Flat-lay measurements engine** — tops, jackets and dresses record shoulder,
  pit-to-pit, sleeve and total length; pants, jeans and skirts record waist, hip,
  inseam, rise, thigh and leg opening. Values are stored in inches and rendered
  in inches **or** centimetres via a toggle (the choice persists in
  `adonai-measure-unit`). Unknown keys are rendered too, so staff can log a cuff
  or strap drop without a migration.
- **Flaw disclosure** — `flaw_notes` always renders in a warning callout above the
  accordions, the matching accordion opens by default, and `flaw_photo_index`
  flags that thumbnail in amber with a ⚠️ tag that jumps to the close-up photo.
- **Single-unit inventory** — when stock reaches zero the gallery drops to 50%
  opacity with a high-visibility SOLD OUT stamp and every buy button is disabled;
  the only remaining action is an enquiry, "Ask for something similar".
- **One order path** — ordering happens through the cart: `POST /api/orders`
  (`channel: "web"`) writes the order and reserves the piece, and the order then
  appears in the POS for fulfilment and dispatch. The PDP deliberately has no
  way to "order" over WhatsApp, because a chat message has no order row, no
  inventory lock and no channel attribution.

### Localization (Kampala / Uganda)

- **WhatsApp, as a channel that is not ordering** — a sold piece offers to
  source something similar (`enquiryWhatsAppLink`), an unmeasured piece invites
  a measurement request, an empty gallery invites a photo request, and staff
  send the order confirmation + delivery updates from a real POS order. Staff
  can share a payment reference on WhatsApp too. Nothing here creates an order,
  and no control says "order" unless it goes through the cart.
- **Delivery estimator** — Central (Kampala · Wakiso · Entebbe · Mukono) same or
  next-day boda; up-country hubs (Mbarara, Jinja, Gulu, Arua, Masaka, Mbale) on
  24–48h bus/courier; and free self-pickup at the store counter. The choice
  persists in `adonai-delivery-zone` and is carried into the WhatsApp message.
- **Payment trust row** — MTN MoMo, Airtel Money, bank transfer and Cash on Delivery / Pickup.

### Performance & SEO

- `serve.py` server-renders `<title>`, description, canonical, Open Graph,
  Twitter and `Product` JSON-LD into `product.html`, and bootstraps the product
  JSON so the page paints without a second round trip. `/sitemap.xml` lists every
  in-stock permalink.
- Images ship as responsive WebP via `<picture>` with explicit `width`/`height`
  (no layout shift), `loading="lazy"` everywhere except the hero slide, which is
  `eager` + `fetchpriority="high"`.
- Derivatives are generated by `python3 scripts/optimize-product-images.py`,
  which writes `js/image-manifest.js`. Run it after adding photos to
  `assets/products/`; `--check` exits non-zero when the manifest is stale.

### Shared front-end modules

| File | Responsibility |
| --- | --- |
| `js/product-kit.js` | `window.AdonaiPDP` — grades, measurements, slugs, pricing, stock state, delivery zones, WhatsApp links and `<picture>` markup. Shared by the rail and the PDP so both agree. |
| `js/product.js` | PDP controller: gallery, lightbox, accordions, unit toggle, buy box, fixed action bar, related rail. |
| `css/product.css` | PDP design system (grade tokens, grid, carousel, action bar, sold-out state, reduced-motion). |

Staff capture the PDP fields in **Admin → Intake** (fabric, care, measurement set,
flaw notes and which photo shows the flaw) and can correct them later from the
catalog edit modal.

---

## 2. Android POS App (Native APK Setup)

### Quick Install (CI-built APK)
The installable APK is produced by the GitHub Actions `build-pos-apk` job and
is available as the `adonai-pos-v2-apk` workflow artifact (or in a tagged
release). A local build writes:
- `dist/adonai-pos-v2.apk`
- `android/app/build/outputs/apk/release/adonai-pos-release.apk`

Transfer the verified APK to any Android phone or tablet register, enable
**Install Unknown Apps**, and install. The repository no longer includes the
old invalid ZIP-with-an-`.apk`-extension artifact.

### Build APK from Source
The builder uses the Android Gradle Plugin; it does not rename a ZIP archive to `.apk`.
Install **JDK 17**, **Android SDK platform 34/build-tools**, and **Gradle 8.2+**, then run:

```bash
npm install
./build-apk.sh
# or
npm run build:apk
```

The command bundles the web assets, runs `:app:assembleRelease`, verifies the
manifest, DEX, compiled resources, and signature, then writes the installable
APK to `dist/adonai-pos-v2.apk`. The default CI/local artifact uses the Android
debug signing key so it can be installed immediately. For production releases,
pass `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS`, and
`RELEASE_KEY_PASSWORD` as Gradle properties.

### Open & Run in Android Studio
```bash
npm install
npm run bundle:pos
gradle -p android :app:assembleRelease
```

The native shell serves its bundled files through `WebViewAssetLoader`; the
POS API CORS allowlist includes that app origin so login, inventory intake, and
checkout can sync with the live backend.

---

## 3. Cross-Navigation (POS to Website Only)

- In the Android POS navigation drawer, tap **"🌐 Open Live Web Storefront ↗"**. The launcher is intentionally kept out of dashboard headers.
- This launches an external Android Intent (`Intent.ACTION_VIEW`) through the native WebView bridge, opening the live website in the phone's external browser (Chrome / Samsung Internet).
- The public website contains **no return link** to the POS app. Navigating back to the cashier terminal is done via Android's task manager / app switcher.

---

## 4. API & Data Synchronization (Live Stock & JWT Security)

| Channel | Endpoint | Method | Auth Required | Action |
| :--- | :--- | :--- | :--- | :--- |
| **Storefront** | `/api/products` | `GET` | Public | Reads live catalog & in-stock counts |
| **Storefront** | `/api/categories` | `GET` | Public | Standard category list |
| **Storefront** | `/api/orders` | `POST` (`channel="web"`) | Public | Atomically decrements stock & creates order |
| **POS App** | `/api/auth/terminal-session` | `POST` | Public in PIN-free mode | Automatically issues a signed admin JWT; issues no token when protection is enabled |
| **POS App** | `/api/auth/verify` | `POST` | Terminal Key / PIN (optional protected mode) | Returns signed JWT Bearer Token |
| **POS App** | `/api/orders` | `POST` (`channel="pos"`) | **None by default; assigned area password if protected** | Atomically decrements stock, settles tender, logs ledger |
| **POS App** | `/api/products` | `POST` | **None by default; assigned area password if protected** | Intakes new piece into shared database & inventory |
| **POS App** | `/api/sync/pull` | `POST`/`GET` | **None by default; assigned area password if protected** | Full operational state sync (sales, inventory, ledger) |
| **Storefront** | `/api/settings` | `GET` | Public, sanitized | Reads the current public store profile and delivery settings |
| **System Parameters** | `/api/settings` | `POST` | **None by default; Settings area password if protected** | Publishes configuration changes to the shared database |

### Live System Parameters

Saving **Store Settings → System Parameters** publishes the store name, contact
channels, social handles, address, opening hours, delivery scope, and base delivery
fee to the shared backend. Adonai owns the delivery workflow while authorized boda
riders and regional couriers support the last-mile route. The live storefront checks
for updated settings every 5 seconds and refreshes its footer, WhatsApp links, pickup
details, delivery fees, checkout messages, and browser title without requiring a
redeploy. Admin and Master Key values remain excluded from every public settings response.

### Render Environment Variables
Configure these in your Render Dashboard (**Environment** tab); never commit real secrets:
- `ADONAI_REQUIRE_STAFF_AUTH=0` (default: register, Admin Suite and settings open without a PIN or passkey)
- Optional area passwords are configured directly in **Store Settings**, not environment variables. Existing key variables do not turn the register lock back on.
- Legacy global staff-login mode only: set `ADONAI_REQUIRE_STAFF_AUTH=1`, then configure `STORE_MASTER_KEY=<long-unique-secret>` and/or `STAFF_TERMINAL_KEY=<long-unique-secret>`.
- `ADMIN_ACCESS_PIN` / `ADMIN_KEY` remain accepted as backward-compatible aliases for optional credential sign-in.
- `JWT_SECRET=<long-random-secret>`
- `DATABASE_URL=postgresql://...` (Render Managed PostgreSQL)

The master passkey is not embedded in the frontend or returned by public settings APIs.

---

## 4b. Financial Ledgers Hub & Strategy Workspace

The Admin → **Financial Ledgers** view is a six-workspace, audit-grade operations hub.

### Posting workspaces (reliable, validated data entry)
- **01 Daily Expense** — one tap posts a cash-out and its balanced double-entry journal atomically. Inline plain-language validation blocks empty categories, zero/negative amounts, future dates, and vendor-less cash-outs of UGX 500,000+ so the books stay meaningful for reporting and tax.
- **02 Bale Costs** — registers supplier bales with **multi-tier in-batch grading**: staff split the landed investment (acquisition + shipping) across named grade tiers by cost-weight percentages. The form blocks saving unless the weights total exactly 100%, previews each tier's calculated unit COGS live, and books the balanced double-entry journal in the same transaction. The API recomputes every tier's unit COGS server-side (largest-remainder budgets, reconciled to the shilling) — client-supplied COGS is never trusted. Legacy un-graded lots keep a single blended unit cost.

### Multi-tier lot grading → locked-COGS catalog tagging
Bales rarely contain one quality level, so pricing a mixed bale at one blended cost quietly misprices every piece. The grading flow fixes that end to end:

1. **Register** the lot in Bale Costs with tiers (e.g. *Tier 1 — Premium* 40% × 10 pcs, *Tier 2 — Standard* 40% × 30 pcs, *Tier 3 — Clearance* 20% × 20 pcs). Tier budgets must partition the landed investment exactly; per-piece rounding drift is folded into the highest-budget tier so selling every graded piece recovers the investment to the shilling.
2. **Tag** pieces in Intake (or the Android POS): picking the lot exposes a tier dropdown; the tier **locks the unit COGS** (read-only — manual edits are impossible and the server re-locks regardless) and pre-fills the retail price from the tier's target selling price. A graded lot refuses tagging without a tier, and both the tier and lot enforce per-tier piece capacity (`409` when a tier is fully tagged).
3. **Trace**: products persist `stock_lot_id` + `lot_grade_id`, so COGS on every sale is attributable back to the exact bale and tier.

Endpoints: `POST/GET /api/finance/stock-lots` (graded creation accepts a `grades[]` array; responses embed tier breakdowns with remaining counts) and `POST /api/products` with `lot_grade_id`. Schema: `migrations/20261008_multi_tier_lot_grading.sql` (also auto-applied on boot via SQLAlchemy `create_all` + the additive column migration). Tests: `python3 tests/test_multi_tier_grading.py`.
- **05 General Journal** — searchable/filterable double-entry ledger with running balances.

### Control workspaces
- **03 Executive** — per-day profitability: gross sales, COGS, margin, expenses, net operating income, and cash / MoMo / bank journal balances.
- **04 Dead Stock** — 30/60/90-day aging with live markdown publishing and accounting-balanced write-offs.

### 06 Strategy & Marketing (decision-ready intelligence)
`GET /api/finance/insights?days=7|30|90` (manager-only) compiles posted sales, ledgers, and catalog records into a plain-language growth report rendered in an interactive workspace:

- **KPIs** — revenue with period-over-period growth, net contribution, average order value, repeat-buyer rate, marketing ROI, and a **data-reliability score**.
- **Interactive sales pulse** — an SVG revenue + gross-profit trend chart with hover tooltips per day.
- **Channel strategy** — In-Store POS vs Web Storefront vs WhatsApp/Social share, so promotion budget follows the channel that answers with sales.
- **Merchandising** — category demand, share and margin; tapping a row filters the Inventory Rack for instant action.
- **Best sellers** — ranked products with margins for intake prioritisation.
- **CRM & campaigns** — identified/repeat customers, highest-value customer list with one-tap WhatsApp deep links, a downloadable customer-marketing CSV, and a pre-filled WhatsApp broadcast template generator.
- **Data reliability audit** — weighted 0–100% score across pricing, COGS, photos, branding, and customer-capture checks, each with a **Fix** shortcut to the screen that repairs it. Big decisions only get made on trustworthy data.
- **Auto-strategist** — rule-based, plain-language recommendations (engine categories, thin-margin repricing, basket-lift targets, marketing discipline bands, retention plays, dead-stock markdown value, stockout warnings).
- **One-click CSV export** of the entire report for meetings, spreadsheets, or investor updates.

Every request in the console is protected by a 30-second network timeout with a **Try again** action, so workspaces never hang on a silent connection.

### Dynamic Source B consignment
The Admin **Consignment Partners** workspace is Finance-protected. It supports partner profiles, region/source filters, item and payout history, sales-volume/turnover rankings, and idempotent partial or full payouts. New partner records default to a 5% store commission; an item can inherit the partner rate or save a custom 0–100% rate. Catalog intake remains Source A / store-owned by default. To list partner stock, create or open a partner and choose **Add consignment item**; that opens **Catalog Intake** with partner ownership enabled and the selected partner prefilled. The manual path is **Catalog Intake → Inventory source → Partner-supplied · consignment → Which partner supplied it?**. Source B pieces require an active partner, one available PRE-LOVED item, at least one photo, and a managed 15–20 second garment video.

The shared fashion taxonomy now covers apparel, outerwear and tailoring, shoes, boots and sandals, active/sportswear, underwear and sleepwear, bags and handbags, necklaces/chains, bracelets/bangles, rings/earrings, watches, eyewear/sunglasses, hats/scarves/belts, traditional/occasionwear, swim/beachwear and children's wear. Catalog Intake, the public storefront filters and the POS register all use the same expanded category list; existing product categories remain supported.

Partner sales use the same catalog, stock locks, storefront, and POS checkout as store-owned products. Sale-time order-item snapshots preserve the partner, rate, gross, store commission, and amount owed; the checkout transaction decrements stock and posts account 4200 (Store Commission Income) plus account 2100 (Consignment Payables), without store COGS. Unverified online checkouts sit in account 2110 until payment verification. Payouts debit partner payables and credit the selected cash, mobile-money, or bank account, with an immutable destination snapshot and unique idempotency key. Cancellation/expiry reversals and sale/payout history remain auditable.

Schema: `migrations/20261013_dynamic_consignment.sql` (run after the financial-ledger migration on PostgreSQL; the application also installs additive columns/tables on startup). Regression suite: `.venv/bin/python -m unittest discover -s tests -p test_consignment.py -v`.

---

## 4c. Optional admin-managed area passwords

The cashier register, barcode lookup, stock reservations and checkout stay open.
There are **no preset passwords and no mandatory POS login**. In **Store Settings
→ Passwords & protected areas**, the owner can optionally:

1. Set an **admin password** (8–128 characters) and confirm it. It protects
   password management and serves as a backup for every protected area.
2. Create **one password or a batch of up to 10**, each with a name and one or
   more assigned areas. Saving a password turns protection on for its areas.
3. Protect or unprotect individual areas with the area checkboxes:
   - **Finance & sales analytics** — ledgers, expenses, bale costs and analytics.
   - **Stock management & intake** — editing/deleting inventory and tagging stock.
   - **Orders, dispatch & audit** — history, fulfillment, dispatch and audit logs.
   - **Store settings** — profile, contact and fee changes.
4. Change, disable or delete area passwords. These actions revoke the affected
   unlock sessions immediately. Revoking a password does **not** silently open
   an area: the owner can still use the admin password, or turn protection off.
5. Use **Lock protected areas** to revoke this tab's sessions without signing
   out of the register. The owner can also explicitly remove all optional
   passwords and return the system to open access.

Passwords are salted PBKDF2 hashes in `pos_access_keys`, not environment
variables or plaintext browser settings. Successful unlocks last **30 minutes
per tab**, survive page navigation/reload, and use random database-backed
sessions in `pos_access_sessions`. Only session hashes are stored server-side;
`X-Pos-Access` carries the opaque tokens in headers, never URLs. This works
across server workers/restarts without relying on a JWT signing secret for area
passwords. `init_db()` creates the two tables automatically on deployment.

Protection is enforced by the API as well as navigation. Full-state sync and
notification feeds withhold data from locked areas, and unlocked private
records are not written into the shared browser cache. Wrong passwords show an
inline retry message; there is no environment-key prompt or dead end.

Unprotected areas remain open to anyone who can reach the terminal. Do initial
admin setup on a trusted device and keep the admin password safe. There is no
hardcoded recovery password. Existing store, stock and financial records are
preserved. The legacy `ADONAI_REQUIRE_STAFF_AUTH=1` global staff-login option is
still available for older deployments, but is **not** needed or enabled by this
Settings workflow.


### 4d. Operator notification bell

The bell on the cashier register and operations console shows the latest
**100 store activities**, including completed POS checkouts, online orders and
customer notes, payments/expiry, low stock, catalog intake/edit/removal,
fulfillment changes, rider roster/profile and availability changes, pairing-code
issuance/phone pairing or revocation, rider duty start/stop, delivery assignment
and rider-reported progress, expenses, stock lots, markdowns/write-offs and
published store settings. Click an entry to open its relevant workspace; rider
and delivery alerts open Dispatch. GPS fixes never generate per-point alerts.
Pairing-code alerts do not contain the code, and rider/dispatch event details
follow the protected Orders area.

- Each notification has a right-side **three-dot menu** to mark that item
  read/unread or remove it from this device. There are no selection checkboxes;
  removing a row locally does not erase the durable server history. **Mark all
  as read** remains available in the drawer header.
- The **unread badge** updates independently of navigation-tab counts. Opening
  the drawer or choosing **Mark all as read** marks the currently received
  event IDs as read. New events in the same second are still unread; read state
  survives navigation/reload in the same operator tab.
- History loads immediately and refreshes every **5 seconds** while the page is
  visible; a local successful store action also requests an immediate refresh.
  The drawer's **Refresh** button and connected/disconnected status make
  failures visible. Requests time out and reconnect automatically, including
  when a terminal returns online or to the foreground.
- `notification_events` stores alerts in the **same database transaction** as
  their actions. Failed/rolled-back actions never create success alerts.
  Workers/restarts share history, and startup idempotently recovers recent
  actual order/intake/expense creation records with their original timestamps.
  It does not invent demo activity or rewrite business records.
- When an optional area password is locked, the bell still shows a **safe
  activity summary**. Customer details, notes, amounts and private stock or
  configuration information remain protected. Unlocking updates the existing
  entry rather than duplicating it. Full payloads stay in browser memory only;
  the old shared notification cache is removed and relocking clears private
  drawer/toast content.
- Polling is the default transport: it requires **no extra environment key,
  external messaging service or long-running connection per terminal**. The
  compatible SSE endpoint uses database-backed, hashed, atomic one-use tickets
  and reads shared committed history. Area grants are revalidated on delivery.

After deploying the backend, refresh the browser. For installed Android POS
apps, rebuild/install the APK so the new bell client is included:
`npm run bundle:pos` then `npm run build:apk`.

Notification regressions (isolated test data):
```bash
npm run test:notifications
python3 -m unittest discover -s tests -p test_notifications.py -v
```

---

## 5. Automated CI/CD & GitHub Actions Workflow

The repository includes an automated GitHub Actions pipeline (`.github/workflows/build-pos-apk.yml`):
- **Continuous Integration**: Runs full backend security, database migration, and concurrency tests on push/pull requests.
- **Android APK Builder**: Automatically bundles POS assets and compiles `dist/adonai-pos-v2.apk`.
- **Artifact Downloads**: Uploads `adonai-pos-v2-apk` to GitHub Actions workflow run artifacts (available under the **Actions** tab on GitHub).
- **Release Automation**: Attaches the standalone APK binary automatically whenever a new version tag (`v*`) is pushed or triggered via `workflow_dispatch`.

---

## Testing & Verification

Run the comprehensive test suite verifying dual-target security, database auto-migrations, and high-concurrency atomic order deductions:

```bash
python3 test_render_postgres.py
```

The suite also covers the Product Detail Page contract: PDP fields surviving an
API round trip, slug/id/SKU/barcode resolution, server-rendered SEO markup on
`/product/<slug>`, sitemap permalinks, and a seed catalog that never advertises
`UGX 0`.

Verify the responsive image ladder is in sync with `assets/products/`:

```bash
python3 scripts/optimize-product-images.py --check
```


## Notification bell: system pop-ups, sound and bulk delete

- **Pop-ups on the computer / phone.** Open the bell → **Turn on pop-ups** (or the
  one-time "Get pop-ups for new orders?" invitation). New website orders, customer
  notes and other store changes then appear in the Windows / macOS notification
  centre — or the Android notification shade in the Adonai POS app — while the POS
  is minimised or in another window. Clicking a pop-up opens the matching
  workspace (Orders, Inventory…). The gear ⚙ in the bell adds "Also while I am
  using the POS window". `notification-sw.js` only shows pop-ups; it has no fetch
  handler and caches nothing. `js/notification-ticker.js` keeps the 5-second
  check on time while the window is minimised.
- **Sound.** One short notification "ding" per batch of new activity, with
  on/off, volume and **Test sound** under the gear (saved per device). Browsers
  allow page sound after one click on the page; pop-ups also use the computer's
  own notification sound.
- **Select several / delete permanently.** Press and hold a message (or
  right-click / Ctrl-click it) to show tick boxes, then **Select all**, **Mark
  read** or **Delete** → **Delete permanently**. The boxes disappear after the
  action. `POST /api/notifications/delete` (managers/admins) removes alerts for
  every device — orders, sales and stock are never touched; cashier keys only
  clear their own device. Alerts must stay visible while the POS / app is open
  or minimised; if the browser or Android fully closes it, alerts resume when it
  is reopened.

## Schema-driven Catalog Intake (category field schemas)

Catalog Intake builds its form from the selected **Category → Sub-group**. Each pair resolves one JSON schema in `category_field_schemas`, so staff only see the fields, units and photo angles that apply to that item. Earrings are measured in millimetres and grams and are never asked for inches, garment sizes or fabric. Metal rings have no fabric-texture question. Pre-loved shoes get tread, insole, heel-counter and toebox inspection points.

| Layer | What it holds |
| --- | --- |
| `data/category_field_schemas.json` | Canonical definitions: taxonomy (category → sub-group → schema), units, global baseline fields, option sets and 14 schemas (earrings; rings & bracelets; necklaces; tops; bottoms; dresses; scarves; footwear; bags; watches; eyewear; hats; belts; other accessories). Never served directly (`serve.py` blocks `data/`). |
| `category_field_schemas` table | Seeded from the JSON at startup. Rows marked `source = 'system'` refresh on deploy; set `source = 'custom'` to keep edits made in Supabase. |
| `GET /api/catalog/field-schemas` | Public endpoint. Returns the full document, or one resolved form with `?category=…&subcategory=…`. |
| `catalog_schemas.py` | Server engine. On every product create or update it validates `attributes`: drops hidden or unknown keys, enforces units and ranges, checks required fields and inspection points, and fills `fabric`, `size` and the inch flat-lay card from the structured values. |
| `js/catalog-schemas.js` (+ generated `js/catalog-schemas.data.js`) | Browser engine and renderer, working the same way as the Python engine (`tests/fixtures/catalog-schema-parity.json` is checked by both test suites). It uses the bundled copy offline and refreshes from the API when it can. |
| `products.attributes` (JSONB) | `{schema_key, schema_version, complete, values, inspection, photo_angles}`. Every value is stored with its unit, e.g. `{"value": 8, "unit": "mm"}`. Also exposed through the `catalog_items` view (see `migrations/README.md`). |

Required category details block a new intake, and the server checks them again. Photo angles are guidance only: the readiness strip shows `x / n required angles` and suggests the next shot. The edit modal follows two rules. A record saved complete must stay complete. An older record can be saved with gaps, and staff get a reminder; legacy inch measurements fill the new form automatically. Search tags are generated from brand, sub-group and tagged attributes (for example "nickel-free" or "lever-back"). Staff can edit them, and edits are never overwritten. The storefront and POS search both use these tags. The product page shows a grouped **Specifications** card, inspection results, captions for mapped photo angles and the item's pickup/delivery note. JSON-LD includes the specifications as `additionalProperty`.

After editing the JSON, run `npm run build:schemas` (`tests/catalog-schemas-engine.test.js` fails if the generated bundle drifts).

## Garment tags and phone-camera checkout

- **Catalog Intake → Save & Print Tag** saves the garment first and opens a
  print review using the returned catalog record's saved SKU, a supported
  barcode lookup alias. The physical tag contains only **business name,
  garment name, barcode/readable code and storefront website**. It does not
  print prices, size/color, condition, vintage / one-of-one claims, sample
  warnings or operational footers. Unsaved changes never become a printed tag.
  Legacy internal barcode IDs (including the vintage suffix) still scan.
- Reprint from **Recently Tagged Pieces**, **Print last saved tag**, or
  **Inventory Rack → Print tag**. Choose 1–100 copies. Use separate catalog
  entries / SKUs when garments have different sizes or prices; identical units
  of one catalog item can share its barcode and use the stock quantity.
- Paper options: **80 × 50 mm labels** (recommended), **62 × 40 mm compact
  labels**, **A4 80 × 50 mm cut-out tags**, and **A4 wide tags** for existing
  long codes. A readability check blocks labels whose barcode modules would
  be smaller than 0.25 mm. Print at **100% / Actual size**, without browser
  headers or footers; use a cardboard hangtag rather than adhesive on fabric.
- **Preview tag layout** shows the same clean physical design; the preview
  explanation stays outside the printed tag. Its reserved `ADN-000000` code
  never creates stock and is rejected at checkout (as is the legacy preview
  code `ADONAI-SAMPLE`). The garment name in this layout is "Cotton Shirt".
- The website comes from `website_url` / `app_url` in Store Settings, falling
  back to the live public storefront `www.adonaithrift-store.online` (printed
  without the `www.`).
  Localhost, native origins and temporary preview addresses are not printed.
- **POS Register → Scan Tag** requests the rear camera and adds one decoded
  garment through the same stock-reservation path as manual / USB scanning.
  Duplicate frames do not double-add. Scanning does not complete payment.
  The barcode is an identity, not an embedded price: lookup uses the current
  catalog price. Price changes do not require reprinting these price-free
  tags; catalog intake and sale receipts still retain their pricing.
- Camera decoding stays on the device. Chrome's native `BarcodeDetector` is
  used where it supports Code 128; otherwise the bundled, MIT-licensed
  `@zxing/browser` 0.1.5 decoder works without a CDN. **Scan a tag photo** and
  manual code entry are available if live-camera access is unavailable.
- Camera scanning requires HTTPS (localhost is allowed for development) and
  camera permission. If an embedded preview blocks the camera, open the
  register in a separate phone-browser tab. The server grants camera access
  only to its own origin; microphone access stays disabled.
- Printing opens the browser / Android **system print dialog**, including
  Save as PDF where supported. A working printer driver / Android print
  service is required. This does **not** claim universal direct Bluetooth
  thermal-printer support; that needs the exact printer model.
- The Android wrapper includes scoped WebView + runtime camera permission
  handling and an isolated, script-free native tag-print bridge. Rebuild the
  APK to install native changes. Optional stock-area passwords continue to
  protect intake / tag reprints; the register and camera checkout remain
  password-free.

Regression tests: `npm run test:garment-tools` (also included in `npm test`).
Vendored decoder provenance / licenses: `js/vendor/ZXING-LICENSE.txt`.


## Flexible garment photos and short video

- **Catalog Intake → Garment Photos & Video** accepts up to **12 photos**,
  selected together from a phone gallery / files. Four angles are suggestions,
  not a required minimum. Set the first/cover photo, reorder or remove views.
  Inventory editing uses the same gallery and preserves additional saved photos.
- Add **one optional video per garment**: aim for **20–30 seconds**, maximum
  **30 seconds / 50 MB**, from phone **MP4 / MOV** files. Trim a longer recording
  on the phone first. A missing video does not block existing photo-only stock.
  The server validates the file and converts it to broadly playable H.264/AAC
  MP4 (up to 1280px, fast-start, maximum 12 MB stored). GPS / input metadata
  is discarded. Photos are compressed to JPEG up to 1200px on the long edge.
- Upload status and errors are explicit; saves wait for uploads to complete.
  Flaw-photo selection follows the same photo when views are reordered and
  clears if that close-up is removed. **Save & Add Another** clears the draft
  gallery without deleting the saved garment's media.
- Customers swipe / use thumbnails through the full gallery and choose
  **Video** for standard play, seek and fullscreen controls. Clips do not
  autoplay or download from catalog cards. Photo zoom and flaw disclosure
  continue to use photo-only indices; catalog cards show video / extra-photo
  badges and only four small thumbnail previews.
- Uploaded bytes live in the additive **`product_media` SQL table**, not in
  catalog JSON / localStorage and not on Render's ephemeral disk. PostgreSQL
  backups must include this table. Product records contain small URLs and
  video metadata. Binary columns are deferred; video GET/HEAD supports byte
  ranges and caches immutable media IDs. Unattached drafts use staff/Stock
  access policy and expire after 24 hours (cleaned on the next upload).
  Attachment / replacement is atomic with the product save; a file cannot
  be attached to a second garment or deleted directly while still linked.
- **Photo references are host-independent.** A stored gallery entry is
  `/api/media/<id>` (and promo artwork `/api/promo-media/<id>`), never an
  absolute URL. The server rewrites any hosted form on the way in and out
  (`security.canonical_image_url`), a boot pass repairs rows written by older
  builds (`repair_product_media_urls`), and the POS gallery saves only the
  relative path even though it renders through `DB.apiUrl()`. This is what
  keeps cards loading when the storefront is served from the apex domain, a
  custom domain or a preview host: the page CSP is `img-src 'self'`, so an
  absolute URL naming another host renders as a broken image. Products with
  images from an external CDN (e.g. Unsplash) are left untouched and remain
  subject to the CSP allowlist in `serve.py`.
- Uploads and removal share the existing effective **Stock** authorization;
  published customer media needs no password. Register access, barcode tags,
  garment prices, transport allocation, reservations and payments are unchanged.
- Install `requirements.txt`: Pillow validates images, `imageio-ffmpeg` provides
  a bundled executable so Render does not depend on system FFmpeg. A maintained
  system build can be selected with `IMAGEIO_FFMPEG_EXE`. Video requests have a
  longer bounded timeout; the normal JSON body ceiling remains 5 MB.
- `npm run bundle:pos` updates web / Android assets. Android chooser source
  explicitly permits multi-selection for photo inputs; rebuild the APK to
  install native changes (browser phone uploads need no APK).

Checks: `npm run test:garment-media` (also in `npm test`),
`.venv/bin/python -m unittest discover -s tests -p test_product_media.py -v` and
`.venv/bin/python -m unittest discover -s tests -p test_media_urls.py -v`
(host-independent photo references).
All backend media tests write to isolated temporary databases, not store stock.

## Daily receipts, end-of-day printing and saved audit history

Open **Menu → Posting Audit Logs** (`/admin.html?view=customers`). The first view
is **Today's receipts**, not an all-dates list. **Tap any invoice once to open
printing directly**, or choose **Print day's invoices** for itemized copies of
the selected day's sales and **Print day summary** for receipt references,
payment-method subtotals, count and posted-sales total.

- **Whole business day:** receipt dates use Kampala time (EAT), from 00:00 up to
  the next midnight. This includes the 7 AM–midnight trading period without
  silently losing sales posted before 7 AM. Paid online orders use the saved
  payment/posting time, not merely their original order-creation time.
- **Daily separation, permanent saved history:** at Kampala midnight the Today
  view changes to the new day, even if the page stays open. Focus/resume and
  refresh recalculate Today/Yesterday/recent presets. No order, invoice, stock or
  ledger entry is deleted, moved, reset or reposted. A page reload starts on
  Today. Choose **Yesterday** or the **Receipt date** picker to reprint a past
  day's invoices; an explicit custom/historical date stays fixed across midnight.
- **Read-only copies:** individual and batch invoices use the saved sale's item
  names, quantities, unit prices, totals, customer, cashier, payment method and
  posting time, not today's catalog prices. Cancelling/reprinting a document
  cannot charge a customer or alter inventory. The receipt feed remains posted
  sales even when a different report type is selected for spreadsheet download.
- **Paper:** choose **A4 / Save as PDF** or **80 mm receipt roll**. Batch invoices
  print oldest-to-newest with a page break between invoices. The roll layout uses
  80 × 297 mm paged paper; exact roll/driver behaviour depends on the printer.
  The day summary uses A4. Search narrows the receipts being printed, and a
  filtered summary is clearly marked. At most 250 invoices / 1 MiB per print job;
  larger jobs ask for a smaller selection rather than silently dropping records.
- **Refresh and connection:** **Refresh receipts** pulls saved SQL history;
  background sync also updates the tray. Last-sync/offline/error messages make
  it clear when a printed summary may be incomplete. An unavailable server does
  not delete the last saved copy. Re-locking the owner's optional Orders scope
  clears a pending browser print document and cancels an active native receipt
  document where possible; already printed paper cannot be recalled.
- **System printing:** browser / Android print opens a printer chooser or Save
  as PDF; it does not claim completed physical printing or universal Bluetooth
  printer support. The isolated Android receipt bridge is separate from the
  garment-tag printer and disables scripts, local files/content and network
  loads. Existing APKs need a rebuild/install for this new bridge; older wrappers
  explain the browser/spreadsheet fallback rather than pretending to print.

### Local CSV / Excel files (also printable)

Below the receipt list, choose **Records to download** and **Receipt day / export
period**, then tap **Export CSV** or **Excel (.xlsx)**. These files remain saved
on your phone/computer. Open them in Excel, Sheets or another compatible
spreadsheet application and use that app's Print command.
The CSV button now prepares and downloads a file directly; it is not just a
category-menu toggle. Both buttons have a visible **Download again** link and
inline preparation/network/cancellation feedback.

- **Reports:** sales, orders & fulfillment, customer details, financial ledger,
  expenses, general journal, current stock inventory, and staff directory.
- **Dates:** today (default), yesterday, last 7/30 days, all dates, or custom
  inclusive from/to dates. Dates use **Africa/Kampala / EAT**, not the device's
  time zone. Sales use payment/posting date, orders/customers use order creation
  date, ledger/journal use posting date, and expenses use expense date.
  Search applies to the selected report; displayed/printed sales follow the same
  date and sales-search selection.
- **Real data:** the server queries saved SQL records, not stale browser caches,
  example rows or navigation-tab counts. Financial ledger is actual
  `LedgerEntry` data, with signed expenses/refunds/adjustments — not a copy of
  sales. Orders include unpaid/cancelled records and delivery details. Sales
  exclude cancelled/pending orders, include confirmed-paid online orders and
  completed POS checkouts (including existing POS rows whose legacy
  `payment_status` defaults to `unpaid`). The stored payment status is retained
  in exports rather than silently rewriting business records.
- **Customer details:** contacts captured from orders in the selected period,
  grouped by phone (or name + address), with counts and paid/recorded sales spend.
  This does not claim to include standalone contacts in an old local-only guest
  book. Stock shows **current** prices/quantities for garments intaken in the
  period; it is explicitly **not** an as-of-date inventory reconstruction.
- **File formats:** CSV is UTF-8 with a BOM and proper RFC quoting, suitable for
  Excel/Sheets and CSV readers. `.xlsx` is a genuine OOXML workbook generated by
  `openpyxl`, with column headers, filters, a frozen header row, numeric UGX
  amounts and literal text cells. Prefer `.xlsx` when phone-number formatting
  (including leading zeroes) is important. Neither format is a PDF.
- **Downloads:** desktop/phone browsers receive a real HTTP attachment with an
  accurate filename, MIME type and byte length. Browser feedback requests a
  download but does not pretend it knows the user's local file path or whether
  the browser has finished saving. Check the browser's Downloads or use the
  visible retry link. Empty reports are valid header-only files, clearly stated.
- **Android:** the updated native shell transfers bounded chunks into private
  staging, opens Android **Save As** (`ACTION_CREATE_DOCUMENT`), and writes the
  exact bytes to the user-chosen folder. Saved/cancelled/error callbacks are
  distinct; no broad external-storage permission or blob-navigation trick is
  used. Older installed wrappers open the HTTP attachment in the phone browser.
  Native source and bundled assets are updated; an installed APK needs a new
  build/install to obtain the Save As bridge. Physical-device SAF verification
  is still needed before calling a new APK release device-tested.
- **Permissions:** no global register PIN is introduced. Reports enforce the
  owner's optional Orders, Finance, Stock or administrator/password-management
  scope, plus the deployment's existing opt-in staff authentication. Staff
  exports omit PIN/password hashes, and order exports omit protected COGS.
  Formula-looking untrusted CSV text is neutralized; workbook cells cannot
  execute user-entered formulas.
- **Download lifecycle:** authenticated `POST /api/exports/prepare` returns a
  random 10-minute file capability at `/api/exports/download/<opaque-token>`.
  No staff password, JWT or area credential appears in the URL. SQL stores only
  the capability hash, deferred file bytes and original scope-session hashes,
  so downloads work across workers. `GET`/`HEAD` recheck expiry/current scope
  revocation, send `Content-Disposition: attachment`, `private, no-store` and
  `Referrer-Policy: no-referrer`; `HEAD` never loads the binary. The UI clears
  links and aborts preparation on re-lock. Old capabilities are pruned on export
  (at most 20 pending copies per staff identity). Reports over 100,000 rows or
  32 MB are rejected with a smaller-date-range message, never silently cut off.
  Oversized workbook text cells instruct the user to choose CSV instead.

Export regressions (throwaway fixtures only, never business data):

```bash
npm run test:audit-exports
npm run test:receipt-printing
.venv/bin/python -m unittest discover -s tests -p test_audit_exports.py -v
```

Verified: real Chromium download events and locally saved CSV/Excel files,
workbooks reopened for exact row/number/phone checks, actual signed ledger and
search, orders/customers, today/yesterday/all/custom/empty reports, EAT boundaries
on a Honolulu-time device, mobile downloads/retry and 320/390/768/1440 layouts.
Unit tests cover native byte-exact chunk transfer, Save As/cancel/retry/saved
feedback, late-response privacy, optional scopes, expiring links, formula safety,
attachment headers and HEAD payload deferral. No production deployment, APK
release or business-data seed is implied by these tests.

Daily-print verification also covers real Chromium receipt/summary PDF output:
A4, 80 mm, one invoice per batch page with no app chrome or blank extra page,
correct saved items/totals/posting times, full EAT boundaries independent of the
device time zone, past-day Excel files, browser refresh and open-page midnight
rollover without deleting SQL history. Native Java parsing, bounded trusted
bridge/lifecycle guards and mocked system-print callbacks are tested; Android
SDK compilation and physical phone/printer verification are not claimed.

## Installation-ready Android builds

The Android workflow compiles the updated native GPS/printing/export code and
packages current POS/rider screens. The phone user **downloads and installs the
APK**, not the source ZIP, and needs no build tools. Branch installation
candidates are labelled **Adonai Store Preview** (v2.5.0-preview, separate package
`com.adonaithrift.pos.preview`) so an existing POS and its unsynced local data are
not overwritten. Never uninstall the old app or clear its data to force an update.
Normal production builds retain `com.adonaithrift.pos` and need a stable original
signing key for in-place upgrades. APK metadata and SHA-256 checksums accompany
verified builds. Backend deployment is separate: the selected store HTTPS origin
must run this version for new server endpoints. Compile/signature verification
is not physical-phone screen-lock/GPS/printer verification. See
[Android installation setup](ANDROID_POS_SETUP.md) for steps and limits.

## Delivery Partners & Dispatch: private GPS locator and Android rider duty

**Menu → Delivery Partners & Dispatch** (`admin.html?view=dispatch`) now includes:

- A server-saved rider roster: contact, vehicle/plate, service zone, availability,
  active-job counts, editing and archival. Browser-only edits no longer vanish
  or overwrite shared SQL records after another terminal syncs.
- A real Leaflet locator using only reported GPS coordinates, with last-fix age,
  accuracy, paired-phone label, and **live / stale / waiting / paused / unpaired /
  simulated** states. A fix older than 90 seconds is not live. On network failure
  the last response is marked stale rather than generating movement. No rider
  or GPS fixture is inserted into store data. `Load street map` optionally loads
  attributed OpenStreetMap tiles; tiles reveal the viewed map area to that
  provider, not rider names/contacts. GPS markers/coordinates work without tiles.
- Prepared, paid delivery-order allocation directly from this panel. Choose a
  saved, non-offline partner; active workload and GPS status assist the decision.
  Assignment is manual, not a claimed automatic route optimiser. Unpaid, pickup,
  closed/cancelled or not-yet-prepared orders cannot be dispatched. Addresses are
  displayed as captured customer text; no invented route, travel time or ETA.
- Rider-only assigned jobs and saved delivery updates: **accept → collect →
  arrive → delivered**, plus problem notes. Delivered requires a recipient name,
  closes only that rider's active paid order and does not charge again, change
  stock or duplicate the sales ledger. Recipient confirmation is rider-reported,
  not independent identity/signature/photographic verification. Reassignment
  immediately removes the old rider's authority to update/access that job.
- Assignment/progress activity reaches the existing SQL notification bell and
  remains in delivery history. Archiving preserves historical rider/order
  records and refuses to strand active deliveries.

### Setup (Android screen-lock mode selected)

1. Keep checkout open. For GPS only, deliberately protect **Orders, dispatch &
   audit** using the existing optional owner-created passwords in Settings, or
   use an authenticated staff deployment (`ADONAI_REQUIRE_STAFF_AUTH=1`). GPS
   pairing/viewing is **not public** in the default PIN-free configuration. Staff
   still use their existing scoped unlock. No global register password is added.
2. Add an authorized delivery partner and tap **Pair phone**. Give its single-use
   10-minute code privately to that rider. A new pairing replaces/revokes the
   old device session. **No phone serial, IMEI, SIM identifier or contacts are
   required or read.** Device identity is an authorized install/session, not an
   assertion of tamper-proof hardware identity.
3. Build/install the updated Android APK. Open **Menu → Rider delivery app**
   (`rider.html`), enter the store HTTPS origin, a friendly phone label and code.
   Native app-private storage keeps the random 30-day session; the server stores
   only its hash. Tokens are not returned to JavaScript, URLs or staff sync.
   Pairing alone never starts GPS. A paired rider install reopens the rider page.
4. Rider taps **Start sharing**, approves the explicit native consent dialog,
   and permits Location + notifications. The native **location foreground
   service** is independent of the WebView and designed to continue on screen
   lock. An ongoing notification visibly says GPS sharing is active and has a
   **Stop sharing** action. Android's approximate permission is supported, with
   its actual accuracy shown. An inactive/blocked notification prevents starting.
5. Each explicit duty lasts at most **12 hours**. Stop in the rider app or its
   notification, or revoke the paired phone from dispatch. No boot receiver,
   automatic restart, silent tracking or `ACCESS_BACKGROUND_LOCATION` permission
   is used: the visible foreground service is started from an active rider screen.
   Force-stop/process kill, manufacturer battery controls, permission changes,
   GPS outages or mobile-data loss can interrupt updates; the panel labels age
   and accuracy honestly. A fresh fix is sent about every 20 seconds and the
   console refreshes about every 12 seconds, not claimed as zero-latency tracking.

### Privacy, transport and operational limits

- Only the **latest** GPS fix is saved, not a route trail. Latest points older
  than 24 hours are hidden and pruned on dispatch/rider API activity; dormant
  databases require a maintenance call/job for physical deletion at a strict
  wall-clock deadline. Delivery history contains text/status, not GPS routes.
- Location updates require a paired, unrevoked/unexpired rider session, current
  explicit duty and an active privacy policy. GPS latitude/longitude/accuracy,
  fix time, monotonic sequence and payload types are validated. Replay/older
  fixes cannot replace newer points. Device-reported mock GPS is visibly flagged;
  this is **not** anti-spoofing or a guarantee of exact physical location.
- Location feed is excluded from ordinary POS/full-state sync. Optional re-lock
  aborts pending map requests, clears markers/contacts/pair codes and rejects late
  responses. Native credentials are app-private with backups disabled; upload
  uses HTTPS, bounded/time-limited requests and never follows redirects with a
  session token. One latest point, not an unbounded offline route queue, retries.
- Staff GPS access and pairing are independently authorized; rider tokens give
  only their own assigned deliveries, duty control and location upload. A revoked
  device cannot retrieve customer contacts or change deliveries. Customer map
  links open only when the rider chooses them.
- The browser/old APK rider page clearly states that native background GPS needs
  a rebuilt/installed APK. It does not ask a browser for GPS or promise that
  JavaScript can continue reliably with a phone locked. No universal printer,
  mobile network or exact ETA guarantee is introduced.

Tests: `npm run test:dispatch` and
`.venv/bin/python -m unittest discover -s tests -p test_dispatch.py -v`.
Actual Chromium + throwaway SQL checks cover Leaflet positions, freshness/paused/
simulated labels, pairing/consent/GPS endpoints, roster persistence across reload,
assignment, only-own-deliveries, recipient delivery, revocation, and 320/390/768/
1440 layouts. The browser Android bridge is **simulated**, not an Android service.
Java parsing/static permission/lifecycle checks do not certify Gradle/SDK
compilation or physical phone tracking. Before an APK release, validate Location
and notification denial, screen lock for a full delivery, Stop action, airplane
mode/reconnect, session revocation, duty expiry and OEM battery restrictions on
real Android devices. Production deployment and APK installation are not implied.

## Device fit: words sized for the screen in hand

The register, the Admin Suite, the login gate and the rider app always render the
same words — but never at the same size, and never at a size the phone did not ask
for. Three fixes ship together in `css/adaptive-display.css` + `js/adaptive.js`:

- **Mobile font inflation is switched off.** Neither shell ever told the mobile
  browser to keep the authored font size, so iOS Safari inflated every text block
  when a phone was rotated to landscape and Android Chrome/WebView "font boosting"
  inflated text on pages wider than the screen. Words rendered up to ~1.5× larger
  than designed (most visibly in landscape, where the POS is normally used) while
  images, cards and controls kept their authored size — the layout looked stretched
  and "not fair" on a phone. `text-size-adjust: 100%` (with the `-webkit-` prefix)
  now disables that inflation for the whole staff shell.
- **Type scales with the SHORT side of the screen.** Type decisions used to be keyed
  to viewport width, so a phone held in landscape (780 × 360) is wider than the
  767px phone breakpoint and was served the *laptop* type scale: 30px register
  titles, 34px admin headings and 13.5px card names on a palm-sized screen. Every
  size is now a fluid `vmin` token (`--fs-hero`, `--fs-h1`, `--fs-stat`, `--fs-name`,
  `--fs-meta`, …), so portrait phones, landscape phones, tablets, laptops and
  desktops each get text proportional to the physical screen. `js/adaptive.js` also
  classifies the device from the short side (`data-device="phone"` for a landscape
  phone) and publishes `data-viewport`, so the compact layout is no longer skipped
  just because the phone is sideways.
- **Compact default, with a per-device setting.** The staff shells now start at
  **Compact** (`--ui-font-scale: 0.86`). **Compact / Standard / Large** lives in
  **Admin Suite → Store Settings → Display size**, not in the POS or Admin main
  menus. A saved selection is kept in `adonai.ui.display-size` for that device and
  applies to both cashier and Admin pages without rebuilding the APK.
  `?display=compact|standard|large` previews a density for one load without saving,
  and `?fit=off` renders the shell exactly as it looked *before* this layer existed —
  the before/after switch used by the preview harness and by support calls.

Component rules are scoped to the staff shells (`.pos-app`, `#shell`, `.suite-gate`,
the shared modal host), so the public storefront, the rider app's own layout and the
print sheets keep their own typography. Receipts, garment tags and A4 invoices are
printed from self-contained documents with fixed physical measurements and are
deliberately **not** affected by the on-screen density. Text fields keep a 16px floor
on touch widths even in Compact — that is what stops mobile browsers from
auto-zooming a focused field — and the native shell keeps `setTextZoom(100)`, so a
phone's system font-size setting cannot stretch the terminal UI.

**Verify it on the real thing.** Open `/device-preview.html` (served by `serve.py`)
to see the POS and the Admin Suite rendered side by side in true 360 × 740 phone,
780 × 360 landscape-phone, 834 × 1112 tablet and 1280 × 800 laptop viewports, and
switch the density from the page. Unlock the POS/Admin once in a normal tab first —
a fresh profile shows the login gate inside the frames. `npm run test:adaptive-display`
covers the CSS invariants (font inflation off, every token `vmin` + `--ui-font-scale`,
no rule leaking outside the shells), the short-side device classification and the
persisted control. Embedding the harness requires `frame-src 'self'`, and viewing the
app inside any sandboxed preview needs `ALLOW_FRAME_EMBED=1` (`X-Frame-Options` and
`frame-ancestors` stay locked in production). What these changes cannot do is resize
Android's own system UI, another app's screen, or the printed receipt.
