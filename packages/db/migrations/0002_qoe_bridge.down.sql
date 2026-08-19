DROP TABLE IF EXISTS qoe_addbacks;

ALTER TABLE companies DROP COLUMN IF EXISTS market_rate_replacement_salary;
ALTER TABLE chart_of_accounts DROP COLUMN IF EXISTS ebitda_role;
DROP INDEX IF EXISTS idx_gl_entries_coa;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS coa_id;
