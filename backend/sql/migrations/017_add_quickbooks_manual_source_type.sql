-- Add 'quickbooks_manual' to the allowed values for companies.data_source_type.

DO $$
BEGIN
  ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_data_source_type;

  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_data_source_type
    CHECK (
      data_source_type IS NULL
      OR data_source_type IN (
        'quickbooks_online',
        'quickbooks',
        'manual_gl_upload',
        'manual_upload_excel_pdf',
        'quickbooks_manual'
      )
    );
END $$;
