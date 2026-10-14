-- Adonai Store: Dynamic multi-partner consignment inventory
-- Date: 2026-10-13
--
-- Additive, safe-to-rerun PostgreSQL migration. Store-owned Source A catalog
-- rows keep a NULL consignment_partner_id and a NULL item commission rate.
-- db_init.py also installs these additions during application startup.

BEGIN;

CREATE TABLE IF NOT EXISTS consignment_partners (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(50),
  whatsapp VARCHAR(50),
  email VARCHAR(160),
  address TEXT,
  payout_provider VARCHAR(60),
  payout_account_name VARCHAR(120),
  payout_account VARCHAR(100),
  default_commission_rate NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  region VARCHAR(100),
  supply_source VARCHAR(120),
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE,
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100),
  CONSTRAINT ck_consignment_partner_rate CHECK (default_commission_rate >= 0 AND default_commission_rate <= 100)
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS consignment_partner_id VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS consignment_partner_id VARCHAR(50);

DO $$ BEGIN
  ALTER TABLE consignment_partners ADD CONSTRAINT ck_consignment_partner_rate
    CHECK (default_commission_rate >= 0 AND default_commission_rate <= 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT ck_product_commission_rate
    CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS partner_name_snapshot VARCHAR(160);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS commission_rate_snapshot NUMERIC(5,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS consignment_gross_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS consignment_commission_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS partner_payable_amount INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT fk_products_consignment_partner
    FOREIGN KEY (consignment_partner_id) REFERENCES consignment_partners(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT fk_order_items_consignment_partner
    FOREIGN KEY (consignment_partner_id) REFERENCES consignment_partners(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Keep Source B settlements distinct from the legacy Bale Costs
-- `consignment_payouts` table, whose columns and status machine differ.
CREATE TABLE IF NOT EXISTS consignment_partner_payouts (
  id VARCHAR(64) PRIMARY KEY,
  partner_id VARCHAR(50) NOT NULL REFERENCES consignment_partners(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL,
  payment_method VARCHAR(30) NOT NULL,
  destination_snapshot VARCHAR(180),
  reference VARCHAR(120),
  notes TEXT,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  journal_entry_id VARCHAR(64) NOT NULL UNIQUE REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_consignment_payout_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS ix_consignment_partners_name ON consignment_partners(name);
CREATE INDEX IF NOT EXISTS ix_consignment_partners_region ON consignment_partners(region);
CREATE INDEX IF NOT EXISTS ix_consignment_partners_supply_source ON consignment_partners(supply_source);
CREATE INDEX IF NOT EXISTS ix_consignment_partners_active ON consignment_partners(active);
CREATE INDEX IF NOT EXISTS ix_products_consignment_partner_id ON products(consignment_partner_id);
CREATE INDEX IF NOT EXISTS ix_order_items_consignment_partner_id ON order_items(consignment_partner_id);
CREATE INDEX IF NOT EXISTS ix_consignment_partner_payouts_partner_id ON consignment_partner_payouts(partner_id);
CREATE INDEX IF NOT EXISTS ix_consignment_partner_payouts_created_at ON consignment_partner_payouts(created_at);

COMMIT;
