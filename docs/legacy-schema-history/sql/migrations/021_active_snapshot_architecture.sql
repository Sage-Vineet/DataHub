-- ============================================================================
-- Migration 021: Active Snapshot Architecture & Source-Isolated Activation
--
-- Part A: content_hash + fiscal_years tracking on dataset_versions
-- Part B: activation_events audit log
-- Part C: active_fiscal_years materialized view
-- Part D: Source-type-scoped activation that only deactivates versions of the
--         SAME source_type, preventing cross-source contamination.
-- Part E: Idempotent content-hash duplicate detection
-- Part F: Active dataset FK on companies
-- ============================================================================

-- ── Part A: dataset_versions enhancements ──────────────────────────────────────

ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS fiscal_years INTEGER[] NOT NULL DEFAULT '{}';

ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS row_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_dataset_versions_content_hash
  ON dataset_versions(company_id, source_type, content_hash)
  WHERE content_hash IS NOT NULL;

-- ── Part B: activation_events audit log ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dataset_version_id UUID NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  previous_version_id UUID REFERENCES dataset_versions(id) ON DELETE SET NULL,
  activated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_activation_events_company_activated
  ON activation_events(company_id, activated_at DESC);

CREATE INDEX IF NOT EXISTS idx_activation_events_version
  ON activation_events(dataset_version_id);

-- ── Part C: active_fiscal_years materialized view ──────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS active_fiscal_years AS
SELECT DISTINCT
  dv.company_id,
  COALESCE(dv.source_type, 'manual_gl_upload') AS source_type,
  unnest(
    CASE
      WHEN array_length(dv.fiscal_years, 1) > 0 THEN dv.fiscal_years
      ELSE ARRAY[EXTRACT(YEAR FROM now())::INTEGER]
    END
  ) AS fiscal_year
FROM dataset_versions dv
WHERE dv.is_active = true
  AND dv.status = 'finalized'
  AND dv.fiscal_years IS NOT NULL
  AND array_length(dv.fiscal_years, 1) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_fiscal_years
  ON active_fiscal_years(company_id, source_type, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_active_fiscal_years_lookup
  ON active_fiscal_years(company_id, source_type);

-- ── Part D: Source-type-scoped activation RPC ──────────────────────────────────
-- Replaces the old activate_dataset_version RPC (migration 001) which
-- deactivated ALL source types. This version only touches versions matching
-- the target version's source_type.

CREATE OR REPLACE FUNCTION activate_dataset_version_scoped(
  p_company_id UUID,
  p_version_id UUID,
  p_source_type TEXT DEFAULT NULL
) RETURNS SETOF dataset_versions
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_previous_id UUID;
BEGIN
  -- Resolve source type from target version (or use provided value)
  SELECT COALESCE(source_type, 'manual_gl_upload')
    INTO v_source_type
    FROM dataset_versions
   WHERE id = p_version_id;

  IF p_source_type IS NOT NULL THEN
    v_source_type := p_source_type;
  END IF;

  -- Capture the currently active version (for audit trail)
  SELECT id INTO v_previous_id
    FROM dataset_versions
   WHERE company_id = p_company_id
     AND is_active = true
     AND COALESCE(source_type, 'manual_gl_upload') = v_source_type;

  -- Deactivate only versions of the SAME source type
  UPDATE dataset_versions
     SET is_active = false
   WHERE company_id = p_company_id
     AND is_active  = true
     AND COALESCE(source_type, 'manual_gl_upload') = v_source_type;

  -- Activate the target version
  UPDATE dataset_versions
     SET is_active    = true,
         finalized_at = COALESCE(finalized_at, now()),
         status       = 'finalized'
   WHERE id           = p_version_id
     AND company_id   = p_company_id;

  -- Log activation event
  INSERT INTO activation_events (
    company_id, dataset_version_id, source_type,
    previous_version_id, activated_at, metadata
  ) VALUES (
    p_company_id, p_version_id, v_source_type,
    v_previous_id, now(),
    jsonb_build_object(
      'rpc', 'activate_dataset_version_scoped'
    )
  );

  RETURN QUERY
  SELECT * FROM dataset_versions WHERE id = p_version_id;
END;
$$;

-- ── Part E: Content-hash duplicate detection RPC ───────────────────────────────

CREATE OR REPLACE FUNCTION find_active_version_by_hash(
  p_company_id UUID,
  p_content_hash TEXT,
  p_source_type TEXT DEFAULT NULL
) RETURNS SETOF dataset_versions
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT *
    FROM dataset_versions
   WHERE company_id = p_company_id
     AND content_hash = p_content_hash
     AND is_active = true
     AND status = 'finalized'
     AND (
       p_source_type IS NULL
       OR COALESCE(source_type, 'manual_gl_upload') = p_source_type
     )
   LIMIT 1;
END;
$$;

-- ── Part F: Active dataset FK on companies ─────────────────────────────────────

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS active_dataset_version_id UUID
    REFERENCES dataset_versions(id) ON DELETE SET NULL;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS active_dataset_activated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_companies_active_dataset
  ON companies(active_dataset_version_id)
  WHERE active_dataset_version_id IS NOT NULL;
