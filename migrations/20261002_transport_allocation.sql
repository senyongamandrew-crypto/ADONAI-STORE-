-- Adonai Store: 50/50 disguised transport allocation (Render PostgreSQL)
-- Idempotent, additive migration. Run with:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261002_transport_allocation.sql
BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_transport_cost NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Preserve the live catalog's current selling price as its base price. New rows
-- are calculated by the API and the generated columns below.
UPDATE products SET base_price = selling_price WHERE base_price = 0 AND selling_price > 0;

ALTER TABLE products ADD COLUMN IF NOT EXISTS embedded_transport_portion NUMERIC(14,2)
  GENERATED ALWAYS AS (total_transport_cost * 0.50) STORED;
ALTER TABLE products ADD COLUMN IF NOT EXISTS checkout_transport_portion NUMERIC(14,2)
  GENERATED ALWAYS AS (total_transport_cost * 0.50) STORED;
ALTER TABLE products ADD COLUMN IF NOT EXISTS final_selling_price NUMERIC(14,2)
  GENERATED ALWAYS AS (base_price + (total_transport_cost * 0.50)) STORED;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_products_transport_nonnegative
    CHECK (base_price >= 0 AND total_transport_cost >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_products_final_selling_price ON products(final_selling_price);
CREATE INDEX IF NOT EXISTS ix_products_checkout_transport ON products(checkout_transport_portion);
COMMIT;
