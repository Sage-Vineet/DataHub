-- ============================================================================
-- Migration 001: Snapshot-Based Dataset Versioning
-- 
-- Adds upload_jobs, dataset_versions, and validation_errors tables.
-- Adds dataset_version_id FK to existing staging tables.
-- Creates RPC function for atomic snapshot activation.
-- ============================================================================

-- 1. upload_jobs — tracks every upload lifecycle from start to finish
CREATE TABLE IF NOT EXISTS upload_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  upload_source TEXT,
  error_message TEXT,
  progress JSONB NOT NULL DEFAULT '{"stage":"pending","pct":0}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 2. dataset_versions — immutable finalized snapshots
CREATE TABLE IF NOT EXISTS dataset_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'staging',
  upload_job_id UUID REFERENCES upload_jobs(id) ON DELETE SET NULL,
  upload_source TEXT,
  batch_id UUID REFERENCES manual_gl_batches(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_dataset_version_company_number UNIQUE (company_id, version_number)
);

-- 2b. Backfill any columns missing from a previously-created dataset_versions table
--     All ADD COLUMN IF NOT EXISTS calls are no-ops when the column already exists.
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS version_number INTEGER;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'staging';
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS upload_job_id UUID REFERENCES upload_jobs(id) ON DELETE SET NULL;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS upload_source TEXT;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES manual_gl_batches(id) ON DELETE SET NULL;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Assign sequential version_number to any rows that were created without one
UPDATE dataset_versions dv
SET version_number = subq.rn
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at) AS rn
  FROM dataset_versions
  WHERE version_number IS NULL
) subq
WHERE dv.id = subq.id AND dv.version_number IS NULL;

-- Add unique constraint only if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_dataset_version_company_number'
  ) THEN
    ALTER TABLE dataset_versions
      ADD CONSTRAINT uq_dataset_version_company_number UNIQUE (company_id, version_number);
  END IF;
END $$;

-- 3. validation_errors — per-upload validation failure log
CREATE TABLE IF NOT EXISTS validation_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  upload_job_id UUID REFERENCES upload_jobs(id) ON DELETE CASCADE,
  dataset_version_id UUID REFERENCES dataset_versions(id) ON DELETE CASCADE,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  row_number INTEGER,
  column_name TEXT,
  raw_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Add dataset_version_id to existing staging tables (nullable for backward compat)
ALTER TABLE manual_gl_batches
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID REFERENCES dataset_versions(id) ON DELETE SET NULL;

ALTER TABLE manual_gl_staged_transactions
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID REFERENCES dataset_versions(id) ON DELETE SET NULL;

ALTER TABLE manual_gl_balance_sheet_lines
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID REFERENCES dataset_versions(id) ON DELETE SET NULL;

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_upload_jobs_company_status
  ON upload_jobs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_upload_jobs_company_created
  ON upload_jobs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_active
  ON dataset_versions(company_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_created
  ON dataset_versions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_versions_batch
  ON dataset_versions(batch_id);

CREATE INDEX IF NOT EXISTS idx_staged_txn_dataset_version
  ON manual_gl_staged_transactions(dataset_version_id);
CREATE INDEX IF NOT EXISTS idx_batches_dataset_version
  ON manual_gl_batches(dataset_version_id);
CREATE INDEX IF NOT EXISTS idx_bs_lines_dataset_version
  ON manual_gl_balance_sheet_lines(dataset_version_id);

CREATE INDEX IF NOT EXISTS idx_validation_errors_job
  ON validation_errors(upload_job_id);
CREATE INDEX IF NOT EXISTS idx_validation_errors_version
  ON validation_errors(dataset_version_id);

-- 6. RPC function: Atomic snapshot activation
--    Deactivates all versions for a company, then activates the target version.
--    Returns the activated version row. Runs in a single transaction.
CREATE OR REPLACE FUNCTION activate_dataset_version(
  p_company_id UUID,
  p_version_id UUID
) RETURNS SETOF dataset_versions
LANGUAGE plpgsql
AS $$
BEGIN
  -- Deactivate all versions for this company
  UPDATE dataset_versions
  SET is_active = false
  WHERE company_id = p_company_id AND is_active = true;

  -- Activate the target version
  UPDATE dataset_versions
  SET is_active = true,
      finalized_at = COALESCE(finalized_at, now()),
      status = 'finalized'
  WHERE id = p_version_id AND company_id = p_company_id;

  -- Return the activated version
  RETURN QUERY
  SELECT * FROM dataset_versions WHERE id = p_version_id;
END;
$$;

-- 7. RPC function: Get next version number for a company
CREATE OR REPLACE FUNCTION next_dataset_version_number(
  p_company_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  max_version INTEGER;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) INTO max_version
  FROM dataset_versions
  WHERE company_id = p_company_id;

  RETURN max_version + 1;
END;
$$;
