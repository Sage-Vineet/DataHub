-- ============================================================================
-- Migration 082: chart_of_accounts.node_type (header | group | account)
--
-- Adds a real, queryable 3-way structural-role column, derived directly from
-- the two columns that are ALREADY the single source of truth for that role
-- (metadata->>'is_group', parent_account_id) — a STORED GENERATED column, not
-- one the application sets. This means every existing writer
-- (generateChartOfAccounts, ensureCoaComplete, syncCategoryNodes/
-- persistCoaNodeTree, updateAccountHierarchy, resetAccount) needs ZERO code
-- changes to keep it correct, and it is IMPOSSIBLE for it to drift out of
-- sync — Postgres recomputes it on every INSERT/UPDATE.
--
-- header  = root category  (is_group=true,  parent_account_id IS NULL)
-- group   = intermediate category (is_group=true, has a parent)
-- account = real posting leaf (is_group=false/absent)
--
-- Backward compatible: purely additive. metadata->>'is_group' remains the
-- field every existing report-generation reader already checks
-- (financialStatementService.buildTree/rollupNode, keyReportAccountingService,
-- keyReportReportService) — none of those call sites are touched by this
-- migration or the refactor it's part of.
--
-- IMPORTANT for implementers: a STORED GENERATED column cannot be written to.
-- Never include `node_type` in an insert/update payload; never spread a
-- `select("*")`-fetched row directly into an insert/update call (chart-of-
-- accounts service code today never does this — keep it that way).
--
-- Deliberately NOT included here: a uniqueness constraint on
-- (version_id, parent_account_id, lower(account_name)). Production likely has
-- pre-existing duplicate category rows (the historical "937 nodes for 63
-- leaves" incident) — a UNIQUE INDEX over data that already violates it would
-- fail outright. That cleanup + constraint is a deliberate follow-up
-- migration, sequenced after the new dedup logic has converged existing
-- versions on their next regen.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS node_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN coalesce((metadata->>'is_group')::boolean, false) = false THEN 'account'
      WHEN parent_account_id IS NULL THEN 'header'
      ELSE 'group'
    END
  ) STORED;

ALTER TABLE chart_of_accounts
  DROP CONSTRAINT IF EXISTS chk_chart_of_accounts_node_type;
ALTER TABLE chart_of_accounts
  ADD CONSTRAINT chk_chart_of_accounts_node_type CHECK (node_type IN ('header', 'group', 'account'));

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_node_type
  ON chart_of_accounts(version_id, node_type);

COMMENT ON COLUMN chart_of_accounts.node_type IS
  'Structural role, generated from metadata.is_group + parent_account_id. '
  'header = root category (is_group, no parent); group = intermediate '
  'category (is_group, has a parent); account = real posting leaf. '
  'Never set by application code — recomputed automatically by Postgres.';
