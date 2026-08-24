-- ============================================================================
-- Migration 048: Key Reports Validation Results
--
-- Purpose:
--   Persist per-version validation output for the Key Reports dashboard while
--   also enriching file mappings with a derived year/status so the dashboard can
--   show a stable year matrix.
--
-- This migration is idempotent: safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS key_report_file_mappings
  ADD COLUMN IF NOT EXISTS year integer;

ALTER TABLE IF EXISTS key_report_file_mappings
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'linked';

CREATE INDEX IF NOT EXISTS idx_key_report_file_mappings_version_year
  ON key_report_file_mappings(version_id, year);

CREATE TABLE IF NOT EXISTS key_report_validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  data_type text NOT NULL,
  year integer,
  status text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_key_report_validation_results_version
  ON key_report_validation_results(version_id, year, data_type);

CREATE INDEX IF NOT EXISTS idx_key_report_validation_results_company
  ON key_report_validation_results(company_id, created_at DESC);
