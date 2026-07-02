-- Migration: Add "key_reports" as a valid data source
-- Purpose: Key Reports becomes a selectable 5th data source, activated from the
--          Key Reports page. The report_source_records.source_key column has no
--          CHECK constraint (any key is accepted), so only the denormalized
--          companies.data_source_type cache constraint needs to allow the new
--          value. Without this the backend still works (the write is gracefully
--          stripped and report_source_records remains authoritative), but this
--          keeps the companies cache accurate and silences the constraint warning.
-- Date: 2026-07-02
--
-- NOTE: Apply via the Supabase Dashboard SQL editor (direct pg connections are
-- blocked from dev machines).

DO $$
BEGIN
  ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_data_source_type;
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_data_source_type
    CHECK (
      data_source_type IS NULL
      OR data_source_type IN (
        'quickbooks_online',
        'manual_gl_upload',
        'manual_upload_excel_pdf',
        'quickbooks_manual',
        'key_reports',
        -- legacy aliases kept for backward-compatibility with older rows
        'quickbooks',
        'manual_upload'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
