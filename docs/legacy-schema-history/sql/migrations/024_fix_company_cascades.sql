-- Migration: Fix all company_id foreign keys to cascade delete
-- Purpose: Ensures deleting a company cascades to all child tables.
-- Date: 2026-05-22

DO $$
BEGIN
  -- buyer_groups
  ALTER TABLE buyer_groups DROP CONSTRAINT IF EXISTS buyer_groups_company_id_fkey;
  ALTER TABLE buyer_groups ADD CONSTRAINT buyer_groups_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- requests
  ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_company_id_fkey;
  ALTER TABLE requests ADD CONSTRAINT requests_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- documents
  ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_company_id_fkey;
  ALTER TABLE documents ADD CONSTRAINT documents_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- reminders
  ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_company_id_fkey;
  ALTER TABLE reminders ADD CONSTRAINT reminders_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- activity_log
  ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_company_id_fkey;
  ALTER TABLE activity_log ADD CONSTRAINT activity_log_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- quickbooks_connections
  ALTER TABLE quickbooks_connections DROP CONSTRAINT IF EXISTS quickbooks_connections_company_id_fkey;
  ALTER TABLE quickbooks_connections ADD CONSTRAINT quickbooks_connections_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- manual_gl_batches
  ALTER TABLE manual_gl_batches DROP CONSTRAINT IF EXISTS manual_gl_batches_company_id_fkey;
  ALTER TABLE manual_gl_batches ADD CONSTRAINT manual_gl_batches_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- manual_gl_staged_transactions
  ALTER TABLE manual_gl_staged_transactions DROP CONSTRAINT IF EXISTS manual_gl_staged_transactions_company_id_fkey;
  ALTER TABLE manual_gl_staged_transactions ADD CONSTRAINT manual_gl_staged_transactions_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- manual_gl_balance_sheet_lines
  ALTER TABLE manual_gl_balance_sheet_lines DROP CONSTRAINT IF EXISTS manual_gl_balance_sheet_lines_company_id_fkey;
  ALTER TABLE manual_gl_balance_sheet_lines ADD CONSTRAINT manual_gl_balance_sheet_lines_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- report_source_records
  ALTER TABLE report_source_records DROP CONSTRAINT IF EXISTS report_source_records_company_id_fkey;
  ALTER TABLE report_source_records ADD CONSTRAINT report_source_records_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

  -- user_companies
  ALTER TABLE user_companies DROP CONSTRAINT IF EXISTS user_companies_company_id_fkey;
  ALTER TABLE user_companies ADD CONSTRAINT user_companies_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
