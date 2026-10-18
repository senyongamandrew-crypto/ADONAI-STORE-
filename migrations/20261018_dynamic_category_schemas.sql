-- Adonai Store: Dynamic category field schemas (schema-driven Catalog Intake)
-- Date: 2026-10-18
--
-- Additive, safe-to-rerun PostgreSQL / Supabase migration. Nothing is
-- dropped, renamed or rewritten; existing catalog rows keep working with an
-- empty attributes object until staff re-open them.
--
--   * products.subcategory / attributes (JSONB) / search_tags_json /
--     fulfillment_notes — first-class columns for the intake form.
--   * category_field_schemas — one JSON form definition per item family
--     (earrings, rings & bracelets, necklaces, tops, scarves, footwear,
--     bags…). The application seeds and refreshes rows marked
--     source = 'system' from data/category_field_schemas.json at startup;
--     rows edited in Supabase should set source = 'custom' so a deploy
--     never overwrites them.
--   * catalog_items — read-only view in the intake vocabulary (title,
--     lot_id, cogs_unit_cost, suggested_retail_price…) over products, so
--     reports and Supabase clients can query category attributes directly.
--
-- db_init.py installs the same columns, index and table during startup;
-- this script is for explicit Render / Supabase migrations.

BEGIN;

-- 1. Product columns -------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS fulfillment_notes TEXT;

CREATE INDEX IF NOT EXISTS ix_products_subcategory ON products (subcategory);
-- jsonb_path_ops serves containment filters such as
--   attributes @> '{"schema_key":"earrings","values":{"nickel_free":true}}'
CREATE INDEX IF NOT EXISTS ix_products_attributes_gin ON products USING GIN (attributes jsonb_path_ops);

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_products_attributes_object
    CHECK (jsonb_typeof(attributes) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Form definitions ------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_field_schemas (
  schema_key VARCHAR(60) PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  label VARCHAR(120) NOT NULL,
  category_group VARCHAR(120),
  profile VARCHAR(30),
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  subcategories JSONB NOT NULL DEFAULT '[]'::jsonb,
  applies_to JSONB NOT NULL DEFAULT '[]'::jsonb,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  source VARCHAR(20) NOT NULL DEFAULT 'system',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE
);

DO $$ BEGIN
  ALTER TABLE category_field_schemas ADD CONSTRAINT ck_category_field_schemas_definition
    CHECK (jsonb_typeof(definition) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE category_field_schemas ADD CONSTRAINT ck_category_field_schemas_source
    CHECK (source IN ('system', 'custom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_category_field_schemas_active ON category_field_schemas (active);

-- 3. Intake-vocabulary view ------------------------------------------------
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
  p.updated_at
FROM products p;

COMMENT ON VIEW catalog_items IS
  'Adonai Catalog Intake vocabulary over products; category-specific values live in attributes (JSONB, explicit units).';

COMMIT;
