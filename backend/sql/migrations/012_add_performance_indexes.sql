-- Migration: Add composite indexes for report-generation hot paths
-- Date: 2026-05-20
--
-- The existing single-column indexes (company_id, fiscal_year, batch_id) each
-- help independently but the report service always filters on all three together.
-- These compound indexes let PostgreSQL satisfy those queries with a single
-- index scan instead of a bitmap-AND across multiple indexes.

-- Primary report generation pattern: filter by company + batch + year
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_batch_year
  ON manual_gl_staged_transactions(company_id, batch_id, fiscal_year);

-- Monthly detail pattern: company + batch + year + month
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_batch_year_month
  ON manual_gl_staged_transactions(company_id, batch_id, fiscal_year, EXTRACT(month from txn_date));

-- Account-type filtering for BS section splits (asset/liability/equity)
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_batch_acct_type
  ON manual_gl_staged_transactions(company_id, batch_id, account_type);

-- Balance sheet lines: company + batch + sheet_type (STARTING / ENDING)
CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_company_batch_sheet_type
  ON manual_gl_balance_sheet_lines(company_id, batch_id, sheet_type);
