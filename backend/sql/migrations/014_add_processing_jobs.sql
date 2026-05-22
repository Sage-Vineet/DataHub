-- Migration: Add processing_jobs table for async staging pipeline
-- Date: 2026-05-20
--
-- Purpose: Enables the staging pipeline to run as a tracked, resumable job
-- rather than a blocking HTTP request. Clients can poll job status and
-- recover from dropped connections without re-staging.
--
-- Status lifecycle:
--   queued → running → complete
--                    ↘ error

CREATE TABLE IF NOT EXISTS processing_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_type     text NOT NULL DEFAULT 'manual_gl_staging',
  status       text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'complete', 'error')),
  stage        text,               -- current human-readable stage name
  progress_pct integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  result_batch_id uuid REFERENCES manual_gl_batches(id) ON DELETE SET NULL,
  error_message text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- input params snapshot
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- arbitrary audit data
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Per-company job lookup (status page, polling)
CREATE INDEX IF NOT EXISTS idx_processing_jobs_company_status
  ON processing_jobs(company_id, status, created_at DESC);

-- Single job lookup by id (polling endpoint)
CREATE INDEX IF NOT EXISTS idx_processing_jobs_id_status
  ON processing_jobs(id, status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_processing_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_processing_jobs_updated_at ON processing_jobs;
CREATE TRIGGER trg_processing_jobs_updated_at
  BEFORE UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION update_processing_jobs_updated_at();
