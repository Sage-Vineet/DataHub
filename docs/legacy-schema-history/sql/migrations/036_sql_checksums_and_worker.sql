-- ============================================================================
-- Migration 036: SQL Checksums, Worker Heartbeat & Orphan Recovery
--
-- Purpose:
--   1. Add compute_batch_dataset_hash() SQL function.
--      Eliminates 100+ sequential paginated round-trips in Node.js by computing
--      the canonical dataset fingerprint entirely inside Postgres.
--      Called via supabase.rpc('compute_batch_dataset_hash', ...).
--
--   2. Add worker heartbeat tracking on upload_jobs.
--      Lets a new process detect orphaned jobs (process crashed mid-flight)
--      and re-queue or fail them on startup.
--
--   3. Add requeue_orphaned_gl_jobs() SQL function.
--      Automatically resets STAGING jobs whose heartbeat expired so the worker
--      can pick them up again on restart without manual intervention.
--
--   4. Add missing performance indexes for large-scale uploads.
-- ============================================================================

-- ---- 1. SQL CHECKSUM FUNCTION ----------------------------------------------
--
-- Computes a stable MD5 hash of all transactions in a batch.
-- Fingerprint format matches buildCanonicalTransactionFingerprint() in Node.js:
--   fiscal_year|txn_date|account_number|account_name|debit|credit|net_amount|
--   class|department|location|transaction_type|journal_type|reference|description
-- All values lowercased; numeric fields rounded to 2 decimal places.
-- Rows are ordered by id ASC for determinism.
--
-- Returns a single row: (dataset_hash TEXT, row_count BIGINT)
-- Returns (NULL, 0) if no rows found (new/empty batch).

CREATE OR REPLACE FUNCTION compute_batch_dataset_hash(
  p_company_id UUID,
  p_batch_id   UUID
)
RETURNS TABLE(dataset_hash TEXT, row_count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT
    CASE WHEN COUNT(*) = 0 THEN NULL ELSE
      md5(
        string_agg(
          lower(
            COALESCE(fiscal_year::TEXT, '')       || '|' ||
            COALESCE(txn_date::TEXT, '')          || '|' ||
            COALESCE(account_number, '')          || '|' ||
            COALESCE(account_name, '')            || '|' ||
            COALESCE(ROUND(COALESCE(debit,   0)::numeric, 2)::TEXT, '0.00') || '|' ||
            COALESCE(ROUND(COALESCE(credit,  0)::numeric, 2)::TEXT, '0.00') || '|' ||
            COALESCE(ROUND(COALESCE(net_amount, 0)::numeric, 2)::TEXT, '0.00') || '|' ||
            COALESCE(class, '')                   || '|' ||
            COALESCE(department, '')              || '|' ||
            COALESCE(location, '')                || '|' ||
            COALESCE(transaction_type, '')        || '|' ||
            COALESCE(journal_type, '')            || '|' ||
            COALESCE(reference, '')               || '|' ||
            COALESCE(description, '')
          ) || '|',
          '|' ORDER BY id ASC
        )
      )
    END,
    COUNT(*)
  FROM manual_gl_staged_transactions
  WHERE company_id    = p_company_id
    AND upload_batch_id = p_batch_id;
$$;

-- Also handle legacy batch_id column if upload_batch_id is missing
CREATE OR REPLACE FUNCTION compute_batch_dataset_hash_legacy(
  p_company_id UUID,
  p_batch_id   UUID
)
RETURNS TABLE(dataset_hash TEXT, row_count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT
    CASE WHEN COUNT(*) = 0 THEN NULL ELSE
      md5(
        string_agg(
          lower(
            COALESCE(fiscal_year::TEXT, '')       || '|' ||
            COALESCE(txn_date::TEXT, '')          || '|' ||
            COALESCE(account_number, '')          || '|' ||
            COALESCE(account_name, '')            || '|' ||
            COALESCE(ROUND(COALESCE(debit,   0)::numeric, 2)::TEXT, '0.00') || '|' ||
            COALESCE(ROUND(COALESCE(credit,  0)::numeric, 2)::TEXT, '0.00') || '|' ||
            COALESCE(ROUND(COALESCE(net_amount, 0)::numeric, 2)::TEXT, '0.00') || '|' ||
            COALESCE(class, '')                   || '|' ||
            COALESCE(department, '')              || '|' ||
            COALESCE(location, '')                || '|' ||
            COALESCE(transaction_type, '')        || '|' ||
            COALESCE(journal_type, '')            || '|' ||
            COALESCE(reference, '')               || '|' ||
            COALESCE(description, '')
          ) || '|',
          '|' ORDER BY id ASC
        )
      )
    END,
    COUNT(*)
  FROM manual_gl_staged_transactions
  WHERE company_id = p_company_id
    AND batch_id   = p_batch_id;
$$;

-- ---- 2. WORKER HEARTBEAT COLUMNS -------------------------------------------
--
-- heartbeat_at: updated every 30s by the worker while processing a job.
--               If a job is STAGING but heartbeat_at is > 90s stale, the
--               worker process crashed and the job is orphaned.
-- worker_id:    identifies which server process owns this job.
--               Allows multi-instance deployments to avoid double-processing.
-- attempt_count: how many times this job has been attempted (for retry limits).

ALTER TABLE upload_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_id      TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts   INTEGER NOT NULL DEFAULT 3;

-- Index for the worker's polling query: find pending jobs quickly.
CREATE INDEX IF NOT EXISTS idx_upload_jobs_pending_poll
  ON upload_jobs(company_id, status, created_at)
  WHERE status IN ('pending', 'staging');

-- Index for orphan detection: find stale heartbeats quickly.
CREATE INDEX IF NOT EXISTS idx_upload_jobs_heartbeat
  ON upload_jobs(heartbeat_at)
  WHERE status = 'staging' AND heartbeat_at IS NOT NULL;

-- ---- 3. ORPHAN RECOVERY FUNCTION -------------------------------------------
--
-- Resets jobs whose heartbeat has not been updated within the stale window.
-- Called on worker startup and periodically to recover from crashes.
-- Jobs that have exceeded max_attempts are marked FAILED instead of re-queued.
--
-- Returns: number of jobs re-queued.

CREATE OR REPLACE FUNCTION requeue_orphaned_gl_jobs(
  p_stale_seconds INTEGER DEFAULT 120  -- jobs with heartbeat > 2 minutes stale
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_cutoff       TIMESTAMPTZ := NOW() - (p_stale_seconds || ' seconds')::INTERVAL;
  v_requeued     INTEGER := 0;
  v_failed_count INTEGER := 0;
BEGIN
  -- Fail jobs that have exceeded max_attempts
  UPDATE upload_jobs
  SET
    status        = 'failed',
    error_message = 'Exceeded maximum retry attempts after process crash.',
    updated_at    = NOW()
  WHERE status       = 'staging'
    AND (heartbeat_at IS NULL OR heartbeat_at < v_cutoff)
    AND attempt_count >= max_attempts;

  GET DIAGNOSTICS v_failed_count = ROW_COUNT;

  -- Re-queue jobs that can still be retried
  UPDATE upload_jobs
  SET
    status        = 'pending',
    worker_id     = NULL,
    heartbeat_at  = NULL,
    updated_at    = NOW()
  WHERE status       = 'staging'
    AND (heartbeat_at IS NULL OR heartbeat_at < v_cutoff)
    AND attempt_count < max_attempts;

  GET DIAGNOSTICS v_requeued = ROW_COUNT;

  IF v_requeued > 0 OR v_failed_count > 0 THEN
    RAISE NOTICE 'Orphan recovery: % re-queued, % permanently failed', v_requeued, v_failed_count;
  END IF;

  RETURN v_requeued;
END;
$$;

-- ---- 4. ADDITIONAL PERFORMANCE INDEXES -------------------------------------

-- Snapshot lookup by (company, batch, report_type, fiscal_year) — the hottest
-- read path. The report route calls this on every GET /reports/* request.
CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_lookup
  ON reporting_snapshots(company_id, upload_batch_id, report_type, fiscal_year)
  WHERE upload_batch_id IS NOT NULL;

-- Accelerate getActiveUploadBatch(): partial index keeps only the live row.
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_active_partial
  ON manual_gl_batches(company_id, created_at DESC)
  WHERE is_active = true AND is_archived = false;

-- Accelerate findActiveBatchByChecksum() dedup check.
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_checksum_active
  ON manual_gl_batches(company_id, dataset_hash)
  WHERE is_active = true AND dataset_hash IS NOT NULL;
