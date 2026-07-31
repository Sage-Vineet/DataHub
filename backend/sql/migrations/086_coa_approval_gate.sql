-- ============================================================================
-- Migration 086: COA approval gate (key_report_versions.coa_approved_at)
--
-- Part of the Key Reports canonical-workflow refactor: the Chart of Accounts
-- a sync generates is now a PROPOSAL only (built in-memory by
-- chartOfAccountsService.buildProposedCoaTree, never written to
-- chart_of_accounts) until the user explicitly reviews and Saves it
-- (chartOfAccountsService.persistApprovedCoaTree). No report generation
-- (Trial Balance, Reconciliation, Monthly Balance Sheets, P&L/Cash Flow/
-- Balance Sheet snapshots) may run before that Save succeeds.
--
-- key_report_versions.coa_approved_at is a single nullable marker on the
-- VERSION (not a status column on chart_of_accounts itself -- there is and
-- was no "approval_status" on chart_of_accounts, and this migration does not
-- add one). Set when persistApprovedCoaTree completes successfully; cleared
-- whenever a new sync produces a fresh proposal that supersedes it (a new
-- proposal always requires a fresh Save before reports can run again). Gates:
--   a) PATCH /chart-of-accounts/:accountId -- a single-account hand-edit is
--      only meaningful against an already-approved COA; before the first
--      Save, edits belong to the frontend's in-memory proposal review, not a
--      persisted row.
--   b) The frontend's "Open Reports" action.
--
-- NOTE on transactional persistence: persistApprovedCoaTree's writes are
-- multiple sequential Supabase (PostgREST) calls, not one server-side
-- transaction -- the Supabase JS client has no multi-statement client-side
-- transaction primitive, and moving the existing category/leaf write logic's
-- classification/audit_log/cf_category/system_id business rules into a
-- plpgsql function would duplicate that logic in a second language, which is
-- a real correctness risk for a financial-statement pipeline and was
-- deliberately rejected. Instead, persistApprovedCoaTree wraps its writes in
-- a compensating-rollback guard (chartOfAccountsService.js): every insert's
-- new id, every update's pre-image, and every stale-delete's pre-image is
-- captured before the write, and reversed, best-effort, in reverse order if
-- any later step throws. This is not full ACID atomicity, but it means a
-- failure partway through never silently leaves a half-generated COA marked
-- approved -- see persistApprovedCoaTree's own doc comment for the exact
-- guarantee.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor (there
-- is no migration runner in this project).
-- ============================================================================

ALTER TABLE key_report_versions
  ADD COLUMN IF NOT EXISTS coa_approved_at timestamptz NULL;

COMMENT ON COLUMN key_report_versions.coa_approved_at IS
  'Set when the user''s reviewed Chart of Accounts proposal was successfully '
  'persisted (chartOfAccountsService.persistApprovedCoaTree). NULL means the '
  'version has no approved COA yet -- report generation, single-account COA '
  'edits, and viewing Reports are all gated on this being set. Cleared '
  'whenever a new sync produces a fresh proposal.';
