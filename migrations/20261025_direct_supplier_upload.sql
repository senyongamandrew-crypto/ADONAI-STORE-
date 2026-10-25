-- ============================================================================
-- Adonai Store — Direct-upload supplier catalog intake (2026-10-25)
--
-- Direct-upload model: partners (e.g. "Finds Ug") supply pre-photographed
-- pieces that are ingested one garment at a time. Every item is tagged with
-- its source supplier, a fixed unit cost, and the base retail price it should
-- sell at — no multi-tier landed-cost weight distributions, no batch-level
-- invoice allocations.
--
-- This migration implements the catalog_items economics schema:
--
--   ALTER TABLE catalog_items
--   ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),
--   ADD COLUMN IF NOT EXISTS fixed_unit_cost NUMERIC(12, 2) CHECK (fixed_unit_cost >= 0),
--   ADD COLUMN IF NOT EXISTS base_retail_price NUMERIC(12, 2) CHECK (base_retail_price >= 0);
--
-- In this schema `catalog_items` is the read-only intake-vocabulary VIEW over
-- `products` (installed by 20261018_dynamic_category_schemas.sql), so the
-- three columns are added to the physical `products` table and exposed on the
-- view. If a deployment happens to carry `catalog_items` as a real table, the
-- DO block below applies the ALTER TABLE statements verbatim to it as well.
--
-- Because the Python ingestion service inserts straight into `catalog_items`
-- (supabase-py → PostgREST), the view also gains:
--   * intake-vocabulary aliases (item_name, catalog_group, size_availability,
--     condition_notes) matching the direct-upload payload structure, and
--   * an INSTEAD OF INSERT trigger that maps a direct-upload row onto
--     `products`, synthesizing identity and pricing fields the payload does
--     not carry (id, sku, barcode, quantity policy, selling price…).
--
-- Safe to rerun. Uses only ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
-- exception-guarded ADD CONSTRAINT, and CREATE OR REPLACE FUNCTION/TRIGGER.
-- Run after 20261018_dynamic_category_schemas.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261025_direct_supplier_upload.sql
-- ============================================================================

BEGIN;

-- 1. Enum types the trigger casts through (already present on databases that
--    ran 20261003_dual_inventory.sql; created idempotently otherwise).
DO $$ BEGIN
  CREATE TYPE item_condition_enum AS ENUM ('BRAND_NEW', 'PRE_LOVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quantity_type_enum AS ENUM ('BRAND_NEW', 'PRE_LOVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Physical columns on products (the relation behind catalog_items) --------
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS fixed_unit_cost NUMERIC(12, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS base_retail_price NUMERIC(12, 2);

-- CHECK (fixed_unit_cost >= 0) / CHECK (base_retail_price >= 0). ALTER TABLE
-- ADD CONSTRAINT has no IF NOT EXISTS form, so guard each one (same pattern as
-- ck_products_attributes_object in the 2026-10-18 migration).
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_products_fixed_unit_cost
    CHECK (fixed_unit_cost IS NULL OR fixed_unit_cost >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_products_base_retail_price
    CHECK (base_retail_price IS NULL OR base_retail_price >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_products_supplier_name ON products (supplier_name);

-- 3. Literal ALTER TABLE catalog_items for deployments where the relation is
--    a real table rather than the intake-vocabulary view.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'catalog_items'
      AND c.relkind IN ('r', 'p')
  ) THEN
    EXECUTE 'ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255)';
    EXECUTE 'ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS fixed_unit_cost NUMERIC(12, 2)';
    EXECUTE 'ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS base_retail_price NUMERIC(12, 2)';
    BEGIN
      EXECUTE 'ALTER TABLE catalog_items ADD CONSTRAINT ck_catalog_items_fixed_unit_cost CHECK (fixed_unit_cost IS NULL OR fixed_unit_cost >= 0)';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE 'ALTER TABLE catalog_items ADD CONSTRAINT ck_catalog_items_base_retail_price CHECK (base_retail_price IS NULL OR base_retail_price >= 0)';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- 4. Intake-vocabulary view with the direct-upload columns appended. The
--    original column list is reproduced exactly (CREATE OR REPLACE VIEW only
--    permits appending), so existing reports keep working unchanged.
CREATE OR REPLACE VIEW catalog_items AS
SELECT
  p.id,
  p.name                          AS title,
  p.sku,
  p.barcode_id,
  COALESCE(NULLIF(p.brand, ''), 'Unbranded') AS brand,
  p.demographic,
  p.category,
  p.subcategory,
  p.item_condition,
  p.condition                     AS condition_grade,
  p.stock_lot_id                  AS lot_id,
  p.lot_grade_id,
  p.cost_price                    AS cogs_unit_cost,
  p.base_price                    AS suggested_retail_price,
  p.selling_price,
  p.in_stock_count                AS stock_quantity,
  p.attributes ->> 'schema_key'   AS schema_key,
  COALESCE((p.attributes ->> 'complete')::boolean, FALSE) AS attributes_complete,
  p.attributes,
  p.attributes -> 'values'        AS attribute_values,
  p.attributes -> 'inspection'    AS inspection,
  p.attributes -> 'photo_angles'  AS photo_angles,
  p.image_url,
  p.images_json,
  p."desc"                        AS story,
  p.search_tags_json,
  p.fulfillment_notes,
  p.inventory_status,
  p.created_at,
  p.updated_at,
  -- Direct-upload supplier tagging + item-level economics (2026-10-25).
  p.supplier_name,
  p.fixed_unit_cost,
  p.base_retail_price,
  -- Intake-vocabulary aliases of the direct-upload payload structure, so
  -- supabase clients can INSERT INTO catalog_items (item_name, supplier_name,
  -- catalog_group, subcategory, fixed_unit_cost, base_retail_price,
  -- size_availability, color, image_url, condition_notes, created_at) verbatim.
  p.name                          AS item_name,
  p.category                      AS catalog_group,
  p.size                          AS size_availability,
  p.condition                     AS condition_notes,
  p.color
FROM products p;

COMMENT ON VIEW catalog_items IS
  'Adonai Catalog Intake vocabulary over products; category-specific values live in attributes (JSONB, explicit units). Direct-upload suppliers tag items with supplier_name, fixed_unit_cost and base_retail_price; the view accepts INSERTs and maps them onto products.';

-- 5. INSTEAD OF INSERT — direct-upload ingestion surface -------------------
--
-- Makes the documented ingestion contract work exactly as specified:
--   supabase.table("catalog_items").insert(payload).execute()
-- The payload carries only the direct-upload fields; everything else products
-- requires (identity, demographics, quantity policy, whole-UGX pricing) is
-- synthesized here so piece-by-piece supplier uploads never need bale books.
CREATE OR REPLACE FUNCTION adonai_catalog_items_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_id            text;
  v_sku           text;
  v_barcode       text;
  v_name          text;
  v_brand         text;
  v_color         text;
  v_demographic   text;
  v_group         text;
  v_subcategory   text;
  v_size          text;
  v_condition     text;
  v_story         text;
  v_image_url     text;
  v_status        text;
  v_supplier      text;
  v_item_cond     text;
  v_fixed_cost    numeric(12, 2);
  v_retail        numeric(12, 2);
  v_cost_price    integer;
  v_base_price    numeric(14, 2);
  v_selling_price integer;
  v_compare       integer;
  v_stock         integer;
  v_created_at    timestamp;
BEGIN
  -- Required fields (mirrors SupplierCatalogIngestionService.sanitize_item_payload).
  v_name := COALESCE(NULLIF(btrim(NEW.item_name), ''), NULLIF(btrim(NEW.title), ''));
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Item name and supplier name are required fields.';
  END IF;

  -- Financial figures cannot be negative (CHECK constraints also enforce this).
  v_fixed_cost := NEW.fixed_unit_cost;
  IF v_fixed_cost IS NOT NULL AND v_fixed_cost < 0 THEN
    RAISE EXCEPTION 'Financial figures cannot be negative.';
  END IF;
  v_retail := NEW.base_retail_price;
  IF v_retail IS NOT NULL AND v_retail < 0 THEN
    RAISE EXCEPTION 'Financial figures cannot be negative.';
  END IF;

  v_item_cond := COALESCE(NULLIF(btrim(NEW.item_condition::text), ''), 'PRE_LOVED');
  IF v_item_cond NOT IN ('BRAND_NEW', 'PRE_LOVED') THEN
    RAISE EXCEPTION 'item_condition must be BRAND_NEW or PRE_LOVED';
  END IF;

  -- Piece-by-piece uploads default to unique pre-loved stock (1-of-1).
  v_stock := COALESCE(NEW.stock_quantity, 1);
  IF v_stock < 0 THEN
    RAISE EXCEPTION 'stock_quantity cannot be negative.';
  END IF;
  IF v_item_cond = 'PRE_LOVED' AND v_stock NOT IN (0, 1) THEN
    RAISE EXCEPTION 'PRE_LOVED inventory must have quantity 1 (or 0 after it is sold)';
  END IF;

  -- Item-level economics: fixed_unit_cost is the unit COGS, base_retail_price
  -- is the retail tag. Direct-upload pieces carry no transport allocation, so
  -- selling price equals the base retail price (same rule as consignment).
  v_cost_price := COALESCE(
    CASE WHEN v_fixed_cost IS NULL THEN NULL ELSE ROUND(v_fixed_cost)::integer END,
    NEW.cogs_unit_cost, 0);
  v_base_price := COALESCE(v_retail, NEW.suggested_retail_price, 0);
  v_selling_price := COALESCE(NEW.selling_price, ROUND(v_base_price)::integer, 0);
  -- The intake-vocabulary view exposes no compare-at column; direct uploads
  -- leave the RRP valuation empty.
  v_compare := 0;

  -- Identity: keep client-supplied codes, generate otherwise (mirrors generate_uid()).
  v_id := COALESCE(NULLIF(btrim(NEW.id), ''),
                   'PRD-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 12)));
  v_sku := COALESCE(NULLIF(btrim(NEW.sku), ''),
                    'ADN-DIR-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 10)));
  v_barcode := COALESCE(NULLIF(btrim(NEW.barcode_id), ''),
                        'ADT-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 12)));

  v_brand := COALESCE(NULLIF(btrim(NEW.brand), ''), 'Curated');
  v_color := NULLIF(btrim(NEW.color), '');
  v_demographic := COALESCE(NULLIF(btrim(NEW.demographic), ''), 'Unisex');
  v_group := COALESCE(NULLIF(btrim(NEW.catalog_group), ''), NULLIF(btrim(NEW.category), ''), 'Outerwear & Jackets');
  v_subcategory := NULLIF(btrim(NEW.subcategory), '');
  v_size := COALESCE(NULLIF(btrim(NEW.size_availability), ''), '-');
  v_condition := COALESCE(NULLIF(btrim(NEW.condition_notes), ''), NULLIF(btrim(NEW.condition_grade), ''), 'Premium Grade 1');
  v_story := COALESCE(NULLIF(btrim(NEW.story), ''), '');
  v_image_url := NULLIF(btrim(NEW.image_url), '');
  v_status := COALESCE(NULLIF(btrim(NEW.inventory_status), ''), 'AVAILABLE');
  v_supplier := NULLIF(btrim(NEW.supplier_name), '');
  v_created_at := COALESCE(NEW.created_at, CURRENT_TIMESTAMP);

  -- format('%L') emits string literals (or unquoted NULL), so enum-typed and
  -- varchar-typed item_condition/quantity_type columns both accept the INSERT.
  EXECUTE format(
    'INSERT INTO products ('
    '  id, sku, barcode_id, name, brand, color, demographic, category, subcategory,'
    '  size, item_condition, quantity_type, condition, cost_price, base_price,'
    '  total_transport_cost, selling_price, compare_price, in_stock_count, "desc",'
    '  image_url, images_json, search_tags_json, fulfillment_notes, attributes,'
    '  supplier_name, fixed_unit_cost, base_retail_price, inventory_status, created_at'
    ') VALUES ('
    '  %L, %L, %L, %L, %L, %L, %L, %L, %L,'
    '  %L, %L, %L, %L, %s, %s,'
    '  %s, %s, %s, %s, %L,'
    '  %L, %L, %L, %L, %L::jsonb,'
    '  %L, %L, %L, %L, %L'
    ')',
    v_id, v_sku, v_barcode, v_name, v_brand, v_color, v_demographic, v_group, v_subcategory,
    v_size, v_item_cond, v_item_cond, v_condition, v_cost_price, v_base_price,
    0, v_selling_price, v_compare, v_stock, v_story,
    v_image_url, COALESCE(NEW.images_json, '[]'), COALESCE(NEW.search_tags_json, '[]'),
    NULLIF(btrim(NEW.fulfillment_notes), ''), COALESCE(NEW.attributes::text, '{}'),
    v_supplier, v_fixed_cost, v_retail, v_status, v_created_at
  );

  -- Return the row PostgREST RETURNING expects, with synthesized values filled in.
  NEW.id := v_id;
  NEW.sku := v_sku;
  NEW.barcode_id := v_barcode;
  NEW.title := v_name;
  NEW.item_name := v_name;
  NEW.brand := v_brand;
  NEW.color := v_color;
  NEW.demographic := v_demographic;
  NEW.category := v_group;
  NEW.catalog_group := v_group;
  NEW.subcategory := v_subcategory;
  NEW.size_availability := v_size;
  NEW.condition_grade := v_condition;
  NEW.condition_notes := v_condition;
  NEW.cogs_unit_cost := v_cost_price;
  NEW.suggested_retail_price := v_base_price;
  NEW.selling_price := v_selling_price;
  NEW.stock_quantity := v_stock;
  NEW.story := v_story;
  NEW.image_url := v_image_url;
  NEW.images_json := COALESCE(NEW.images_json, '[]');
  NEW.search_tags_json := COALESCE(NEW.search_tags_json, '[]');
  NEW.attributes := COALESCE(NEW.attributes, '{}'::jsonb);
  NEW.supplier_name := v_supplier;
  NEW.fixed_unit_cost := v_fixed_cost;
  NEW.base_retail_price := v_retail;
  NEW.inventory_status := v_status;
  NEW.created_at := v_created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_items_direct_upload_insert ON catalog_items;
CREATE TRIGGER catalog_items_direct_upload_insert
  INSTEAD OF INSERT ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION adonai_catalog_items_insert();

COMMIT;
