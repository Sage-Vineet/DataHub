-- ============================================================================
-- Migration 020: vendor_name staging column + source_type on dataset_versions
--
-- Part A: Adds vendor_name to manual_gl_staged_transactions so that payee/
--         vendor data from GL exports is preserved through staging and surfaces
--         in P&L detail reports.
--
-- Part B: Adds source_type to dataset_versions and updates the activation RPC
--         so it only deactivates versions of the SAME source type. This prevents
--         a future QB dataset-version activation from deactivating a Manual GL
--         version and vice versa (source isolation at the version level).
-- ============================================================================

-- ── Part A: vendor_name ──────────────────────────────────────────────────────

ALTER TABLE manual_gl_staged_transactions
  ADD COLUMN IF NOT EXISTS vendor_name TEXT;

CREATE INDEX IF NOT EXISTS idx_staged_txn_vendor
  ON manual_gl_staged_transactions(company_id, vendor_name)
  WHERE vendor_name IS NOT NULL;

-- ── Part B: source_type on dataset_versions ──────────────────────────────────

ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual_gl_upload';

-- Back-fill existing rows from upload_source when present.
UPDATE dataset_versions
SET source_type = CASE
  WHEN upload_source LIKE '%quickbooks%' THEN 'quickbooks_online'
  WHEN upload_source LIKE '%manual_gl%'  THEN 'manual_gl_upload'
  WHEN upload_source LIKE '%manual%'     THEN 'manual_gl_upload'
  ELSE 'manual_gl_upload'
END
WHERE source_type IS NULL OR source_type = '';

CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_source_active
  ON dataset_versions(company_id, source_type, is_active)
  WHERE is_active = true;

-- ── Updated activation RPC — scoped to source_type ──────────────────────────
-- Deactivates only versions of the SAME source type so that activating a
-- Manual GL version does not touch QB versions and vice versa.

CREATE OR REPLACE FUNCTION activate_dataset_version(
  p_company_id UUID,
  p_version_id UUID
) RETURNS SETOF dataset_versions
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
BEGIN
  -- Resolve the source type of the target version.
  SELECT COALESCE(source_type, 'manual_gl_upload')
    INTO v_source_type
    FROM dataset_versions
   WHERE id = p_version_id;

  -- Deactivate all active versions for this company AND source type only.
  UPDATE dataset_versions
     SET is_active = false
   WHERE company_id = p_company_id
     AND is_active  = true
     AND COALESCE(source_type, 'manual_gl_upload') = v_source_type;

  -- Activate the target version.
  UPDATE dataset_versions
     SET is_active    = true,
         finalized_at = COALESCE(finalized_at, now()),
         status       = 'finalized'
   WHERE id           = p_version_id
     AND company_id   = p_company_id;

  RETURN QUERY
  SELECT * FROM dataset_versions WHERE id = p_version_id;
END;
$$;
