-- Adonai Store: Partner consignment intake, cash share and payouts
-- (safe additive PostgreSQL migration)
-- Date: 2026-10-12
--
-- Idempotent: every statement uses IF NOT EXISTS, guarded DO blocks, or
-- CREATE OR REPLACE, so it can be rerun on the live Render database. Nothing
-- existing is renamed, dropped, truncated or rewritten. Existing lots are
-- backfilled to OWNED_BALE by the column default.
--
-- Run after 20261008_multi_tier_lot_grading.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261012_consignment_partner_intake.sql
--
-- Money policy (see consignment.py): Adonai earns 5.00% of each consignment
-- sale line; the partner is owed the remainder of that same line once the order
-- is completed. Amounts are whole UGX.

BEGIN;

-- 1. Consignment partners (internal KYC and payout records)
CREATE TABLE IF NOT EXISTS consignment_suppliers (
  id VARCHAR(64) PRIMARY KEY,
  partner_name VARCHAR(150) NOT NULL,
  business_name VARCHAR(150),
  phone_whatsapp VARCHAR(30) NOT NULL,
  identity_reference VARCHAR(120) NOT NULL,
  payout_channel VARCHAR(30) NOT NULL,
  payout_account VARCHAR(120),
  kyc_status VARCHAR(20) NOT NULL DEFAULT 'PENDING_KYC',
  kyc_verified_by_id VARCHAR(64),
  kyc_verified_at TIMESTAMP WITHOUT TIME ZONE,
  created_by_id VARCHAR(64),
  created_by_name VARCHAR(100),
  default_commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.05,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_supplier_kyc_status CHECK (kyc_status IN ('PENDING_KYC', 'VERIFIED')),
  CONSTRAINT ck_supplier_payout_channel CHECK (payout_channel IN ('MOBILE_MONEY', 'MERCHANT_CODE', 'BANK_ACCOUNT', 'CASH')),
  CONSTRAINT ck_supplier_commission_locked CHECK (default_commission_rate = 0.05)
);
CREATE INDEX IF NOT EXISTS ix_consignment_suppliers_kyc_status ON consignment_suppliers(kyc_status);

-- 2. Lot and catalogue extensions
ALTER TABLE financial_stock_lots ADD COLUMN IF NOT EXISTS lot_type VARCHAR(30) NOT NULL DEFAULT 'OWNED_BALE';
ALTER TABLE financial_stock_lots ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(64);
ALTER TABLE financial_stock_lots ADD COLUMN IF NOT EXISTS agreement_ref VARCHAR(80);
ALTER TABLE financial_stock_lots ADD COLUMN IF NOT EXISTS return_by_date TIMESTAMP WITHOUT TIME ZONE;

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_consignment BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS consignment_reference_value INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE financial_stock_lots ADD CONSTRAINT fk_stock_lot_supplier
    FOREIGN KEY (supplier_id) REFERENCES consignment_suppliers(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT fk_products_supplier
    FOREIGN KEY (supplier_id) REFERENCES consignment_suppliers(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE financial_stock_lots ADD CONSTRAINT ck_stock_lot_type
    CHECK (lot_type IN ('OWNED_BALE', 'PARTNER_CONSIGNMENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE financial_stock_lots ADD CONSTRAINT ck_stock_lot_supplier_matches_type
    CHECK ((lot_type = 'PARTNER_CONSIGNMENT' AND supplier_id IS NOT NULL)
        OR (lot_type = 'OWNED_BALE' AND supplier_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_financial_stock_lots_lot_type ON financial_stock_lots(lot_type);
CREATE INDEX IF NOT EXISTS ix_financial_stock_lots_supplier_id ON financial_stock_lots(supplier_id);
CREATE INDEX IF NOT EXISTS ix_products_is_consignment ON products(is_consignment);
CREATE INDEX IF NOT EXISTS ix_products_supplier_id ON products(supplier_id);

-- 3. Sale-line splits, written once per consignment sale line at checkout
CREATE TABLE IF NOT EXISTS consignment_sales_splits (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id VARCHAR(64) NOT NULL UNIQUE,
  supplier_id VARCHAR(64) NOT NULL REFERENCES consignment_suppliers(id),
  product_id VARCHAR(50) NOT NULL,
  line_total INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL,
  partner_share INTEGER NOT NULL,
  commission_rate NUMERIC(5, 4) NOT NULL,
  journal_entry_id VARCHAR(64),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_split_line_nonnegative CHECK (line_total >= 0),
  CONSTRAINT ck_split_parts_nonnegative CHECK (commission_amount >= 0 AND partner_share >= 0),
  CONSTRAINT ck_split_reconciles CHECK (commission_amount + partner_share = line_total)
);
CREATE INDEX IF NOT EXISTS ix_consignment_sales_splits_order_id ON consignment_sales_splits(order_id);
CREATE INDEX IF NOT EXISTS ix_consignment_sales_splits_supplier_id ON consignment_sales_splits(supplier_id);
CREATE INDEX IF NOT EXISTS ix_consignment_sales_splits_product_id ON consignment_sales_splits(product_id);

-- 4. Partner payouts: request -> approve -> pay, with idempotent requests
CREATE TABLE IF NOT EXISTS consignment_payouts (
  id VARCHAR(64) PRIMARY KEY,
  supplier_id VARCHAR(64) NOT NULL REFERENCES consignment_suppliers(id),
  amount INTEGER NOT NULL,
  channel VARCHAR(30) NOT NULL,
  account_snapshot VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
  idempotency_key VARCHAR(80) NOT NULL UNIQUE,
  requested_by_id VARCHAR(64),
  requested_by_name VARCHAR(100),
  approved_by_id VARCHAR(64),
  approved_by_name VARCHAR(100),
  paid_by_id VARCHAR(64),
  paid_by_name VARCHAR(100),
  payment_reference VARCHAR(120) UNIQUE,
  journal_entry_id VARCHAR(64),
  note TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP WITHOUT TIME ZONE,
  CONSTRAINT ck_payout_amount_positive CHECK (amount > 0),
  CONSTRAINT ck_payout_status CHECK (status IN ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED')),
  CONSTRAINT ck_payout_paid_has_reference CHECK (status <> 'PAID' OR payment_reference IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_consignment_payouts_supplier_id ON consignment_payouts(supplier_id);
CREATE INDEX IF NOT EXISTS ix_consignment_payouts_status ON consignment_payouts(status);

-- 5. Tamper resistance: posted settlement rows cannot be edited or deleted.
--    Corrections are made by reversing journal entries, never by rewriting history.
CREATE OR REPLACE FUNCTION consignment_block_settlement_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: consignment settlement records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consignment_splits_immutable ON consignment_sales_splits;
CREATE TRIGGER trg_consignment_splits_immutable
  BEFORE UPDATE OR DELETE ON consignment_sales_splits
  FOR EACH ROW EXECUTE FUNCTION consignment_block_settlement_change();

DROP TRIGGER IF EXISTS trg_consignment_paid_payouts_immutable ON consignment_payouts;
CREATE TRIGGER trg_consignment_paid_payouts_immutable
  BEFORE UPDATE OR DELETE ON consignment_payouts
  FOR EACH ROW
  WHEN (OLD.status = 'PAID')
  EXECUTE FUNCTION consignment_block_settlement_change();

DROP TRIGGER IF EXISTS trg_consignment_payouts_no_delete ON consignment_payouts;
CREATE TRIGGER trg_consignment_payouts_no_delete
  BEFORE DELETE ON consignment_payouts
  FOR EACH ROW EXECUTE FUNCTION consignment_block_settlement_change();

COMMIT;
