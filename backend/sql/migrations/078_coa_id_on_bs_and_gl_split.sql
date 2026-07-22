-- ============================================================================
-- Migration 078: coa_id on balance_sheet_entries, split_coa_id on GL entries
--
-- Purpose: close the last two gaps that force report code to re-resolve an
-- account's Chart of Accounts identity by NAME at every read instead of
-- reading a stored link:
--
--   1. balance_sheet_entries has no coa_id at all (general_ledger_entries got
--      one in migration 060). Every reader that wants a BS row's account_type/
--      hierarchy has to re-match account_name against chart_of_accounts.
--   2. general_ledger_entries.coa_id (migration 060) is only ever resolved
--      from the row's own account_name — never from split_account (the OTHER
--      side of the same journal entry, e.g. "80950 Operational Expense:
--      Background Check"). Report code re-derives this via suffix string
--      matching (canonicalSplitIdentity) on every call.
--
-- Both are nullable FKs, populated by linkGlToCoa (split_coa_id) and the new
-- linkBsToCoa (coa_id) — never inferred at report-read time.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE balance_sheet_entries
  ADD COLUMN IF NOT EXISTS coa_id uuid
    REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bs_entries_coa_id
  ON balance_sheet_entries(version_id, coa_id)
  WHERE coa_id IS NOT NULL;

ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS split_coa_id uuid
    REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gl_entries_split_coa_id
  ON general_ledger_entries(version_id, split_coa_id)
  WHERE split_coa_id IS NOT NULL;
