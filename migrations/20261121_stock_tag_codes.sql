-- Stock-tag codes for small thermal labels (32 x 16 mm Code 128).
--
-- Catalog Intake can print a miniature price tag per piece that is cut off the
-- 80 mm roll with scissors: 2 tags across, 5 rows per job. A label like that
-- only carries ~99 Code 128 modules, so it needs a short code instead of the
-- full SKU. That code must resolve to exactly one garment forever, which is
-- why it is allocated here (sequentially, never reused) instead of being
-- derived from a hash or a rack position.
--
-- Run after 20261025_direct_supplier_upload.sql. db_init.py installs the same
-- column, index and backfill automatically at startup; this file is for
-- deployments applying schema changes by hand.

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS tag_code VARCHAR(20);

-- One permanent label per piece. NULLs stay allowed: legacy rows and direct
-- Supabase inserts are stamped by the allocator (app/api.py,
-- POST /api/products/tag-codes) or by the boot backfill.
CREATE UNIQUE INDEX IF NOT EXISTS ix_products_tag_code ON products(tag_code);

-- Backfill in creation order so older pieces keep the earlier numbers. A
-- window function runs once, before any new code is issued, which is what
-- keeps existing labels stable across re-runs of this migration.
WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC NULLS LAST, id ASC) AS position
    FROM products
    WHERE tag_code IS NULL OR tag_code = ''
)
UPDATE products p
SET tag_code = CASE
        WHEN (ordered.position + 1000) < 10000
            THEN LPAD((ordered.position + 1000)::text, 4, '0')
        ELSE (ordered.position + 1000)::text
    END
FROM ordered
WHERE p.id = ordered.id;

COMMIT;

-- Verify: every piece carries a short numeric code, and no code is shared.
-- SELECT COUNT(*) FILTER (WHERE tag_code IS NULL) AS untagged,
--        COUNT(*) - COUNT(DISTINCT tag_code)      AS duplicates
-- FROM products;
