-- Fix chk_companies_data_source_type to include 'manual_upload_excel_pdf'.
-- The prior constraint (migrations 006 & 008) only allowed 'manual_upload' (the old alias),
-- but the application now writes 'manual_upload_excel_pdf' as the canonical key.

-- Backfill any legacy 'manual_upload' rows to the canonical key before tightening the constraint.
UPDATE companies
SET data_source_type = 'manual_upload_excel_pdf'
WHERE data_source_type = 'manual_upload';

DO $$
BEGIN
  -- Drop the old constraint so we can replace it.
  ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_data_source_type;

  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_data_source_type
    CHECK (
      data_source_type IS NULL
      OR data_source_type IN (
        'quickbooks_online',
        'quickbooks',
        'manual_gl_upload',
        'manual_upload_excel_pdf'
      )
    );
END $$;
