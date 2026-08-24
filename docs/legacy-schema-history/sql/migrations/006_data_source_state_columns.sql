-- Migration: Company-level source state fields
-- Purpose: Enforce a single active financial source with auditable switch metadata
-- Date: 2026-05-11

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS quickbooks_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_upload_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_source_switch_at timestamptz;

UPDATE companies
SET data_source_type = 'quickbooks_online'
WHERE lower(coalesce(data_source_type, '')) = 'quickbooks';

UPDATE companies
SET data_source_type = 'manual_gl_upload'
WHERE lower(coalesce(data_source_type, '')) IN ('manual_upload', 'manual_gl');

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

UPDATE companies c
SET quickbooks_connected = EXISTS (
  SELECT 1
  FROM quickbooks_connections qb
  WHERE qb.company_id = c.id
    AND qb.realm_id IS NOT NULL
);

UPDATE companies
SET manual_upload_active = (data_source_type = 'manual_gl_upload');
