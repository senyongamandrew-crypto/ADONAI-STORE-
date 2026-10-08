-- Adonai Store: Multi-tier in-batch lot grading (safe additive PostgreSQL migration)
-- Date: 2026-10-08
--
-- Adds the grade-tier layer to the existing financial_stock_lots landed-cost
-- model. A bale's landed investment (acquisition + shipping) is apportioned
-- across named tiers by cost weight; each tier locks a per-piece unit COGS
-- that catalog tagging can never edit by hand. Running this repeatedly is
-- safe: every statement is idempotent and nothing existing is renamed or
-- dropped. db_init.py also creates the same objects on boot via create_all()
-- for databases migrated implicitly.

BEGIN;

-- 1. CHILD TABLE: multi-tier grading breakdown per stock lot
CREATE TABLE IF NOT EXISTS financial_lot_grades (
  id VARCHAR(64) PRIMARY KEY,
  lot_id VARCHAR(64) NOT NULL REFERENCES financial_stock_lots(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  grade_name VARCHAR(100) NOT NULL,
  expected_count INTEGER NOT NULL,
  cost_weight_percentage NUMERIC(6, 3) NOT NULL,
  unit_cogs INTEGER NOT NULL,
  target_selling_price INTEGER NOT NULL DEFAULT 0,
  allocated_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_lot_grade_items_positive CHECK (expected_count > 0),
  CONSTRAINT ck_lot_grade_weight_range CHECK (cost_weight_percentage > 0 AND cost_weight_percentage <= 100),
  CONSTRAINT ck_lot_grade_cogs_nonnegative CHECK (unit_cogs >= 0),
  CONSTRAINT ck_lot_grade_allocated_nonnegative CHECK (allocated_count >= 0)
);

-- 2. LINKAGE: catalog items may now point at the tier that locked their COGS
ALTER TABLE products ADD COLUMN IF NOT EXISTS lot_grade_id VARCHAR(64);

-- 3. Indexes (statement level has IF NOT EXISTS on PostgreSQL 9.5+)
CREATE INDEX IF NOT EXISTS ix_financial_lot_grades_lot_id ON financial_lot_grades(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_grade_lot_sort ON financial_lot_grades(lot_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_products_lot_grade_id ON products(lot_grade_id);

COMMIT;
