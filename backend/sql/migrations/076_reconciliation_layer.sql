-- ============================================================================
-- Migration 076: Mandatory Financial Reconciliation Layer
--
-- Purpose: move Balance Sheet + Profit & Loss reconciliation BEFORE Monthly
-- Balance Sheet / Monthly P&L / Cash Flow generation (previously reconciliation
-- ran AFTER those reports were already generated and persisted — see the
-- pipeline redesign this migration supports).
--
--   1. bs_reconciliation_entries (migration 058) — ADDITIVE change only:
--        + percentage_difference numeric
--      Status vocabulary changes from lowercase (match/difference/
--      missing_in_generated/missing_in_uploaded) to MATCHED/DIFFERENCE/
--      MISSING_FROM_GL/MISSING_FROM_BS/EXCLUDED — a safe rename, confirmed
--      via codebase search that this table has ZERO frontend consumers today
--      (the /reports/reconciliation route exists but nothing in src/ calls it
--      yet). Existing rows are not backfilled/rewritten by this migration —
--      the table is fully regenerated on every sync (see generateReconciliation),
--      so old rows are naturally replaced on the next sync of each version.
--
--   2. pl_reconciliation_entries (NEW) — mirrors bs_reconciliation_entries'
--      exact shape/conventions. Persists what accountLevelReconciliationDiff
--      (keyReportSyncService.js) already computes — account-by-account
--      uploaded-vs-GL-derived P&L amounts with a reason code — which today
--      only lives transiently inside a key_report_validation_results row's
--      metadata JSONB with no durable per-account audit trail. Also stores
--      subtotal rollup rows (Revenue/COGS/Gross Profit/Operating Expenses/
--      Other Income/Other Expense/Net Income), flagged via is_subtotal.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE bs_reconciliation_entries
  ADD COLUMN IF NOT EXISTS percentage_difference numeric(9, 4);

COMMENT ON COLUMN bs_reconciliation_entries.status IS
  'MATCHED | DIFFERENCE | MISSING_FROM_GL | MISSING_FROM_BS | EXCLUDED';
COMMENT ON COLUMN bs_reconciliation_entries.percentage_difference IS
  'variance / uploaded_balance * 100, null when uploaded_balance is 0 and generated_balance is also 0 (nothing to divide by)';

CREATE TABLE IF NOT EXISTS pl_reconciliation_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  fiscal_year integer NOT NULL,
  account_name text NOT NULL,
  account_type text,
  section text,

  generated_amount numeric(18, 2) NOT NULL DEFAULT 0,
  uploaded_amount  numeric(18, 2) NOT NULL DEFAULT 0,
  variance         numeric(18, 2) NOT NULL DEFAULT 0,   -- generated - uploaded
  percentage_difference numeric(9, 4),

  -- missing_in_gl | missing_in_uploaded | classification_mismatch |
  -- unknown_account | sign_issue | amount_difference — same vocabulary as
  -- accountLevelReconciliationDiff (keyReportSyncService.js)
  reason text,

  -- MATCHED | DIFFERENCE | MISSING_FROM_GL | MISSING_FROM_BS | EXCLUDED —
  -- same vocabulary as bs_reconciliation_entries.status
  status text NOT NULL,
  needs_review boolean NOT NULL DEFAULT false,

  -- true for a section/subtotal row (e.g. "Total Revenue", "Gross Profit",
  -- "Net Income") rather than an individual GL account — lets account-level
  -- and section-level comparisons live in one consistent table.
  is_subtotal boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pl_reconciliation_entries_version_year
  ON pl_reconciliation_entries(version_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_pl_reconciliation_entries_company
  ON pl_reconciliation_entries(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pl_reconciliation_entries_status
  ON pl_reconciliation_entries(version_id, status);

COMMENT ON TABLE pl_reconciliation_entries IS
  'Reconciliation of the GL-generated Profit & Loss against the uploaded Profit & Loss, version-scoped, account + subtotal level. Never overwrites generated reports.';
