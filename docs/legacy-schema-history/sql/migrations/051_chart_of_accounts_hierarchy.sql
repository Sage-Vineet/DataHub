-- ============================================================================
-- Migration 051: Chart of Accounts — 15-level hierarchy + audit model
--
-- Purpose:
--   Evolve the Chart of Accounts (COA) from a shallow 2-level group→leaf model
--   (migration 047) into the client's deep hierarchy: up to 15 standardized +
--   company-specific levels, with a never-overwritten ORIGINAL (AI) classification
--   alongside a user-editable ADJUSTED one, plus full audit history.
--
--   The COA becomes the single source of truth for downstream financial features.
--
-- This migration:
--   1. Extends chart_of_accounts (047) with level_1..15, base_account,
--      hierarchy_path, account_id_name, classification_method, and the
--      original/adjusted name + hierarchy pairs.
--   2. Adds the four supporting tables the client named:
--        coa_hierarchy_levels    (HierarchyLevels  — standardized taxonomy seed)
--        coa_account_mappings    (AccountMappings  — source account → COA node)
--        coa_account_adjustments (AccountAdjustments — per-edit audit)
--        coa_classification_history (ClassificationHistory — append-only audit)
--   3. Seeds coa_hierarchy_levels with the standardized levels 1–3 taxonomy.
--
-- PREREQUISITE: migration 047 (chart_of_accounts) must already be applied.
-- This migration is idempotent: safe to re-run. Hand-apply via the Supabase SQL
-- editor (there is no migration runner in this project).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) Extend chart_of_accounts with the 15-level + original/adjusted model.
--    All columns are nullable / additive so existing rows and the legacy
--    2-level reader keep working until they are regenerated.
-- ----------------------------------------------------------------------------
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_1  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_2  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_3  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_4  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_5  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_6  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_7  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_8  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_9  text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_10 text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_11 text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_12 text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_13 text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_14 text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS level_15 text;

-- The source (leaf) account name, sitting at the deepest used level.
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS base_account text;
-- Human-readable "L1 > L2 > … > base" path (denormalized for display/search).
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS hierarchy_path text;
-- Combined "account_number — account_name" identifier.
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS account_id_name text;
-- rule | gemini | hybrid | manual
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS classification_method text;

-- Original AI classification — written once at generate time, NEVER overwritten
-- by user edits or regeneration. The audit/restore baseline.
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS original_name text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS original_hierarchy jsonb;
-- Adjusted (current) classification — what the user sees and edits.
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS adjusted_name text;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS adjusted_hierarchy jsonb;

-- Fast filter for the "modified vs unmodified" UI view.
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_method
  ON chart_of_accounts(version_id, classification_method);

-- ----------------------------------------------------------------------------
-- 2) coa_hierarchy_levels (HierarchyLevels) — reference taxonomy.
--    Seeds the standardized labels (levels 1–3) that stay constant across all
--    companies; drives UI level filters and the rule classifier's vocabulary.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coa_hierarchy_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level_number integer NOT NULL,          -- 1..15
  statement_type text,                    -- balance_sheet | profit_loss | NULL (both)
  parent_label text,                      -- the level-(n-1) label this rolls up under
  label text NOT NULL,                    -- the standardized label at this level
  sort_order integer NOT NULL DEFAULT 0,
  is_standard boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_coa_hierarchy_levels UNIQUE (level_number, statement_type, parent_label, label)
);

CREATE INDEX IF NOT EXISTS idx_coa_hierarchy_levels_lookup
  ON coa_hierarchy_levels(level_number, statement_type);

-- ----------------------------------------------------------------------------
-- 3) coa_account_mappings (AccountMappings) — source account → COA node.
--    The join the report layer (Phase D) uses to classify a raw extracted
--    account name/number against the saved COA, scoped per version.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coa_account_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id uuid REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  source_table text NOT NULL,             -- profit_loss_entries | balance_sheet_entries | general_ledger_entries
  source_account_name text NOT NULL,
  source_account_number text,
  normalized_name text NOT NULL,          -- lower/trimmed name for fast joins
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_coa_account_mappings
    UNIQUE (version_id, source_table, normalized_name, source_account_number)
);

CREATE INDEX IF NOT EXISTS idx_coa_account_mappings_lookup
  ON coa_account_mappings(version_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_coa_account_mappings_account
  ON coa_account_mappings(account_id);

-- ----------------------------------------------------------------------------
-- 4) coa_account_adjustments (AccountAdjustments) — per-edit audit trail.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coa_account_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  field_changed text NOT NULL,            -- name | parent | level | reclassify | active
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,                        -- users.id (no FK — users table varies by role)
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coa_account_adjustments_account
  ON coa_account_adjustments(account_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_coa_account_adjustments_version
  ON coa_account_adjustments(version_id, changed_at DESC);

-- ----------------------------------------------------------------------------
-- 5) coa_classification_history (ClassificationHistory) — append-only.
--    One row each time an account is (re)classified: at generate time (AI) and
--    on every user adjustment, snapshotting the resulting hierarchy.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coa_classification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  classification_method text,             -- rule | gemini | hybrid | manual
  hierarchy_snapshot jsonb,               -- { level_1..15, base_account, account_type, statement_type }
  source text,                            -- generate | adjust | reset
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coa_classification_history_account
  ON coa_classification_history(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coa_classification_history_version
  ON coa_classification_history(version_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 6) Seed the standardized taxonomy as the client's BOTTOM-UP financial ROLLUP
--    (matches chartOfAccountsService / coaHierarchyRules). Reseeds the standard
--    rows so re-running this migration replaces an older taxonomy. Idempotent.
-- ----------------------------------------------------------------------------
DELETE FROM coa_hierarchy_levels WHERE is_standard = true;

INSERT INTO coa_hierarchy_levels (level_number, statement_type, parent_label, label, sort_order) VALUES
  -- Level 1 — rollup heads
  (1, 'balance_sheet', NULL, 'Total Liabilities and Equity', 1),
  (1, 'balance_sheet', NULL, 'Total Assets',                 2),
  -- Level 2
  (2, 'balance_sheet', 'Total Assets',                 'Total Assets',      1),
  (2, 'balance_sheet', 'Total Liabilities and Equity', 'Total Liabilities', 2),
  (2, 'balance_sheet', 'Total Liabilities and Equity', 'Total Equity',      3),
  -- Level 3
  (3, 'profit_loss',   'Total Equity', 'Net Income',            1),
  (3, 'balance_sheet', 'Total Equity', 'Equity',                2),
  (3, 'balance_sheet', 'Total Assets', 'Current Assets',        3),
  (3, 'balance_sheet', 'Total Assets', 'Fixed Assets',          4),
  (3, 'balance_sheet', 'Total Assets', 'Other Assets',          5),
  (3, 'balance_sheet', 'Total Liabilities', 'Current Liabilities',   6),
  (3, 'balance_sheet', 'Total Liabilities', 'Long-Term Liabilities', 7),
  -- Levels 4–8 — the P&L rollup chain
  (4, 'profit_loss', 'Net Income',       'Pretax Income',    1),
  (5, 'profit_loss', 'Pretax Income',    'Operating Income', 1),
  (6, 'profit_loss', 'Operating Income', 'Gross Profit',     1),
  (7, 'profit_loss', 'Gross Profit',     'Total Revenue',    1),
  (7, 'profit_loss', 'Gross Profit',     'Total Expenses',   2),
  (8, 'profit_loss', 'Total Revenue',    'Income',           1),
  (8, 'profit_loss', 'Total Expenses',   'Expenses',         2),
  -- Level 9 — company expense groups
  (9, 'profit_loss', 'Expenses', 'Payroll and Labor',          1),
  (9, 'profit_loss', 'Expenses', 'Cost of Sales',              2),
  (9, 'profit_loss', 'Expenses', 'Occupancy',                  3),
  (9, 'profit_loss', 'Expenses', 'Insurance',                  4),
  (9, 'profit_loss', 'Expenses', 'Sales and Marketing',        5),
  (9, 'profit_loss', 'Expenses', 'General and Administrative', 6),
  (9, 'profit_loss', 'Expenses', 'Vehicle and Travel',         7),
  (9, 'profit_loss', 'Expenses', 'Repairs and Maintenance',    8),
  (9, 'profit_loss', 'Expenses', 'Non-Cash and Below-Line',    9)
ON CONFLICT ON CONSTRAINT uq_coa_hierarchy_levels DO NOTHING;
