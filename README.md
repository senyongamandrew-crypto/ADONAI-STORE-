# ADONAI THRIFT STORE — Dual-Interface Retail Platform

A unified, multi-tier system for **Adonai Thrift Store** (Kampala) — a public storefront, a protected cashier POS, and an operations dashboard, all powered by one real-time shared database engine.

## Interfaces & routes

| Route | Interface | Who |
| --- | --- | --- |
| `/` | 🛍️ **Storefront** — public catalog, live stock badges, WhatsApp checkout | everyone |
| `/pos` | 🧾 **Cashier terminal** — barcode scanning, tender settlement, thermal receipts | staff |
| `/admin` | 📊 **OPS dashboard** — sales, inventory, payments, staff & access | owner/admin |
| `/login` | 🔐 **Staff PIN screen** | staff |

## Run it

```bash
python3 serve.py        # serves everything on http://localhost:8080
```

Zero dependencies, zero build step.

---

## 🔓 Access model — OPEN MODE right now

Per the owner's directive, **no passkeys are configured**: the system ships in **open access mode** (`staff: []`, `access_locked: false`), so `/pos` and `/admin` are freely reachable while you trial it.

When you're ready to publish:

1. Open **`/admin` → Staff & Access**
2. Add each cashier/admin with a name, role and 4–8 digit **PIN**
3. Flip the **staff lock ON**

From that moment `/pos` and `/admin` require a PIN at `/login` (cashiers always land on the terminal; admins can reach the dashboard). The public storefront stays open to everyone. "Log Out / Exit POS" revokes the session and returns to the storefront.

## Architecture

```
┌────────────┐   ┌─────────┐   ┌──────────────┐
│ Storefront │   │   POS   │   │ OPS Dashboard │
│     /      │   │  /pos   │   │    /admin     │
└─────┬──────┘   └────┬────┘   └───────┬───────┘
      └───────────────┼────────────────┘
                      ▼
              js/db.js  — single source of truth
        (products · sales · staff · settings)
   localStorage + BroadcastChannel (real-time, cross-tab)
   + Web Locks for atomic, race-safe stock deductions
```

Every sale — whether scanned at the counter (`process_pos_sale`) or placed via the storefront's WhatsApp checkout (`createWebOrder`) — hits the same tables. Stock changes broadcast instantly: a counter sale flips the storefront badge to **SOLD** in every open tab without a refresh.

> **Going to production?** `js/db.js` is a clean adapter boundary — reimplement the same `DB.*` API against Supabase (tables + Realtime + Auth) and all three UIs work unchanged.

### Key guarantees

- **Atomic inventory deductions** — `DB.processPosSale()` checks *all* cart lines against stock under a cross-tab Web Lock, then decrements. Any failure = nothing is written. Unique thrift pieces can't be double-sold.
- **Real-time sync** — BroadcastChannel + storage events keep storefront, POS and admin consistent across tabs/devices on the same browser profile.
- **Unified product schema** — `barcode_id` (Code 128 string), `in_stock_count`, `cost_price`, `selling_price` (UGX), size and condition for thrift items.

## Cashier terminal (`/pos`)

- **Global hardware scanner listener** — invisible `keydown` capture; USB/Bluetooth scanners burst-type the code + Enter and the item lands in the cart, a beep + flash confirms. Manual barcode input also supported.
- **Manual lookup grid** — category tabs (Jackets, Shirts, Shoes, Dresses, Trousers, Accessories) + live search for un-tagged items.
- **Live cart register** — line items, stock-bounded quantity steppers, running subtotal.
- **Tender settlement**:
  - 💵 **Cash** — quick-amount chips + change calculator (`tendered − total = change to return`)
  - 📱 **MTN MoMo / Airtel Money** — sender name/phone, transaction reference, mandatory *"payment received & verified"* confirmation, logged per sale
- **Thermal receipts** — 80 mm print stylesheet; auto-triggers the browser print dialog on every completed sale; reprint from the last-sale button.

## Storefront (`/`)

- Live stock badges (**In stock / Sold**) driven by real-time DB events
- Category tabs + search, one-of-one thrift details (size, condition)
- Cart drawer → **WhatsApp checkout**: reserves stock atomically, creates a `WEB-…` order in the shared DB, then opens `wa.me` with the full order payload for payment confirmation
- Discreet **Staff / POS Login** gateway in the header (and footer)

## OPS dashboard (`/admin`)

- **Overview** — revenue today, AOV, pending web orders, sold-out pieces; 14-day revenue chart stacked by channel; POS-vs-Web split
- **Sales** — unified ledger of counter sales + WhatsApp orders; confirm payment for pending web orders or cancel them (stock is automatically returned to the shelf)
- **Inventory** — unified product creation (auto-generated scannable barcode, live on POS + storefront the instant it's added), cost vs selling margin, stock tools
- **Payments** — collection KPIs; complete tender log (cash with change, MoMo refs with verifying cashier)
- **Customers** — lifetime value for WhatsApp customers plus walk-in totals
- **Staff & Access** — create PIN accounts, enable the staff lock

## Configuration

Store metadata (name, address, **WhatsApp number**) lives in `js/db.js → seedState().settings.whatsapp` and can be updated in the browser console via `DB.updateSettings({ whatsapp: "2567XXXXXXXX" })`. To reseed demo data: `DB.resetToSeed()`.

## Product photography

Seeds ship with placeholder images (locked to each product). Staff replace them with the **real item photo** during intake — either in the POS terminal (**📥 Intake** → Edit · photo → 📁 Upload from Gallery / Files) or the admin product editor. Photos from local files or device gallery are compressed to a compact JPEG and saved into the shared DB, so the storefront, POS tiles and dashboard update **live, with no refresh**. Products without a photo gracefully fall back to a clean category icon.
