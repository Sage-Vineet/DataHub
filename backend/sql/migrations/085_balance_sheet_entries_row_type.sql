-- Adds a row-classification column to balance_sheet_entries so EVERY row from
-- an uploaded Balance Sheet document can be persisted (headings, subtotals,
-- totals, metadata rows included), while still letting COA generation and
-- reporting query for real posting accounts only.
--
-- Before this migration, balanceSheetExtractionService's filterRowsBeforeInsertion
-- silently dropped structural heading rows (hierarchy_level=0) and
-- total/subtotal/metadata rows (keyword-matched) before they ever reached
-- this table -- e.g. a 66-row uploaded document could persist as few as 24
-- rows. Source-document fidelity requires every row to survive; only the
-- separate chart_of_accounts table (posting accounts + categories) excludes
-- non-account rows, per the existing COA architecture.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.

ALTER TABLE balance_sheet_entries
  ADD COLUMN IF NOT EXISTS row_type text
    CHECK (row_type IN ('account', 'heading', 'subtotal', 'total', 'metadata', 'footer', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_row_type
  ON balance_sheet_entries(version_id, row_type);

COMMENT ON COLUMN balance_sheet_entries.row_type IS
  'Classifies every persisted source row: account (real posting line), heading (structural section/group label), subtotal ("Total for X" rollup), total (statement-level total), metadata (report header text like "Accrual Basis"), footer, or unknown. Every uploaded row is persisted regardless of row_type -- COA generation reads only row_type=account.';
