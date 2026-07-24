-- Migration 072: client_chart_of_accounts gains an optional per-company scope.
--
-- Until now client_chart_of_accounts held exactly one global master reference
-- (imported once from chart_of_accounts_SEC.xlsx via clientCoaImportService),
-- used to bootstrap hierarchy and category reuse for every company.
--
-- This adds an OPTIONAL company_id: a company can now upload its own Chart of
-- Accounts workbook as a document alongside General Ledger / Balance Sheet /
-- Profit & Loss. Rows with company_id set are that company's own authoritative
-- hierarchy (highest priority — see coaMappingService.createCoaMapper); rows
-- with company_id NULL remain the shared global fallback exactly as before.
-- No existing row is touched by this migration (all 83 stay company_id=NULL).
--
-- HAND-APPLY: run this migration manually against the database, consistent
-- with every other migration in this project.

ALTER TABLE client_chart_of_accounts
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_client_coa_company_id
  ON client_chart_of_accounts (company_id) WHERE company_id IS NOT NULL;

-- A company may upload more than one COA workbook over time (re-upload to
-- refresh); each import wipes and replaces only ITS OWN company_id's rows
-- (see clientCoaImportService.importClientCoaWorkbook), never the global set.
