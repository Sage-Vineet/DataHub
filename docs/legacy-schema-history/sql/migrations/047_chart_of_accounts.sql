-- ============================================================================
-- Migration 047: Chart of Accounts (Key Reports Rearchitecture — M2)
--
-- Purpose:
--   Persist a per-version Chart of Accounts (COA) hierarchy built by the Sync
--   engine from a version's linked P&L / GL / Balance Sheet data. The COA is the
--   normalized account directory the client requested (Phase 10): a parent/child
--   structure (e.g. Revenue -> Sales Revenue, Assets -> Cash) that is exposed for
--   review and future editing.
--
-- Design notes:
--   * version_id references key_report_versions(id) — the version container the
--     Sync engine actually produces. The COA is regenerated on every sync and is
--     therefore CASCADE-deleted with its version.
--   * parent_account_id is a self-referential FK (SET NULL) so deleting a parent
--     group node never orphans a delete cascade; children become top-level.
--   * statement_type is derived (balance_sheet | profit_loss) so report consumers
--     can slice the COA without re-classifying.
--   * Group nodes (Assets, Revenue, ...) are rows with account_number = NULL and
--     metadata->>'is_group' = 'true'. Leaf accounts point at their group via
--     parent_account_id.
--
-- This migration is idempotent: safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_number text,
  account_name text NOT NULL,
  parent_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  -- asset | liability | equity | income | cogs | expense  (group nodes use the
  -- group's underlying type; leaf accounts use their classified type)
  account_type text,
  -- balance_sheet | profit_loss
  statement_type text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One logical account per version. account_number is NULLable; NULLs are
  -- distinct in a UNIQUE index, so group nodes (number = NULL) never collide.
  CONSTRAINT uq_chart_of_accounts_version_account
    UNIQUE (version_id, account_number, account_name)
);

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_version
  ON chart_of_accounts(version_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_company
  ON chart_of_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_parent
  ON chart_of_accounts(parent_account_id);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_statement
  ON chart_of_accounts(version_id, statement_type, account_type);
