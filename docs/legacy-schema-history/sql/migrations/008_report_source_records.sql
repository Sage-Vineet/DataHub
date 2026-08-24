-- Migration: Report source records tracking table
-- Purpose: Track per-source state (availability, connection, selection) for each company.
--          Also ensures companies table has the source-switching audit columns added by
--          migration 006 in case that migration was not yet applied to this database.
-- Date: 2026-05-12

-- Ensure companies has all source-switching columns (idempotent if 006 already ran)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS data_source_type text,
  ADD COLUMN IF NOT EXISTS quickbooks_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_upload_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_source_switch_at timestamptz;

-- Normalize any legacy data_source_type values
UPDATE companies
SET data_source_type = 'quickbooks_online'
WHERE lower(coalesce(data_source_type, '')) = 'quickbooks';

UPDATE companies
SET data_source_type = 'manual_gl_upload'
WHERE lower(coalesce(data_source_type, '')) IN ('manual_upload', 'manual_gl');

-- Add the check constraint if it does not already exist
DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_data_source_type
    CHECK (
      data_source_type IS NULL
      OR data_source_type IN (
        'quickbooks_online',
        'manual_gl_upload',
        'quickbooks',
        'manual_upload'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create report_source_records table
-- One row per (company, source_key) pair; exactly one row per company should have is_selected = true.
CREATE TABLE IF NOT EXISTS report_source_records (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_key    text        NOT NULL,
  source_label  text        NOT NULL DEFAULT '',
  is_selected   boolean     NOT NULL DEFAULT false,
  is_available  boolean     NOT NULL DEFAULT false,
  is_connected  boolean     NOT NULL DEFAULT false,
  last_connected_at timestamptz,
  last_synced_at    timestamptz,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_report_source_records_company_source UNIQUE (company_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_report_source_records_company
  ON report_source_records(company_id, source_key);

CREATE INDEX IF NOT EXISTS idx_report_source_records_selected
  ON report_source_records(company_id, is_selected);
