# ADONAI STORE — Dual-Target Architecture (Web Storefront + Android Native POS)

A production-grade unified retail and e-commerce system for **Adonai Store** (Plot 45 Salama Road / Kibuli, Kampala, Uganda) built on a **Dual-Target Architecture**. The catalog supports **Brand-New Apparel** (factory-fresh, tagged, multi-quantity) and **Curated Pre-Loved / Vintage Garments** (hand-inspected, unique 1-of-1 pieces):

1. 🛍️ **Public Web Storefront (Render Deployment)**: Lightweight, mobile-responsive, customer-facing e-commerce application served at `/` on Render. Public storefront contains **zero POS/admin links or authentication triggers**.
2. 📱 **Android POS App (Native APK shell)**: Standalone cashier register and catalog intake terminal packaged into a real, signed Android APK (`com.adonaithrift.pos`).
3. 🌐 **Cross-Navigation (POS to Website Only)**: The Android POS app includes a **"🌐 Open Live Web Storefront ↗"** button that triggers an external Android intent to open the live Render site in the phone's default browser. The public website has no return mechanism to the POS app.
4. 🔒 **Real-Time Data Sync & Endpoint Security**: Atomically decrements database stock across both channels. POS backend endpoints are secured via JWT and Staff Terminal Keys (`STAFF_TERMINAL_KEY` / `ADMIN_ACCESS_PIN`).

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
| `≤1023px` | Single column — edge-to-edge swipeable carousel with a `1 / 4` counter, pricing, urgency badges, accordion specs, and a **fixed bottom action bar** (`Add to Cart` secondary, `Order via WhatsApp` primary). |

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
  the WhatsApp CTA switches to "Ask for something similar".

### Localization (Kampala / Uganda)

- **WhatsApp ordering** — `https://wa.me/{settings.whatsapp}?text=…` pre-filled
  with item, SKU, UGX price (`toLocaleString()`), condition, size, the selected
  delivery zone and the canonical product URL.
- **Delivery estimator** — Central (Kampala · Wakiso · Entebbe · Mukono) same or
  next-day boda; up-country hubs (Mbarara, Jinja, Gulu, Arua, Masaka, Mbale) on
  24–48h bus/courier; and free self-pickup at the store counter. The choice
  persists in `adonai-delivery-zone` and is carried into the WhatsApp message.
- **Payment trust row** — MTN MoMo, Airtel Money and Cash on Delivery / Pickup.

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
| **POS App** | `/api/auth/verify` | `POST` | Terminal Key / PIN | Returns signed JWT Bearer Token |
| **POS App** | `/api/orders` | `POST` (`channel="pos"`) | **JWT / Terminal Key** | Atomically decrements stock, settles tender, logs ledger |
| **POS App** | `/api/products` | `POST` | **JWT / Terminal Key** | Intakes new piece into shared database & inventory |
| **POS App** | `/api/sync/pull` | `POST`/`GET` | **JWT / Terminal Key** | Full operational state sync (sales, inventory, ledger) |
| **Storefront** | `/api/settings` | `GET` | Public, sanitized | Reads the current public store profile and delivery settings |
| **System Parameters** | `/api/settings` | `POST` | **Admin JWT / Master Key** | Publishes configuration changes to the shared database |

### Live System Parameters

Saving **Store Settings → System Parameters** publishes the store name, contact
channels, social handles, address, opening hours, delivery scope, and base delivery
fee to the shared backend. Adonai owns the delivery workflow while authorized boda
riders and regional couriers support the last-mile route. The live storefront checks
for updated settings every 5 seconds and refreshes its footer, WhatsApp links, pickup
details, delivery fees, checkout messages, and browser title without requiring a
redeploy. Admin and Master Key values remain excluded from every public settings response.

### Render Environment Variables
Configure in your Render Dashboard (**Environment** tab):
- `STAFF_TERMINAL_KEY=ADONAI-POS-2026` (Authorizes POS Cashier Register terminals)
- `ADMIN_ACCESS_PIN=246810` (Authorizes Store Admin & full operations console)
- `JWT_SECRET=your-secure-signing-secret`
- `DATABASE_URL=postgresql://...` (Render Managed PostgreSQL)

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
