-- ============================================================================
-- Migration 070: Add cf_category to chart_of_accounts
--               (Client COA Architecture Refactor — Cash Flow bucket tagging)
--
-- Purpose:
--   Cash Flow generation currently buckets accounts into Operating / Investing
--   / Financing by matching the account NAME against regex keyword lists at
--   report-render time (financialStatementService.generateMonthlyCf /
--   generateMonthlyCfFromBSDeltas). This adds a column so that decision is made
--   ONCE, at Chart of Accounts classification time — the same pattern already
--   used for level_1..level_15 — and every Cash Flow report reads the stored
--   value instead of re-deriving it.
--
--   NULL means either "not yet backfilled" or "excluded from Cash Flow deltas"
--   (cash/bank accounts themselves, and income/expense accounts, which don't
--   participate in the balance-sheet-delta Cash Flow build). Callers must not
--   treat NULL as an error — see cfCategoryRules.classifyCfCategory.
--
-- Additive only: nullable column, no drops, no backfill required before use
-- (chartOfAccountsService recomputes cf_category for every account on the next
-- regenerate/sync; existing rows keep NULL until then, and report code already
-- has to handle NULL as "not classified").
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS cf_category text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chart_of_accounts_cf_category_check'
  ) THEN
    ALTER TABLE chart_of_accounts
      ADD CONSTRAINT chart_of_accounts_cf_category_check
      CHECK (cf_category IS NULL OR cf_category IN ('operating', 'investing', 'financing'));
  END IF;
END $$;

COMMENT ON COLUMN chart_of_accounts.cf_category IS
  'Cash Flow statement bucket (operating/investing/financing) for this account, assigned once at COA classification time by cfCategoryRules.classifyCfCategory. NULL = cash/bank account (excluded from CF deltas) or not yet backfilled.';
