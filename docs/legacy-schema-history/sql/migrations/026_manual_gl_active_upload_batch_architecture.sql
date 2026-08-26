-- ============================================================================
-- Migration 026: Manual GL Active Upload Batch Architecture
--
-- Purpose:
-- 1) Establish a single source of truth for Manual GL rendering:
--      ACTIVE manual_gl_batches row per company.
-- 2) Store immutable, batch-scoped reporting snapshots.
-- 3) Harden upload isolation with upload_batch_id on staged transactions.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- upload batch lifecycle columns ----------------------------------------
ALTER TABLE manual_gl_batches
  ADD COLUMN IF NOT EXISTS batch_status TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS upload_checksum TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE manual_gl_batches
SET batch_status = COALESCE(NULLIF(batch_status, ''), status, 'processing')
WHERE batch_status IS NULL OR batch_status = '';

UPDATE manual_gl_batches
SET uploaded_at = COALESCE(uploaded_at, created_at, now())
WHERE uploaded_at IS NULL;

UPDATE manual_gl_batches
SET processing_started_at = COALESCE(processing_started_at, created_at, uploaded_at, now())
WHERE processing_started_at IS NULL;

UPDATE manual_gl_batches
SET processing_completed_at = COALESCE(processing_completed_at, updated_at, now())
WHERE processing_completed_at IS NULL
  AND COALESCE(status, '') IN ('staged', 'completed', 'finalized', 'active');

UPDATE manual_gl_batches
SET uploaded_by = COALESCE(uploaded_by, created_by)
WHERE uploaded_by IS NULL;

-- Backfill one active batch per company only when none already exists.
WITH candidate AS (
  SELECT DISTINCT ON (company_id)
    id,
    company_id
  FROM manual_gl_batches
  WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
    AND COALESCE(status, '') IN ('staged', 'completed', 'finalized', 'active', 'processing')
  ORDER BY company_id,
    CASE WHEN COALESCE(status, '') IN ('staged', 'active', 'finalized') THEN 0 ELSE 1 END,
    COALESCE(processing_completed_at, updated_at, created_at) DESC
)
UPDATE manual_gl_batches b
SET
  is_active = true,
  batch_status = 'active',
  activated_at = COALESCE(b.activated_at, now())
FROM candidate c
WHERE b.id = c.id
  AND NOT EXISTS (
    SELECT 1
    FROM manual_gl_batches existing
    WHERE existing.company_id = c.company_id
      AND existing.is_active = true
      AND COALESCE(existing.source_type, 'manual_gl_upload') = 'manual_gl_upload'
  );

-- Keep non-active rows non-active for manual GL source.
UPDATE manual_gl_batches
SET is_active = false
WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
  AND batch_status <> 'active'
  AND status <> 'active'
  AND id NOT IN (
    SELECT id
    FROM manual_gl_batches
    WHERE is_active = true
      AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
  );

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_active
  ON manual_gl_batches(company_id, is_active, created_at DESC)
  WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_status_active
  ON manual_gl_batches(company_id, batch_status, created_at DESC)
  WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_checksum
  ON manual_gl_batches(company_id, upload_checksum)
  WHERE upload_checksum IS NOT NULL
    AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

-- Enforce exactly one active manual GL batch per company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_batches_company_active
  ON manual_gl_batches(company_id)
  WHERE is_active = true
    AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

-- Optional safety: only one processing batch per company at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_batches_company_processing
  ON manual_gl_batches(company_id)
  WHERE COALESCE(batch_status, '') = 'processing'
    AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

-- ---- staged transaction isolation columns ----------------------------------
ALTER TABLE manual_gl_staged_transactions
  ADD COLUMN IF NOT EXISTS upload_batch_id UUID REFERENCES manual_gl_batches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS raw_row_reference JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE manual_gl_staged_transactions
SET upload_batch_id = batch_id
WHERE upload_batch_id IS NULL;

DO $$
BEGIN
  BEGIN
    ALTER TABLE manual_gl_staged_transactions
      ALTER COLUMN upload_batch_id SET NOT NULL;
  EXCEPTION WHEN others THEN
    -- Keep migration resilient for legacy rows that may violate FK/NULL assumptions.
    NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_upload_batch
  ON manual_gl_staged_transactions(company_id, upload_batch_id, id);

CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_upload_batch_year
  ON manual_gl_staged_transactions(company_id, upload_batch_id, fiscal_year);

-- ---- immutable reporting snapshots -----------------------------------------
CREATE TABLE IF NOT EXISTS reporting_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_batch_id UUID NOT NULL REFERENCES manual_gl_batches(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year INTEGER,
  report_type TEXT NOT NULL,
  snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_reporting_snapshots_batch_report_year
    UNIQUE (upload_batch_id, report_type, fiscal_year)
);

CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_company_batch
  ON reporting_snapshots(company_id, upload_batch_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_company_report_year
  ON reporting_snapshots(company_id, report_type, fiscal_year, generated_at DESC);

-- ---- compatibility views (clean architecture naming) -----------------------
CREATE OR REPLACE VIEW upload_batches AS
SELECT
  id,
  company_id,
  COALESCE(source_type, 'manual_gl_upload') AS source_type,
  COALESCE(batch_status, status, 'processing') AS batch_status,
  is_active,
  upload_checksum,
  uploaded_by,
  uploaded_at,
  processing_started_at,
  processing_completed_at,
  metadata,
  created_at,
  updated_at
FROM manual_gl_batches
WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE OR REPLACE VIEW staged_gl_transactions AS
SELECT
  id,
  upload_batch_id,
  company_id,
  fiscal_year,
  account_name,
  vendor_name,
  txn_date AS transaction_date,
  debit,
  credit,
  COALESCE(raw_row_reference, '{}'::jsonb) AS raw_row_reference,
  metadata,
  created_at
FROM manual_gl_staged_transactions;

CREATE OR REPLACE VIEW active_upload_batch AS
SELECT
  b.*
FROM upload_batches b
WHERE b.is_active = true;

-- ---- transactional activation RPC ------------------------------------------
CREATE OR REPLACE FUNCTION activate_manual_gl_batch(
  p_company_id UUID,
  p_batch_id UUID,
  p_activated_by UUID DEFAULT NULL
) RETURNS SETOF manual_gl_batches
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_batch_company UUID;
BEGIN
  -- Serialize activation per company.
  PERFORM pg_advisory_xact_lock(hashtext('manual_gl_batch:' || COALESCE(p_company_id::text, '')));

  SELECT company_id
    INTO v_batch_company
    FROM manual_gl_batches
   WHERE id = p_batch_id;

  IF v_batch_company IS NULL THEN
    RAISE EXCEPTION 'manual_gl batch % not found', p_batch_id;
  END IF;

  IF v_batch_company <> p_company_id THEN
    RAISE EXCEPTION 'manual_gl batch % does not belong to company %', p_batch_id, p_company_id;
  END IF;

  -- Deactivate prior active batch.
  UPDATE manual_gl_batches
     SET is_active = false,
         batch_status = CASE
           WHEN COALESCE(batch_status, '') = 'active' THEN 'inactive'
           ELSE COALESCE(batch_status, status, 'inactive')
         END,
         deactivated_at = v_now,
         deactivated_by = p_activated_by,
         updated_at = v_now
   WHERE company_id = p_company_id
     AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
     AND is_active = true
     AND id <> p_batch_id;

  -- Activate target batch.
  UPDATE manual_gl_batches
     SET is_active = true,
         status = 'staged',
         batch_status = 'active',
         activated_at = v_now,
         activated_by = p_activated_by,
         processing_completed_at = COALESCE(processing_completed_at, v_now),
         updated_at = v_now
   WHERE id = p_batch_id
     AND company_id = p_company_id;

  RETURN QUERY
  SELECT *
    FROM manual_gl_batches
   WHERE id = p_batch_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_active_manual_gl_batch(
  p_company_id UUID
) RETURNS SETOF manual_gl_batches
LANGUAGE sql
AS $$
  SELECT *
    FROM manual_gl_batches
   WHERE company_id = p_company_id
     AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
     AND is_active = true
   ORDER BY activated_at DESC NULLS LAST, updated_at DESC
   LIMIT 1;
$$;
