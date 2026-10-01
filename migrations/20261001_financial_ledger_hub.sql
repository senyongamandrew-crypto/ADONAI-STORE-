-- Adonai Store: Financial Ledgers hub (safe additive PostgreSQL migration)
-- Date: 2026-10-01
--
-- This migration is deliberately non-destructive and may be run repeatedly on
-- the existing Render PostgreSQL database. It does not rename/drop any existing
-- object and does not change DATABASE_URL handling.

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_lot_id VARCHAR(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS category VARCHAR(100);

CREATE TABLE IF NOT EXISTS accounting_journal_entries (
  id VARCHAR(64) PRIMARY KEY,
  reference VARCHAR(100) NOT NULL,
  source VARCHAR(50) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
  occurred_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100),
  reversal_of_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id VARCHAR(64) PRIMARY KEY,
  journal_entry_id VARCHAR(64) NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
  account_code VARCHAR(20) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_journal_line_one_side CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
);

CREATE TABLE IF NOT EXISTS financial_expenses (
  id VARCHAR(64) PRIMARY KEY,
  category VARCHAR(100) NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(50) NOT NULL,
  vendor VARCHAR(150),
  receipt_reference VARCHAR(120),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
  occurred_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  journal_entry_id VARCHAR(64),
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  voided_at TIMESTAMP WITHOUT TIME ZONE,
  voided_by_id VARCHAR(50),
  void_reason TEXT
);

CREATE TABLE IF NOT EXISTS financial_stock_lots (
  id VARCHAR(64) PRIMARY KEY,
  lot_code VARCHAR(50) UNIQUE NOT NULL,
  supplier VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  acquisition_cost INTEGER NOT NULL CHECK (acquisition_cost >= 0),
  shipping_cost INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  total_landed_cost INTEGER NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  unit_cost INTEGER NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  allocated_count INTEGER NOT NULL DEFAULT 0,
  acquired_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  journal_entry_id VARCHAR(64),
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS financial_inventory_adjustments (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(50) NOT NULL,
  adjustment_type VARCHAR(30) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  old_price INTEGER,
  new_price INTEGER,
  loss_amount INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  journal_entry_id VARCHAR(64),
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pos_inventory_locks (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(50) NOT NULL,
  lock_owner VARCHAR(100) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  created_by_id VARCHAR(50),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_pos_lock_product_owner UNIQUE (product_id, lock_owner)
);

CREATE INDEX IF NOT EXISTS ix_products_stock_lot_id ON products(stock_lot_id);
CREATE INDEX IF NOT EXISTS ix_products_inventory_status ON products(inventory_status);
CREATE INDEX IF NOT EXISTS ix_order_items_category ON order_items(category);
CREATE INDEX IF NOT EXISTS ix_aje_reference ON accounting_journal_entries(reference);
CREATE INDEX IF NOT EXISTS ix_aje_source ON accounting_journal_entries(source);
CREATE INDEX IF NOT EXISTS ix_aje_occurred_at ON accounting_journal_entries(occurred_at);
CREATE INDEX IF NOT EXISTS ix_ajl_entry ON accounting_journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS ix_ajl_account ON accounting_journal_lines(account_code, journal_entry_id);
CREATE INDEX IF NOT EXISTS ix_fin_expense_date ON financial_expenses(occurred_at);
CREATE INDEX IF NOT EXISTS ix_fin_expense_status ON financial_expenses(status);
CREATE INDEX IF NOT EXISTS ix_fin_stock_lot_date ON financial_stock_lots(acquired_at);
CREATE INDEX IF NOT EXISTS ix_fin_adj_product ON financial_inventory_adjustments(product_id, created_at);
CREATE INDEX IF NOT EXISTS ix_pos_lock_product_expiry ON pos_inventory_locks(product_id, expires_at);
CREATE INDEX IF NOT EXISTS ix_pos_lock_owner ON pos_inventory_locks(lock_owner);

COMMIT;
