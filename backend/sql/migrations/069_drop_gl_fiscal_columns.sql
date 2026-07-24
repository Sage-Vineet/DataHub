-- ============================================================================
-- Migration 069: Drop fiscal_year/fiscal_month from general_ledger_entries
--               (client Date Architecture Refactor — date_dimension only)
--
-- Purpose:
--   Complete the date_dimension refactor (migration 067) by removing the
--   denormalized fiscal_year/fiscal_month columns from general_ledger_entries.
--   Every report/aggregation/filter that used them has been rewritten to use
--   transaction_date directly (for filtering — robust, never depends on a join
--   succeeding) and the key_report_date_dimension join (for sourcing
--   year/month/quarter/month_name in report output).
--
-- IMPORTANT — read before applying:
--   Two classes of existing rows have historically been able to carry
--   fiscal_year with a NULL transaction_date, and would lose their year
--   association entirely once fiscal_year is dropped, unless backfilled first:
--     1. BEGINNING_BALANCE / TOTAL_ROW rows — bookkeeping rows with no real
--        calendar date (extractor previously tagged them via fiscal_year only).
--     2. Manual journal entries / year-end adjustment rows — see
--        financialStatementService.loadGlAmountsYearly's original docstring;
--        this was a known, previously-encountered production scenario.
--   Step 1 below backfills a sentinel transaction_date (fiscal_year-06-30,
--   mid-year — we don't know the true date) for any such row BEFORE the
--   column is dropped, so no row silently disappears from year-filtered
--   reports. New rows can no longer have this gap: validateRows() in
--   generalLedgerExtractionService.js rejects any dateless TRANSACTION row at
--   extraction time, and the extractor now stamps BEGINNING_BALANCE (Jan 1)
--   and TOTAL_ROW (Dec 31) with a real sentinel date of their own.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

-- ── 1. Backfill: any row with fiscal_year set but transaction_date NULL ──────
-- (covers historical BEGINNING_BALANCE/TOTAL_ROW rows and any dateless
-- manual-entry/adjustment rows from before validateRows() enforced a date).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'fiscal_year'
  ) THEN
    UPDATE general_ledger_entries
       SET transaction_date = make_date(fiscal_year, 6, 30)
     WHERE transaction_date IS NULL
       AND fiscal_year IS NOT NULL;
  END IF;
END $$;

-- ── 2. Drop indexes that reference the columns being dropped ─────────────────
DROP INDEX IF EXISTS idx_general_ledger_entries_version_year;   -- migration 049
DROP INDEX IF EXISTS idx_general_ledger_entries_fiscal_year;    -- migration 063
DROP INDEX IF EXISTS idx_gl_entries_fiscal_month;               -- migration 060

-- ── 3. Drop the columns ───────────────────────────────────────────────────────
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS fiscal_year;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS fiscal_month;

-- ── 4. Confirm the replacement index already exists (added by migration 049,
--       idx_general_ledger_entries_date on (version_id, transaction_date); and
--       migration 067's idx_gl_entries_date_id on (version_id, date_id)) — no
--       new index needed here.
