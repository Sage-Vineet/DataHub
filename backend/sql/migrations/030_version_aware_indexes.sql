-- ============================================================================
-- Migration 030: Version-Aware Reporting Performance Indexes
--
-- Purpose: Support high-speed version-based filtering for Financial Reports
--          (Balance Sheet, P&L, Cashflow).
-- ============================================================================

-- Index for transaction lookups by session
CREATE INDEX IF NOT EXISTS idx_staged_tx_session
ON manual_gl_staged_transactions(upload_session_id);

-- Add dataset_version_id if missing and index it
ALTER TABLE manual_gl_staged_transactions
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID;

CREATE INDEX IF NOT EXISTS idx_staged_tx_version
ON manual_gl_staged_transactions(dataset_version_id);

-- Index for balance sheet lines by session
CREATE INDEX IF NOT EXISTS idx_bs_lines_session
ON manual_gl_balance_sheet_lines(upload_session_id);

ALTER TABLE manual_gl_balance_sheet_lines
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID;

CREATE INDEX IF NOT EXISTS idx_bs_lines_version
ON manual_gl_balance_sheet_lines(dataset_version_id);

-- Index for upload sessions by version number
CREATE INDEX IF NOT EXISTS idx_upload_sessions_version
ON manual_gl_upload_sessions(version_no);

-- Index for session lookups by data_hash for the dropdown query
CREATE INDEX IF NOT EXISTS idx_upload_sessions_hash_staged
ON manual_gl_upload_sessions(company_id, data_hash)
WHERE status = 'staged';
