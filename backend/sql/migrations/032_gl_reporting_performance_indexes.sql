-- ============================================================================
-- Migration 032: GL Reporting Performance Indexes
--
-- Purpose: Accelerate version-aware, account-level, and vendor-level report
--          queries on manual_gl_staged_transactions.
--
-- Required by the enterprise GL reporting engine redesign (2026-05-25).
-- ============================================================================

-- Composite index for the most common report query pattern:
--   WHERE company_id = $1 AND upload_batch_id = $2 AND fiscal_year = $3
-- Covers Balance Sheet, P&L, and Cash Flow summary queries filtered by batch + year.
CREATE INDEX IF NOT EXISTS idx_gl_company_batch_year
  ON manual_gl_staged_transactions(company_id, upload_batch_id, fiscal_year);

-- Composite index for dataset_version_id-based queries (version-aware reporting).
-- Mirrors idx_gl_company_batch_year but for installs using dataset_version_id column.
CREATE INDEX IF NOT EXISTS idx_gl_company_version_year
  ON manual_gl_staged_transactions(company_id, dataset_version_id, fiscal_year);

-- Index for account-level drilldown queries and account classification scans.
CREATE INDEX IF NOT EXISTS idx_gl_account
  ON manual_gl_staged_transactions(account_name);

-- Index for vendor-level report queries and vendor drilldowns.
CREATE INDEX IF NOT EXISTS idx_gl_vendor
  ON manual_gl_staged_transactions(vendor_name);

-- Covering index for DISTINCT fiscal_year queries used by the fiscal year
-- detection engine (SELECT DISTINCT fiscal_year WHERE company_id AND upload_batch_id).
CREATE INDEX IF NOT EXISTS idx_gl_company_batch_fiscal_year_only
  ON manual_gl_staged_transactions(company_id, upload_batch_id, fiscal_year)
  INCLUDE (txn_date);

-- Index to accelerate account classification lookups during reclassification.
CREATE INDEX IF NOT EXISTS idx_gl_account_type
  ON manual_gl_staged_transactions(company_id, upload_batch_id, account_type);
