-- ============================================================================
-- Migration 037: Manual GL Idempotent Dataset Reuse
--
-- Purpose:
--   1. Add first-class dataset_hash tracking to dataset_versions.
--   2. Make the batch checksum hash order-independent and company-scoped.
--   3. Add a reusable lookup for existing Manual GL dataset versions.
--   4. Preserve immutable reporting snapshots by avoiding accidental overwrites.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- dataset_versions hash metadata ----------------------------------------

ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS dataset_hash TEXT;

UPDATE dataset_versions
SET dataset_hash = COALESCE(dataset_hash, content_hash)
WHERE COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
  AND dataset_hash IS NULL
  AND content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_dataset_hash
  ON dataset_versions(company_id, dataset_hash)
  WHERE dataset_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_source_dataset_hash
  ON dataset_versions(company_id, source_type, dataset_hash)
  WHERE dataset_hash IS NOT NULL;

-- ---- Order-independent checksum RPC ---------------------------------------

CREATE OR REPLACE FUNCTION compute_batch_dataset_hash(
  p_company_id UUID,
  p_batch_id   UUID
)
RETURNS TABLE(dataset_hash TEXT, row_count BIGINT)
LANGUAGE sql STABLE
AS $$
  WITH canonical_rows AS (
    SELECT
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
      ) AS row_fingerprint,
      fiscal_year
    FROM manual_gl_staged_transactions
    WHERE company_id = p_company_id
      AND upload_batch_id = p_batch_id
  ),
  fiscal_years AS (
    SELECT COALESCE(string_agg(fiscal_year::TEXT, ',' ORDER BY fiscal_year), '') AS years
    FROM (
      SELECT DISTINCT fiscal_year
      FROM canonical_rows
      WHERE fiscal_year IS NOT NULL
    ) years
  )
  SELECT
    CASE
      WHEN COUNT(*) = 0 THEN NULL
      ELSE encode(
        digest(
          COALESCE(p_company_id::TEXT, '') || '|' ||
          (SELECT years FROM fiscal_years) || '|' ||
          'rows:' || COUNT(*)::TEXT || '|' ||
          COALESCE(string_agg(row_fingerprint, '|' ORDER BY row_fingerprint), ''),
          'sha256'
        ),
        'hex'
      )
    END,
    COUNT(*)
  FROM canonical_rows;
$$;

CREATE OR REPLACE FUNCTION compute_batch_dataset_hash_legacy(
  p_company_id UUID,
  p_batch_id   UUID
)
RETURNS TABLE(dataset_hash TEXT, row_count BIGINT)
LANGUAGE sql STABLE
AS $$
  WITH canonical_rows AS (
    SELECT
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
      ) AS row_fingerprint,
      fiscal_year
    FROM manual_gl_staged_transactions
    WHERE company_id = p_company_id
      AND batch_id = p_batch_id
  ),
  fiscal_years AS (
    SELECT COALESCE(string_agg(fiscal_year::TEXT, ',' ORDER BY fiscal_year), '') AS years
    FROM (
      SELECT DISTINCT fiscal_year
      FROM canonical_rows
      WHERE fiscal_year IS NOT NULL
    ) years
  )
  SELECT
    CASE
      WHEN COUNT(*) = 0 THEN NULL
      ELSE encode(
        digest(
          COALESCE(p_company_id::TEXT, '') || '|' ||
          (SELECT years FROM fiscal_years) || '|' ||
          'rows:' || COUNT(*)::TEXT || '|' ||
          COALESCE(string_agg(row_fingerprint, '|' ORDER BY row_fingerprint), ''),
          'sha256'
        ),
        'hex'
      )
    END,
    COUNT(*)
  FROM canonical_rows;
$$;

-- ---- Manual GL dataset version lookup --------------------------------------

CREATE OR REPLACE FUNCTION find_manual_gl_dataset_version_by_hash(
  p_company_id UUID,
  p_dataset_hash TEXT
)
RETURNS SETOF dataset_versions
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM dataset_versions
  WHERE company_id = p_company_id
    AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload'
    AND COALESCE(dataset_hash, content_hash) = p_dataset_hash
    AND status IN ('finalized', 'completed')
  ORDER BY COALESCE(finalized_at, created_at) DESC, created_at DESC
  LIMIT 1;
$$;

