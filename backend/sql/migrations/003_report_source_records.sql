-- Migration: Company report source selector records
-- Purpose: Keep exactly two source records per company for Reports page selection
-- Date: 2026-05-07

CREATE TABLE IF NOT EXISTS report_source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  source_label text NOT NULL,
  is_selected boolean NOT NULL DEFAULT false,
  is_available boolean NOT NULL DEFAULT false,
  is_connected boolean NOT NULL DEFAULT false,
  last_connected_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_report_source_records UNIQUE (company_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_report_source_records_company
  ON report_source_records(company_id);

CREATE INDEX IF NOT EXISTS idx_report_source_records_selected
  ON report_source_records(company_id, is_selected);
