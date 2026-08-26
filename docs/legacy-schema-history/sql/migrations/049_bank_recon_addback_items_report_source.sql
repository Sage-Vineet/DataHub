ALTER TABLE bank_reconciliation_addback_items
  ADD COLUMN IF NOT EXISTS report_source text NOT NULL DEFAULT 'quickbooks_online';

DROP INDEX IF EXISTS idx_brai_company_section;
CREATE INDEX IF NOT EXISTS idx_brai_company_source_section
  ON bank_reconciliation_addback_items(company_id, report_source, section);
