-- ============================================================================
-- Migration 050: General Ledger Entries — raw-row schema
--
-- Purpose:
--   Extend general_ledger_entries to store EVERY row from the source GL file
--   faithfully, including account headers, beginning balances, and total rows.
--
--   The previous schema only supported transaction rows (required date + account).
--   This migration:
--     1. Makes transaction_date and fiscal_year nullable (non-transaction rows have none).
--     2. Adds row_type column (ACCOUNT_HEADER | BEGINNING_BALANCE | TRANSACTION | TOTAL_ROW).
--     3. Adds raw-value columns: account_section, distribution_account, transaction_num,
--        transaction_name, memo_description, split_account, amount, running_balance, raw_row_json.
--
-- Backward-compatible: existing columns unchanged; new columns are nullable with defaults.
-- This migration is idempotent: safe to re-run.
-- ============================================================================

-- 1. Make formerly-required columns nullable so non-transaction rows can be stored.
ALTER TABLE general_ledger_entries
  ALTER COLUMN transaction_date DROP NOT NULL,
  ALTER COLUMN fiscal_year      DROP NOT NULL;

-- 2. row_type — the structural role of this row in the source GL file.
--    Default 'TRANSACTION' keeps existing rows valid.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS row_type text NOT NULL DEFAULT 'TRANSACTION';

-- 3. account_section — the account header that this row belongs to (tracks the
--    current section as the extractor walks down the file).
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS account_section text;

-- 4. distribution_account — the account being credited/debited in this transaction
--    (equals account_section in by-Account QBO export; equals account_name column
--     in columnar exports).
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS distribution_account text;

-- 5. transaction_num — raw Num / Check # / Reference value from the source row.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS transaction_num text;

-- 6. transaction_name — raw Name / Vendor / Payee value from the source row.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS transaction_name text;

-- 7. memo_description — raw Memo / Description cell value.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS memo_description text;

-- 8. split_account — the offsetting account ("Split" column in QBO by-Account export).
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS split_account text;

-- 9. amount — the signed raw amount extracted from the Amount column (+debit / -credit).
--    Kept separate from the legacy debit/credit pair; both are preserved.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS amount numeric(18,2);

-- 10. running_balance — the Balance / Running Balance column value, if present.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS running_balance numeric(18,2);

-- 11. raw_row_json — complete serialised source row as a JSON array string,
--     for audit and re-processing without re-reading the original file.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS raw_row_json text;

-- ── Supporting indexes ─────────────────────────────────────────────────────────

-- Row-number ordering preserves source-file row sequence for display.
CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_row_number
  ON general_ledger_entries(version_id, row_number);

-- row_type filter (e.g. "show only TRANSACTION rows" for reports).
CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_row_type
  ON general_ledger_entries(version_id, row_type);

-- account_section search.
CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_section
  ON general_ledger_entries(version_id, account_section);

-- ── Completion marker ──────────────────────────────────────────────────────────

COMMENT ON COLUMN general_ledger_entries.row_type IS
  'ACCOUNT_HEADER | BEGINNING_BALANCE | TRANSACTION | TOTAL_ROW';
COMMENT ON COLUMN general_ledger_entries.account_section IS
  'The account section header this row belongs to (tracks current section while walking the file)';
COMMENT ON COLUMN general_ledger_entries.raw_row_json IS
  'Complete source row serialised as a JSON array — audit trail; source file not needed after sync';
