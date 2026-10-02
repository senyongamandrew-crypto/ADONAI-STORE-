# Render PostgreSQL migrations

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
