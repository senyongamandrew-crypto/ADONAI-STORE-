-- Read-only post-deployment checks for 20261012_consignment_partner_intake.sql.
-- Every query below should return ZERO rows on a healthy database.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261012_consignment_partner_intake_verify.sql

-- 1. Every sale split reconciles to its line total.
SELECT 'split does not reconcile' AS problem, id FROM consignment_sales_splits
 WHERE commission_amount + partner_share <> line_total;

-- 2. Consignment products never carry an Adonai cost (cost would overstate stock value and COGS).
SELECT 'consignment product has a cost' AS problem, id FROM products
 WHERE is_consignment AND cost_price <> 0;

-- 3. Consignment products are one-of-one and always linked to a partner.
SELECT 'consignment product without partner or with quantity != 1' AS problem, id FROM products
 WHERE is_consignment AND (supplier_id IS NULL OR in_stock_count NOT IN (0, 1));

-- 4. Lots are typed consistently with their supplier link.
SELECT 'lot type and supplier disagree' AS problem, id FROM financial_stock_lots
 WHERE (lot_type = 'PARTNER_CONSIGNMENT') <> (supplier_id IS NOT NULL);

-- 5. A paid payout always has a unique payment reference and a journal entry.
SELECT 'paid payout missing reference or journal' AS problem, id FROM consignment_payouts
 WHERE status = 'PAID' AND (payment_reference IS NULL OR journal_entry_id IS NULL);

-- 6. Partner payable is never over-paid: payouts paid may not exceed fulfilled shares.
SELECT 'partner overpaid' AS problem, s.id, s.partner_name
  FROM consignment_suppliers s
 WHERE (SELECT COALESCE(SUM(p.amount), 0) FROM consignment_payouts p
         WHERE p.supplier_id = s.id AND p.status = 'PAID')
     > (SELECT COALESCE(SUM(sp.partner_share), 0) FROM consignment_sales_splits sp
          JOIN orders o ON o.id = sp.order_id
         WHERE sp.supplier_id = s.id AND o.status = 'completed');

-- 7. Ledger: account 2100 (partner payable) must equal shares recorded minus payouts paid.
SELECT 'partner payable does not match the journal' AS problem
 WHERE (SELECT COALESCE(SUM(credit) - SUM(debit), 0) FROM accounting_journal_lines WHERE account_code = '2100')
    <> ((SELECT COALESCE(SUM(partner_share), 0) FROM consignment_sales_splits)
        - (SELECT COALESCE(SUM(amount), 0) FROM consignment_payouts WHERE status = 'PAID'));
