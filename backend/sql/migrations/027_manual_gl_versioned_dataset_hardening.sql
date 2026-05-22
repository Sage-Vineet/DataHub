-- ============================================================================
-- Migration 027: Manual GL Versioned Dataset Hardening
--
-- Purpose:
-- 1) Introduce first-class dataset_version and is_archived on upload batches.
-- 2) Carry dataset_version into reporting snapshots for immutable version tracing.
-- 3) Strengthen activation semantics: one active version, all prior versions archived.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- batch version metadata -------------------------------------------------
ALTER TABLE manual_gl_batches
  ADD COLUMN IF NOT EXISTS dataset_version INTEGER,
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY company_id
      ORDER BY COALESCE(created_at, now()) ASC, id ASC
    ) AS version_no
  FROM manual_gl_batches
  WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
)
UPDATE manual_gl_batches b
SET dataset_version = r.version_no
FROM ranked r
WHERE b.id = r.id
  AND b.dataset_version IS NULL;

UPDATE manual_gl_batches
SET is_archived = CASE
  WHEN is_active = true THEN false
  ELSE true
END
WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_batches_company_dataset_version
  ON manual_gl_batches(company_id, dataset_version)
  WHERE dataset_version IS NOT NULL
    AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_dataset_version
  ON manual_gl_batches(company_id, dataset_version DESC, created_at DESC)
  WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_archived
  ON manual_gl_batches(company_id, is_archived, created_at DESC)
  WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

-- ---- snapshot version metadata ---------------------------------------------
ALTER TABLE reporting_snapshots
  ADD COLUMN IF NOT EXISTS dataset_version INTEGER;

UPDATE reporting_snapshots s
SET dataset_version = b.dataset_version
FROM manual_gl_batches b
WHERE b.id = s.upload_batch_id
  AND s.dataset_version IS NULL;

CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_company_dataset_version
  ON reporting_snapshots(company_id, dataset_version, report_type, fiscal_year, generated_at DESC);

-- ---- version allocator RPC --------------------------------------------------
CREATE OR REPLACE FUNCTION next_manual_gl_dataset_version(
  p_company_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('manual_gl_dataset_version:' || COALESCE(p_company_id::text, ''))
  );

  SELECT COALESCE(MAX(dataset_version), 0) + 1
    INTO v_next
    FROM manual_gl_batches
   WHERE company_id = p_company_id
     AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

  RETURN COALESCE(v_next, 1);
END;
$$;

-- ---- compatibility views ----------------------------------------------------
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
  updated_at,
  COALESCE(is_archived, false) AS is_archived,
  dataset_version
FROM manual_gl_batches
WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';

CREATE OR REPLACE VIEW active_upload_batch AS
SELECT
  b.*
FROM upload_batches b
WHERE b.is_active = true;

-- ---- transactional activation RPC update -----------------------------------
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

  -- Deactivate and archive prior active batch.
  UPDATE manual_gl_batches
     SET is_active = false,
         is_archived = true,
         batch_status = CASE
           WHEN COALESCE(batch_status, '') = 'active' THEN 'archived'
           ELSE COALESCE(batch_status, status, 'archived')
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
         is_archived = false,
         status = 'staged',
         batch_status = 'active',
         activated_at = v_now,
         activated_by = p_activated_by,
         deactivated_at = NULL,
         deactivated_by = NULL,
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
