-- ============================================================================
-- Migration 052: Chart of Accounts — system_id (the client's "System ID" column)
--
-- Purpose:
--   Add the human-facing per-account identifier the client's Chart of Accounts
--   template uses (INC-001 / EXP-001 / BS-001 …). It sits beside account_number
--   (which is the source/GL number and is frequently blank) and is assigned by
--   chartOfAccountsService at generate time, stable across regenerations.
--
-- PREREQUISITE: migrations 047 (chart_of_accounts) and 051 (15-level hierarchy +
--   original/adjusted + audit model) must already be applied. If 051 was never
--   applied, COA inserts fail on the missing level_*/original_*/adjusted_* columns
--   and nothing persists — apply 051 first.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor (there is no
-- migration runner in this project).
-- ============================================================================

ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS system_id text;

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_system_id
  ON chart_of_accounts(version_id, system_id);
