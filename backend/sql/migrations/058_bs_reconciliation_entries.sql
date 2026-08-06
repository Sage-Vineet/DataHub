-- ============================================================================
-- Migration 058: bs_reconciliation_entries (generated vs uploaded ending BS)
--
-- Purpose (client Data Table WF — Phase 5):
--   When an Ending Balance Sheet has been uploaded, reconcile the GENERATED
--   ending Balance Sheet (the authoritative monthly roll-forward) against it.
--   Stores per-account: generated balance, uploaded balance, variance, and a
--   status (match | difference | missing_in_generated | missing_in_uploaded).
--
--   Reconciliation NEVER overwrites generated balances — it is a separate,
--   read-only comparison stored here.
--
-- Generated + stored during sync by
--   keyReportAccountingService.generateReconciliation (only when an ending BS exists).
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS bs_reconciliation_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  fiscal_year integer NOT NULL,
  account_name text NOT NULL,
  account_type text,
  section text,

  generated_balance numeric(18, 2) NOT NULL DEFAULT 0,
  uploaded_balance  numeric(18, 2) NOT NULL DEFAULT 0,
  variance          numeric(18, 2) NOT NULL DEFAULT 0,   -- generated - uploaded

  status text NOT NULL,            -- match | difference | missing_in_generated | missing_in_uploaded
  needs_review boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bs_reconciliation_entries_version_year
  ON bs_reconciliation_entries(version_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_bs_reconciliation_entries_company
  ON bs_reconciliation_entries(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bs_reconciliation_entries_status
  ON bs_reconciliation_entries(version_id, status);

COMMENT ON TABLE bs_reconciliation_entries IS
  'Reconciliation of the generated ending Balance Sheet against the uploaded ending Balance Sheet, version-scoped. Never overwrites generated balances.';
