# Direct-Upload Supplier Catalog — Architecture & Integration Guide

Adonai Thrift Store ingests supplier stock through a **direct-upload model**.
Partners (for example **Finds Ug**) supply pre-photographed jackets,
windbreakers and streetwear that are ingested **piece-by-piece**. Each item
record is tagged directly with its source supplier identifier, assigned a
**fixed unit cost**, and mapped to a **base retail selling price** upon
creation.

This deliberately bypasses the complex machinery built for bale lots:

| Bale-lot workflow (unchanged) | Direct-upload workflow |
| --- | --- |
| Multi-tier landed-cost weight distributions | No lot, no tiers — a fixed unit cost per piece |
| Batch-level invoice allocations | No batch invoice — each garment stands alone |
| Lot registration → grade tier → catalog tagging | One form (or one API call) per item |

Lot-based intake, tier grading and consignment remain fully supported —
direct uploads simply add a third, lighter intake path.

---

## 1. System Architecture & Direct-Upload Workflow

```
┌──────────────────────────────────────────────────────────────────┐
│                 Direct-Upload Suppliers (e.g. Finds Ug)          │
│        Pre-photographed pieces · fixed unit cost · retail tag     │
└──────────────┬───────────────────────────────┬───────────────────┘
               │                               │
               │ Python 3 ingestion service    │ Admin dashboard /
               │ (supplier_ingestion.py)       │ POS intake form
               │ supabase-py → PostgREST       │ (same payload fields)
               ▼                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              Supabase PostgreSQL — catalog_items relation         │
│   supplier_name · fixed_unit_cost · base_retail_price (per item)  │
│   INSTEAD OF INSERT trigger maps direct uploads onto products     │
└──────────────┬───────────────────────────────┬───────────────────┘
               │  instant propagation (shared PostgreSQL state)     │
       ┌───────┴───────────┐           ┌───────┴───────────────┐
       ▼                   ▼           ▼                       ▼
┌──────────────┐  ┌────────────────┐  ┌────────────────────────────┐
│ Web storefront│  │ Admin suite    │  │ Android Capacitor POS app  │
│ (Render)      │  │ (Catalog       │  │ (register + intake camera) │
│ live catalog  │  │  Intake)       │  │ synchronized in real time  │
└──────────────┘  └────────────────┘  └────────────────────────────┘
```

Workflow, end to end:

1. **Receive** a pre-photographed piece from the supplier (photo URLs ready).
2. **Validate & sanitize** the item attributes
   (`SupplierCatalogIngestionService.sanitize_item_payload`) — names are
   required, financial figures may never be negative.
3. **Insert** into `catalog_items` (`ingest_single_item`). The relation's
   INSTEAD OF INSERT trigger stores the row in `products`, synthesizing the
   fields a direct upload never carries (identity codes, quantity policy,
   whole-UGX pricing projections).
4. **Propagate** — every channel reads the same PostgreSQL state, so the
   storefront, admin dashboard and mobile POS display the new piece
   immediately. No batch sync step exists.

---

## 2. Supabase Database Schema

Migration: [`migrations/20261025_direct_supplier_upload.sql`](migrations/20261025_direct_supplier_upload.sql)
(run with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261025_direct_supplier_upload.sql`
after `20261018_dynamic_category_schemas.sql`).

It implements the required `catalog_items` columns:

```sql
ALTER TABLE catalog_items
ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),

ADD COLUMN IF NOT EXISTS fixed_unit_cost NUMERIC(12, 2) CHECK (fixed_unit_cost >= 0),

ADD COLUMN IF NOT EXISTS base_retail_price NUMERIC(12, 2) CHECK (base_retail_price >= 0);
```

On Adonai deployments `catalog_items` is the intake-vocabulary **view** over
the physical `products` table, so the migration adds the three columns to
`products`, exposes them on the view (plus `item_name`, `catalog_group`,
`size_availability`, `condition_notes` intake aliases), and — for databases
that carry `catalog_items` as a real table — applies the `ALTER TABLE`
statements to that table as well. The same columns are installed
automatically at application boot by `db_init.py`, so fresh and legacy
databases converge.

| Column | Type | Meaning |
| --- | --- | --- |
| `supplier_name` | `VARCHAR(255)` | Source supplier identifier tag (e.g. `Finds Ug`) |
| `fixed_unit_cost` | `NUMERIC(12, 2) CHECK (>= 0)` | Unit acquisition cost fixed at intake |
| `base_retail_price` | `NUMERIC(12, 2) CHECK (>= 0)` | Base retail selling price mapped at creation |

Useful queries against the relation:

```sql
-- Everything supplied by Finds Ug that is still on the rack
SELECT title, sku, fixed_unit_cost, base_retail_price, stock_quantity
FROM catalog_items
WHERE supplier_name = 'Finds Ug' AND stock_quantity > 0;

-- Direct-upload margin report
SELECT supplier_name,
       COUNT(*)                          AS pieces,
       SUM(fixed_unit_cost)              AS cost_outlay,
       SUM(base_retail_price)            AS retail_value,
       SUM(base_retail_price - fixed_unit_cost) AS projected_margin
FROM catalog_items
GROUP BY supplier_name
ORDER BY retail_value DESC;
```

---

## 3. Python 3 Backend Ingestion Service

Module: [`supplier_ingestion.py`](supplier_ingestion.py).
Requires the `supabase` package (`pip install supabase`, listed in
`requirements.txt`) and two environment variables:

```sh
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_KEY=your-service-role-key     # server-side only, never in Git
```

```python
from supplier_ingestion import SupplierCatalogIngestionService

service = SupplierCatalogIngestionService(SUPABASE_URL, SUPABASE_KEY)

payload = service.sanitize_item_payload(
    item_name="Adidas Red & White Full-Zip Windbreaker",
    supplier_name="Finds Ug",
    catalog_group="Outerwear",
    subcategory="Full-Zip Hooded Windbreaker",
    fixed_unit_cost=45000.00,
    base_retail_price=85000.00,
    size_availability="Medium / Large",
    color="Red / White",
    image_url="https://storage.googleapis.com/adonai-assets/adidas-windbreaker.jpg",
    condition_notes="Excellent vintage condition, inspected and approved.",
)

result = service.ingest_single_item(payload)
# {'status': 'success', 'data': [...]}  or  {'status': 'error', 'message': '...'}
```

Run the bundled example with `python3 supplier_ingestion.py`.

Validation performed by `sanitize_item_payload` (mirrored by the SQL trigger):

* `item_name` and `supplier_name` are required →
  `ValueError("Item name and supplier name are required fields.")`
* `fixed_unit_cost` / `base_retail_price` are parsed with `Decimal`
  precision and may not be negative →
  `ValueError("Financial figures cannot be negative.")`
* all text fields are trimmed; `condition_notes` defaults to
  `"Premium Grade 1"`.

`ingest_single_item` never raises — database failures come back as
`{"status": "error", "message": ...}` so cron/CLI callers can log and retry.

### One deliberate wire-format detail

The payload carries `created_at` as a real **ISO-8601 UTC timestamp** (or
omits it and lets the database stamp the row). The SQL keyword `NOW()` is not
a valid JSON value for a timestamp column — PostgreSQL rejects the string
`"NOW()"` before a trigger could see it. `sanitize_item_payload` therefore
accepts `None` and the `NOW()` / `CURRENT_TIMESTAMP` sentinels and resolves
them to an ISO-8601 timestamp.

### Payload contract

Every intake surface transmits exactly these fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `item_name` | string | ✅ | Garment title |
| `supplier_name` | string | ✅ | Source supplier identifier |
| `catalog_group` | string | | e.g. `Outerwear` |
| `subcategory` | string | | e.g. `Full-Zip Hooded Windbreaker` |
| `fixed_unit_cost` | number | | ≥ 0, two decimals (UGX) |
| `base_retail_price` | number | | ≥ 0, two decimals (UGX) |
| `size_availability` | string | | e.g. `Medium / Large` |
| `color` | string | | e.g. `Red / White` |
| `image_url` | string | | Primary photo URL |
| `condition_notes` | string | | Defaults to `Premium Grade 1` |
| `created_at` | ISO-8601 timestamp | | Optional — DB stamps rows that omit it |

---

## 4. Frontend & Omnichannel Integration Guidelines

**Form data handling.** The admin dashboard (Catalog Intake and the edit
modal) and the Android Capacitor POS application transmit form fields
adhering strictly to the payload structure above. In the intake form:

* **Source supplier** → `supplier_name`
* **Weighted landed unit COGS** → `fixed_unit_cost` (also feeds the legacy
  `cost_price` integer so ledgers and reports stay consistent)
* **Target retail selling price** → `base_retail_price` (also feeds
  `base_price` / `selling_price`)

`js/intake.js` (`Intake.readProductForm`) emits the same keys for any shared
product form, including the intake-vocabulary aliases (`item_name`,
`catalog_group`, `size_availability`, `condition_notes`) alongside the
canonical `name`, `category`, `size`, `condition` fields.

**REST API.** `POST /api/products` and `PUT/PATCH /api/products/<id>` accept
the direct-upload fields and the intake-vocabulary aliases, so third-party
scripts may post either naming scheme. Money figures are validated server-side
with `Decimal` precision (`parse_money_amount`) and rejected when negative.
A direct upload with only `base_retail_price` set prices exactly at that
retail value (no transport allocation is added — same rule as consignment).

**Instant propagation.** Database writes executed via the Python scripts,
the intake forms, or API routes land in the same PostgreSQL state. The Next.js
web storefront, admin dashboard, and mobile POS terminal poll/subscribe to
that state and display synchronized inventory in real time for customer
engagement and order fulfillment across Uganda.

**Channel checklist**

| Surface | Reads | Writes |
| --- | --- | --- |
| Web storefront | `GET /api/products` | Orders only (never catalog) |
| Admin dashboard | `GET /api/products`, detail views | `POST/PUT /api/products` with the payload fields |
| Android POS | product polling / reservations | Intake form → `POST /api/products` |
| Python service | — | `INSERT` into `catalog_items` (Supabase) |
| Reports / Supabase Studio | `catalog_items` view | — |

---

## 5. Operations Runbook

1. Apply the migration on the Supabase project (safe to rerun):

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261025_direct_supplier_upload.sql
   ```

2. Install the ingestion dependency wherever the scripts run:
   `pip install -r requirements.txt`.
3. Set `SUPABASE_URL` and `SUPABASE_KEY` (service-role) in the script
   environment — see `.env.example`.
4. Ingest pieces with `supplier_ingestion.py` or the admin/POS intake forms.
5. Verify with the margin query above, or watch a fresh row appear in the
   storefront immediately after insert.

---

## 6. Test Coverage

```sh
python3 tests/test_supplier_ingestion.py     # service validation & insert contract
python3 tests/test_direct_supplier_upload.py # API end-to-end (form → catalog → channels)
```
