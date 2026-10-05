-- Adonai Store: unified dual-inventory architecture
-- Date: 2026-10-03
--
-- Safe, additive PostgreSQL migration for Brand-New Apparel and Curated
-- Pre-Loved / Vintage Garments. Run with:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261003_dual_inventory.sql

BEGIN;

DO $$ BEGIN
  CREATE TYPE item_condition_enum AS ENUM ('BRAND_NEW', 'PRE_LOVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quantity_type_enum AS ENUM ('BRAND_NEW', 'PRE_LOVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS item_condition item_condition_enum NOT NULL DEFAULT 'PRE_LOVED',
  ADD COLUMN IF NOT EXISTS quantity_type quantity_type_enum NOT NULL DEFAULT 'PRE_LOVED',
  ADD COLUMN IF NOT EXISTS size_variants_json TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS color_variants_json TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS factory_tag_notes TEXT,
  ADD COLUMN IF NOT EXISTS inner_packaging VARCHAR(30),
  ADD COLUMN IF NOT EXISTS measurements_json TEXT NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS fabric_grading_notes TEXT;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS item_condition VARCHAR(20) NOT NULL DEFAULT 'PRE_LOVED',
  ADD COLUMN IF NOT EXISTS quantity_type VARCHAR(20) NOT NULL DEFAULT 'PRE_LOVED';

-- Preserve the legacy catalog as the curated stream. Operators can classify
-- future rows explicitly through POS Intake. New API intake defaults to
-- BRAND_NEW when the caller does not send the new discriminator.
UPDATE products
SET item_condition = CASE
  WHEN lower(coalesce(condition, '')) LIKE '%brand%new%'
    OR lower(coalesce(condition, '')) LIKE '%factory%'
  THEN 'BRAND_NEW'::item_condition_enum
  ELSE 'PRE_LOVED'::item_condition_enum
END
WHERE item_condition = 'PRE_LOVED'::item_condition_enum;

UPDATE products SET quantity_type = item_condition;
UPDATE order_items oi
SET item_condition = p.item_condition::text,
    quantity_type = p.quantity_type::text
FROM products p
WHERE p.id = oi.product_id;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_products_quantity_type_matches_condition
    CHECK (quantity_type::text = item_condition::text) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_products_dual_inventory_quantity
    CHECK (
      (item_condition = 'PRE_LOVED' AND in_stock_count IN (0, 1))
      OR (item_condition = 'BRAND_NEW' AND in_stock_count >= 0)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_products_item_condition ON products(item_condition);
CREATE INDEX IF NOT EXISTS ix_products_quantity_type ON products(quantity_type);
CREATE INDEX IF NOT EXISTS ix_order_items_item_condition ON order_items(item_condition);

-- A durable event trail supports Supabase Realtime consumers and gives the
-- Android POS a replayable audit source when a device reconnects.
CREATE TABLE IF NOT EXISTS inventory_events (
  id BIGSERIAL PRIMARY KEY,
  product_id VARCHAR(50) NOT NULL,
  item_condition item_condition_enum NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  quantity_remaining INTEGER NOT NULL CHECK (quantity_remaining >= 0),
  quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  source VARCHAR(30) NOT NULL DEFAULT 'DATABASE',
  occurred_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_inventory_events_product_time
  ON inventory_events(product_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION adonai_enforce_dual_inventory_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.item_condition = 'PRE_LOVED'::item_condition_enum
     AND NEW.in_stock_count NOT IN (0, 1) THEN
    RAISE EXCEPTION 'PRE_LOVED products must have quantity 1 or 0 after sale';
  END IF;
  NEW.quantity_type := CASE
    WHEN NEW.item_condition = 'BRAND_NEW'::item_condition_enum
    THEN 'BRAND_NEW'::quantity_type_enum
    ELSE 'PRE_LOVED'::quantity_type_enum
  END;
  IF NEW.inventory_status NOT IN ('ARCHIVED', 'WRITTEN_OFF') THEN
    NEW.inventory_status := CASE WHEN NEW.in_stock_count > 0 THEN 'AVAILABLE' ELSE 'OUT_OF_STOCK' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_dual_inventory_policy ON products;
CREATE TRIGGER trg_products_dual_inventory_policy
BEFORE INSERT OR UPDATE OF item_condition, quantity_type, in_stock_count, inventory_status
ON products
FOR EACH ROW EXECUTE FUNCTION adonai_enforce_dual_inventory_policy();

CREATE OR REPLACE FUNCTION adonai_inventory_change_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reserved_count INTEGER := 0;
  condition_value item_condition_enum;
  remaining_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'pos_inventory_locks' THEN
    SELECT coalesce(sum(quantity), 0) INTO reserved_count
    FROM pos_inventory_locks
    WHERE product_id = COALESCE(NEW.product_id, OLD.product_id)
      AND expires_at > CURRENT_TIMESTAMP;
    SELECT item_condition, in_stock_count INTO condition_value, remaining_count
    FROM products WHERE id = COALESCE(NEW.product_id, OLD.product_id);
    INSERT INTO inventory_events(product_id, item_condition, event_type,
      quantity_remaining, quantity_reserved, source)
    VALUES (COALESCE(NEW.product_id, OLD.product_id), condition_value,
      CASE WHEN TG_OP = 'DELETE' THEN 'RESERVATION_RELEASED' ELSE 'RESERVED' END,
      coalesce(remaining_count, 0), reserved_count, 'CART_OR_POS');
    PERFORM pg_notify('adonai_inventory', json_build_object(
      'product_id', COALESCE(NEW.product_id, OLD.product_id),
      'event_type', CASE WHEN TG_OP = 'DELETE' THEN 'RESERVATION_RELEASED' ELSE 'RESERVED' END,
      'quantity_remaining', coalesce(remaining_count, 0),
      'quantity_reserved', reserved_count
    )::text);
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO inventory_events(product_id, item_condition, event_type,
    quantity_remaining, quantity_reserved, source)
  VALUES (NEW.id, NEW.item_condition,
    CASE WHEN NEW.in_stock_count = 0 THEN 'OUT_OF_STOCK' ELSE 'STOCK_UPDATED' END,
    NEW.in_stock_count, 0, 'SALE_OR_INTAKE');
  PERFORM pg_notify('adonai_inventory', json_build_object(
    'product_id', NEW.id,
    'event_type', CASE WHEN NEW.in_stock_count = 0 THEN 'OUT_OF_STOCK' ELSE 'STOCK_UPDATED' END,
    'quantity_remaining', NEW.in_stock_count,
    'quantity_reserved', 0
  )::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_inventory_change_event ON products;
CREATE TRIGGER trg_products_inventory_change_event
AFTER INSERT OR UPDATE OF in_stock_count, item_condition, inventory_status
ON products
FOR EACH ROW EXECUTE FUNCTION adonai_inventory_change_event();

DROP TRIGGER IF EXISTS trg_pos_inventory_lock_change_event ON pos_inventory_locks;
CREATE TRIGGER trg_pos_inventory_lock_change_event
AFTER INSERT OR UPDATE OR DELETE ON pos_inventory_locks
FOR EACH ROW EXECUTE FUNCTION adonai_inventory_change_event();

COMMIT;
