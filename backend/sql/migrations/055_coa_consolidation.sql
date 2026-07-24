-- ============================================================================
-- Migration 055: Chart of Accounts consolidation
--
-- Purpose (client request, 6/25 email):
--   "I do not need the Chart of accounts mapping, adjustments or classification
--    tables if they are set up with the same table intended for the chart of
--    accounts table."
--
--   Fold the four COA side tables into chart_of_accounts and remove them:
--     • coa_account_mappings      → the COA leaf rows ARE the source→account name
--                                    map; the report layer rebuilds it in memory.
--     • coa_account_adjustments   → chart_of_accounts.audit_log (jsonb)
--     • coa_classification_history→ chart_of_accounts.audit_log (jsonb)
--     • coa_hierarchy_levels      → static taxonomy in chartOfAccountsService.js
--                                    (kept in lock-step with coaHierarchyRules.js)
--
--   audit_log entries:
--     { kind:"classification", at, method, hierarchy_snapshot, source, by }
--     { kind:"adjustment",     at, field_changed, old_value, new_value, by }
--
-- PREREQUISITES: migrations 047/051/052/053 applied. The application code that
--   read/wrote these four tables (chartOfAccountsService.js,
--   financialStatementService.js) has already been repointed to audit_log /
--   in-memory mapping, so the DROPs below are safe.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

-- 1) Inline audit history column on chart_of_accounts.
ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS audit_log jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2) Drop the four consolidated side tables (CASCADE clears their indexes/FKs).
DROP TABLE IF EXISTS coa_account_mappings      CASCADE;
DROP TABLE IF EXISTS coa_account_adjustments   CASCADE;
DROP TABLE IF EXISTS coa_classification_history CASCADE;
DROP TABLE IF EXISTS coa_hierarchy_levels      CASCADE;

COMMENT ON COLUMN chart_of_accounts.audit_log IS
  'Inline classification + adjustment audit trail (replaces coa_account_adjustments / coa_classification_history). Array of {kind, at, ...}.';
