# Render PostgreSQL migrations

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
