# ADONAI THRIFT STORE — Dual-Target Architecture (Web Storefront + Android Native POS)

A production-grade retail and e-commerce system for **Adonai Thrift Store** (Plot 45 Salama Road / Kibuli, Kampala, Uganda) built on a **Dual-Target Architecture**:

1. 🛍️ **Public Web Storefront (Render Deployment)**: Lightweight, mobile-responsive, customer-facing e-commerce application served at `/` on Render. Public storefront contains **zero POS/admin links or authentication triggers**.
2. 📱 **Android POS App (Native APK / Capacitor)**: Standalone cashier register and catalog intake terminal packaged into an installable Android APK (`com.adonai.store.pos`).
3. 🌐 **Cross-Navigation (POS to Website Only)**: The Android POS app includes a **"🌐 Open Live Web Storefront ↗"** button that triggers an external Android intent to open the live Render site in the phone's default browser. The public website has no return mechanism to the POS app.
4. 🔒 **Real-Time Data Sync & Endpoint Security**: Atomically decrements database stock across both channels. POS backend endpoints are secured via JWT and Staff Terminal Keys (`STAFF_TERMINAL_KEY` / `ADMIN_ACCESS_PIN`).

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│             Public Web Storefront (Render)             │
│   • Customer Catalog (GET /api/products)               │
│   • WhatsApp Checkout & Bag (POST /api/orders, web)    │
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
- **Features**: Live rail inventory, demographic and category filters, search by title/brand/barcode, responsive shopping bag drawer, WhatsApp 1-of-1 order reservation, and order tracking.
- **Privacy & Security**: All POS links, admin navigation, and staff login prompts have been completely stripped from the storefront.

---

## 2. Android POS App (Native APK Setup)

### Quick Install (Pre-built APK)
The installable Android APK is available at:
- `dist/adonai-pos-v2.apk`
- `android/app/build/outputs/apk/release/adonai-pos-release.apk`

Transfer `dist/adonai-pos-v2.apk` to any Android phone or tablet register, enable **Install Unknown Apps**, and install.

### Build APK from Source
```bash
./build-apk.sh
# or
npm run build:apk
```

### Open & Run in Android Studio (Capacitor)
```bash
npm install
npm run bundle:pos
npx cap open android
```

---

## 3. Cross-Navigation (POS to Website Only)

- In the Android POS topbar and sidebar, tap **"🌐 Open Live Web Storefront ↗"**.
- This launches an external Android Intent (`Intent.ACTION_VIEW` or Capacitor `Browser.open`), opening the live website in the phone's external browser (Chrome / Samsung Internet).
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
