-- Read-only post-deployment checks for the Financial Ledgers migration.
-- Safe to run from the Render PostgreSQL shell after deployment.

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'accounting_journal_entries',
    'accounting_journal_lines',
    'financial_expenses',
    'financial_stock_lots',
    'financial_inventory_adjustments',
    'pos_inventory_locks'
  )
ORDER BY table_name;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'products' AND column_name IN ('stock_lot_id', 'inventory_status'))
    OR (table_name = 'order_items' AND column_name IN ('unit_cost', 'category'))
  )
ORDER BY table_name, column_name;

-- Every journal header should balance to zero. This query must return no rows.
SELECT
  e.id,
  e.reference,
  SUM(l.debit) AS debit_total,
  SUM(l.credit) AS credit_total
FROM accounting_journal_entries e
JOIN accounting_journal_lines l ON l.journal_entry_id = e.id
GROUP BY e.id, e.reference
HAVING SUM(l.debit) <> SUM(l.credit);

-- Expired holds are harmless (all availability queries ignore them), but this
-- identifies rows that may be cleaned by the next lock or checkout request.
SELECT COUNT(*) AS expired_lock_rows
FROM pos_inventory_locks
WHERE expires_at <= CURRENT_TIMESTAMP;
