-- ============================================================================
-- Migration 033: Company-Specific Fiscal Year Protection
--
-- Purpose:
-- 1) Prevent the same company from staging the same financial data (hash) 
--    multiple times for the same fiscal year.
-- 2) Enforce strict versioned isolation for transactions.
-- ============================================================================

-- ---- Company-Specific Session Protection ------------------------------------

-- This index ensures that a specific company cannot stage the same file (data_hash) 
-- for the same fiscal_year again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_upload_sessions_company_year_hash
  ON manual_gl_upload_sessions(company_id, fiscal_year, data_hash)
  WHERE status = 'staged';


-- ---- Transaction Level Isolation --------------------------------------------

-- Ensures that transactions are uniquely identified by their content (hash)
-- within a specific dataset version and company.
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_gl_staged_transactions_version_hash
  ON manual_gl_staged_transactions (company_id, dataset_version_id, transaction_hash)
  WHERE dataset_version_id IS NOT NULL;
