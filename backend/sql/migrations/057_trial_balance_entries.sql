-- ============================================================================
-- Migration 057: trial_balance_entries (generated from the General Ledger)
--
-- Purpose (client Data Table WF — Phase 3):
--   Store a Trial Balance generated DIRECTLY from general_ledger_entries (never
--   from uploaded reports). One row per account per fiscal year with:
--     total_debits, total_credits, net_balance, opening_balance, closing_balance.
--
--   Generated + stored during sync by
--   keyReportAccountingService.generateTrialBalance.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS trial_balance_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  fiscal_year integer NOT NULL,
  account_name text NOT NULL,
  account_number text,
  account_type text,                       -- from the Chart of Accounts dimension

  total_debits   numeric(18, 2) NOT NULL DEFAULT 0,
  total_credits  numeric(18, 2) NOT NULL DEFAULT 0,
  net_balance    numeric(18, 2) NOT NULL DEFAULT 0,   -- debits - credits
  opening_balance numeric(18, 2) NOT NULL DEFAULT 0,
  closing_balance numeric(18, 2) NOT NULL DEFAULT 0,  -- opening + net

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trial_balance_entries_version_year
  ON trial_balance_entries(version_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_trial_balance_entries_company
  ON trial_balance_entries(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_balance_entries_account
  ON trial_balance_entries(version_id, account_name);

COMMENT ON TABLE trial_balance_entries IS
  'Trial Balance generated from general_ledger_entries (never from uploaded reports), version-scoped.';
