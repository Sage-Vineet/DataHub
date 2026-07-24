-- ============================================================================
-- Migration 063: Backfill general_ledger_entries.fiscal_year from transaction_date
--
-- Purpose:
--   Repair the root cause of the "final fiscal year is missing from generated
--   reports" defect.
--
--   Since migration 050 made fiscal_year nullable, GL transaction rows could be
--   persisted with a NULL fiscal_year while still carrying a valid
--   transaction_date (a date-parse path that set the date column but not the
--   year, or rows imported before fiscal_year was reliably populated).
--
--   The report RENDERERS recover those years via a transaction_date fallback
--   (resolveYears / fetchAllGLRows), but the GENERATION year-bounds
--   (glYearRange → gate.glStartYear/glEndYear) ignored NULL-fiscal_year rows.
--   Any year that existed ONLY in NULL-fiscal_year rows — typically the last
--   uploaded year — was therefore silently dropped from the generated Trial
--   Balance, Monthly Balance Sheet and P&L validation rows.
--
--   This migration sets fiscal_year = year-of(transaction_date) for every
--   TRANSACTION-type row that has a date but no year, so existing data matches
--   what the extractor now guarantees for new syncs
--   (generalLedgerExtractionService.transformRows). fiscal_month is also filled
--   where derivable.
--
-- Generic: no company / year / account hardcoding. Idempotent: re-running only
-- touches rows that still have a NULL fiscal_year with a non-NULL date.
-- ============================================================================

-- 1. Backfill fiscal_year from the year component of transaction_date.
UPDATE general_ledger_entries
   SET fiscal_year = EXTRACT(YEAR FROM transaction_date)::int
 WHERE fiscal_year IS NULL
   AND transaction_date IS NOT NULL;

-- 2. Backfill fiscal_month where it is missing but derivable (best-effort).
UPDATE general_ledger_entries
   SET fiscal_month = EXTRACT(MONTH FROM transaction_date)::int
 WHERE fiscal_month IS NULL
   AND transaction_date IS NOT NULL;

-- ── Supporting index ─────────────────────────────────────────────────────────
-- fiscal_year is the primary grouping key for every per-year report generator.
CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_fiscal_year
  ON general_ledger_entries(version_id, fiscal_year);

COMMENT ON COLUMN general_ledger_entries.fiscal_year IS
  'Fiscal year of the row. For dated TRANSACTION rows this is always populated '
  '(derived from transaction_date when the source did not provide it) so the '
  'report generators never drop a year that exists only in date-only rows.';
