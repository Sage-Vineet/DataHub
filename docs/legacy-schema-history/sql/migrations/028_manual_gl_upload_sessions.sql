-- ============================================================================
-- Migration 028: Manual GL Fiscal-Year Upload Sessions
--
-- Purpose:
-- 1) Track immutable fiscal-year upload versions separately from company-wide
--    reporting batches.
-- 2) Enforce one active upload session per (company, fiscal_year).
-- 3) Support exact-duplicate blocking and corrected-year versioning.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS manual_gl_upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  file_hash TEXT,
  data_hash TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'staged',
  staging_batch_id UUID REFERENCES manual_gl_batches(id) ON DELETE SET NULL,
  source_upload_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  replaced_session_id UUID REFERENCES manual_gl_upload_sessions(id) ON DELETE SET NULL,
  CONSTRAINT uq_manual_gl_upload_sessions_company_year_version
    UNIQUE (company_id, fiscal_year, version_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_upload_sessions_company_year_active
  ON manual_gl_upload_sessions(company_id, fiscal_year)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_manual_gl_upload_sessions_company_year_created
  ON manual_gl_upload_sessions(company_id, fiscal_year, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_manual_gl_upload_sessions_company_batch
  ON manual_gl_upload_sessions(company_id, staging_batch_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_manual_gl_upload_sessions_company_hash
  ON manual_gl_upload_sessions(company_id, fiscal_year, data_hash, file_hash);
