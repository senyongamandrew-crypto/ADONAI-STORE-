# Render PostgreSQL migrations

## Direct-upload supplier catalog intake — 2026-10-25

Run `20261025_direct_supplier_upload.sql` after the dynamic category schemas migration. It adds `supplier_name`, `fixed_unit_cost NUMERIC(12,2) CHECK (>= 0)` and `base_retail_price NUMERIC(12,2) CHECK (>= 0)` to `products` (the physical relation behind the `catalog_items` view — deployments that carry `catalog_items` as a real table get the literal `ALTER TABLE catalog_items` statements), exposes the three columns on the `catalog_items` view alongside intake-vocabulary aliases (`item_name`, `catalog_group`, `size_availability`, `condition_notes`), and installs an `INSTEAD OF INSERT` trigger so the Python ingestion service (`supplier_ingestion.py`) can insert piece-by-piece supplier uploads straight into `catalog_items` via Supabase/PostgREST. `db_init.py` also adds the columns automatically at startup. Full guide: [DIRECT_SUPPLIER_UPLOAD.md](../DIRECT_SUPPLIER_UPLOAD.md).

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261025_direct_supplier_upload.sql
```

Example query — supplier direct-upload margin report:

```sql
SELECT supplier_name,
       COUNT(*)                                   AS pieces,
       SUM(fixed_unit_cost)                       AS cost_outlay,
       SUM(base_retail_price - fixed_unit_cost)   AS projected_margin
FROM catalog_items
GROUP BY supplier_name;
```

## Dynamic category field schemas — 2026-10-18

Run `20261018_dynamic_category_schemas.sql` after the consignment migration. It adds `products.subcategory`, `products.attributes` (JSONB object, GIN-indexed with `jsonb_path_ops`), `products.search_tags_json` and `products.fulfillment_notes`; creates `category_field_schemas` (one JSON intake form per item family — earrings, rings & bracelets, necklaces, tops, scarves, footwear, bags…); and installs the read-only `catalog_items` view that exposes products in intake vocabulary (`title`, `lot_id`, `cogs_unit_cost`, `suggested_retail_price`, `attributes`…).

Run `20261018_notification_permanent_delete.sql` any time after that. It adds `notification_events.deleted_at` / `deleted_by` so the bell inbox can delete alerts permanently for every device (managers/admins only). Deleted rows remain as tombstones so the startup history backfill cannot recreate them; orders, sales and stock are not touched. The app also adds these columns automatically at startup.

The application seeds `category_field_schemas` from `data/category_field_schemas.json` at startup and serves it at `GET /api/catalog/field-schemas` (optionally `?category=…&subcategory=…`). Rows with `source = 'system'` are refreshed on deploy; set `source = 'custom'` on a row edited directly in Supabase so it is never overwritten. Every product save re-validates `attributes` server-side against the resolved schema — hidden fields are dropped, units are enforced (no inches on earrings), and required details block intake.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261018_dynamic_category_schemas.sql
```

Example query — nickel-free earrings in stock:

```sql
SELECT title, sku, attribute_values
FROM catalog_items
WHERE stock_quantity > 0
  AND attributes @> '{"schema_key": "earrings", "values": {"nickel_free": true}}';
```

## Multi-tier lot grading — 2026-10-08

Run `20261008_multi_tier_lot_grading.sql` after the financial ledger migration. It creates `financial_lot_grades` (per-lot grade tiers with cost-weight percentages and locked per-piece unit COGS) and links `products.lot_grade_id` so catalog tagging attributes every bale piece to its tier. The API recomputes tier COGS server-side at lot registration, requires tier weights to total exactly 100%, and refuses tagging a graded lot without picking a tier — client-supplied COGS is never trusted.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261008_multi_tier_lot_grading.sql
```

## Dual inventory architecture — 2026-10-03

Run `20261003_dual_inventory.sql` after the financial and transport migrations. It creates the native `item_condition_enum` and `quantity_type_enum` values (`BRAND_NEW` and `PRE_LOVED`), adds variant/specification fields, snapshots the policy on order items, and installs database enforcement plus `pg_notify('adonai_inventory', ...)` triggers. `PRE_LOVED` rows are constrained to quantity 1 (or 0 after sale); `BRAND_NEW` rows support multi-quantity stock. The API and browser/POS polling layer consume the same authoritative stock and expiring cart/POS reservations.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261003_dual_inventory.sql
```

## 50/50 transport allocation — 2026-10-02

Run `20261002_transport_allocation.sql` on Render after deploying this version. It adds generated PostgreSQL columns for the embedded and checkout portions and preserves existing catalog prices as `base_price`. Inventory entry and order checkout also recalculate these values server-side, so client-supplied delivery fees are not trusted.

## Financial Ledgers hub — 2026-10-01

The application keeps the existing `DATABASE_URL` behavior unchanged. At startup, `db_init.py` uses SQLAlchemy `create_all()` for new tables and an idempotent additive column migration for existing tables.

For an explicit Render database migration, run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261001_financial_ledger_hub.sql
```

The migration is safe to rerun. It uses only `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ADD COLUMN IF NOT EXISTS`; it does not drop, rename, truncate, or overwrite an existing table.

After deployment, optional read-only verification is available with:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261001_financial_ledger_verify.sql
```

The journal-balance query in the verification script should return no rows.
