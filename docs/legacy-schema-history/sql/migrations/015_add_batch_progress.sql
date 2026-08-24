-- Migration: Add progress tracking columns to manual_gl_batches
-- Date: 2026-05-20
--
-- Purpose: Allows the staging service to write real progress state directly
-- onto the batch row. Clients polling a processing_job can also read the
-- batch's own stage/progress once the batch exists.
--
-- 'staged' remains the terminal success status (backwards compatible).
-- New statuses:  processing → staged | error

-- Add status enum values if not present (Supabase uses plain text, not enum here)
-- status column already exists with default 'staged' — just expand valid values.

ALTER TABLE manual_gl_batches
  ADD COLUMN IF NOT EXISTS progress_pct   integer NOT NULL DEFAULT 100
      CHECK (progress_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS progress_stage text,
  ADD COLUMN IF NOT EXISTS error_message  text,
  ADD COLUMN IF NOT EXISTS job_id         uuid REFERENCES processing_jobs(id) ON DELETE SET NULL;

-- Existing rows get progress_pct=100 (already complete) — correct default.

-- Index for job → batch lookup
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_job_id
  ON manual_gl_batches(job_id)
  WHERE job_id IS NOT NULL;

-- Index for in-progress batch detection per company
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_status
  ON manual_gl_batches(company_id, status, created_at DESC);
