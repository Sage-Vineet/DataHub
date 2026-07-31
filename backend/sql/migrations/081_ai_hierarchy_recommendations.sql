-- AI Hierarchy Recommendation Engine — advisory-only optimization layer that
-- runs AFTER the deterministic Chart of Accounts has been fully generated
-- and validated.
--
-- This table stores SUGGESTIONS only. Nothing here is ever read by report
-- generation (Trial Balance / Balance Sheet / P&L / Cash Flow all read
-- chart_of_accounts directly, exactly as before this feature existed). A
-- recommendation only ever affects chart_of_accounts when a user explicitly
-- accepts it — and even then, only through the existing
-- chartOfAccountsService.updateAccountHierarchy() path (the same one the
-- "Edit Chart of Accounts" grid already uses for manual edits), which only
-- ever touches level_1..level_15/hierarchy_path/base_account and marks the
-- row user_modified — it never touches account_type, statement_type,
-- balances, or GL mappings.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS key_report_coa_hierarchy_recommendations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id          uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL,
  account_id          uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,

  -- Snapshot of the account's real, generated hierarchy at the moment this
  -- recommendation was produced (level_1..level_N, non-null values only,
  -- including the account's own name as the last entry) — for display and
  -- for detecting whether the COA has moved on since this was suggested.
  current_hierarchy   jsonb NOT NULL,

  -- The new intermediate roll-up label the AI suggests inserting, and the
  -- existing hierarchy label it should be inserted under. Both are plain
  -- text describing a HIERARCHY change only — never an account type or
  -- statement type.
  recommended_rollup  text NOT NULL,
  recommended_parent  text,

  confidence          numeric,
  reason              text,

  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'ignored')),

  decided_at          timestamptz,
  decided_by          uuid,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- One recommendation per (account, suggested rollup) per version — lets a
  -- re-sync's fresh recommendation pass upsert onto the same row instead of
  -- duplicating, while never touching a row the user already decided on
  -- (accepted/ignored) unless it's regenerated from scratch by the caller.
  UNIQUE (version_id, account_id, recommended_rollup)
);

CREATE INDEX IF NOT EXISTS idx_coa_hier_reco_version
  ON key_report_coa_hierarchy_recommendations(version_id);

CREATE INDEX IF NOT EXISTS idx_coa_hier_reco_status
  ON key_report_coa_hierarchy_recommendations(version_id, status);
