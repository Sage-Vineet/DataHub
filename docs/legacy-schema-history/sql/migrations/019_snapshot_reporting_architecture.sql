-- Migration: Snapshot-first QuickBooks reporting architecture
-- Purpose: Make DB snapshots the source of truth for reports and keep report rendering stable while QB is disconnected.
-- Date: 2026-05-21

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sync_source text NOT NULL DEFAULT 'quickbooks',
  source text NOT NULL DEFAULT 'quickbooks',
  status text NOT NULL DEFAULT 'staging',
  is_active boolean NOT NULL DEFAULT false,
  finalized_at timestamptz,
  finalized_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sync_job_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_created
  ON dataset_versions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_active
  ON dataset_versions(company_id, is_active, finalized_at DESC);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sync_source text NOT NULL DEFAULT 'quickbooks',
  status text NOT NULL DEFAULT 'queued',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  dataset_version uuid REFERENCES dataset_versions(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  progress numeric(5,2) NOT NULL DEFAULT 0,
  error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_sync_jobs_status CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT chk_sync_jobs_progress CHECK (progress >= 0 AND progress <= 100)
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_company_created
  ON sync_jobs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_company_status
  ON sync_jobs(company_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_jobs_company_running
  ON sync_jobs(company_id, sync_source)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS sync_logs (
  id bigserial PRIMARY KEY,
  sync_job_id uuid NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dataset_version uuid REFERENCES dataset_versions(id) ON DELETE SET NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_job_created
  ON sync_logs(sync_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_logs_company_created
  ON sync_logs(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finalized_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dataset_version uuid NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT false,
  finalized_at timestamptz NOT NULL DEFAULT now(),
  finalized_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sync_source text NOT NULL DEFAULT 'quickbooks',
  sync_job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_finalized_datasets_company_version UNIQUE (company_id, dataset_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_finalized_datasets_active_company
  ON finalized_datasets(company_id, sync_source)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_finalized_datasets_company_finalized
  ON finalized_datasets(company_id, finalized_at DESC);

CREATE TABLE IF NOT EXISTS connection_status (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'quickbooks',
  is_connected boolean NOT NULL DEFAULT false,
  disconnected_at timestamptz,
  disconnected_reason text,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, source)
);

CREATE TABLE IF NOT EXISTS sync_metadata (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sync_source text NOT NULL DEFAULT 'quickbooks',
  sync_status text NOT NULL DEFAULT 'idle',
  sync_progress numeric(5,2) NOT NULL DEFAULT 0,
  current_job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  current_dataset_version uuid REFERENCES dataset_versions(id) ON DELETE SET NULL,
  last_successful_sync timestamptz,
  last_attempted_sync timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, sync_source),
  CONSTRAINT chk_sync_metadata_status CHECK (
    sync_status IN ('idle', 'queued', 'running', 'failed')
  ),
  CONSTRAINT chk_sync_metadata_progress CHECK (sync_progress >= 0 AND sync_progress <= 100)
);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dataset_version uuid NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  report_type text NOT NULL,
  report_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_source text NOT NULL DEFAULT 'quickbooks',
  sync_job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'staged',
  generated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_report_snapshots_status CHECK (
    status IN ('staged', 'finalized', 'failed')
  ),
  CONSTRAINT uq_report_snapshots_company_version_type_params
    UNIQUE (company_id, dataset_version, report_type, report_params)
);

CREATE INDEX IF NOT EXISTS idx_report_snapshots_company_generated
  ON report_snapshots(company_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_company_dataset
  ON report_snapshots(company_id, dataset_version, report_type);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_company_status
  ON report_snapshots(company_id, status, generated_at DESC);

ALTER TABLE qb_synced_reports
  ADD COLUMN IF NOT EXISTS dataset_version uuid,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sync_source text NOT NULL DEFAULT 'quickbooks',
  ADD COLUMN IF NOT EXISTS sync_job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'staged',
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS sync_progress numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date,
  ADD COLUMN IF NOT EXISTS fiscal_year integer;

DO $$
BEGIN
  ALTER TABLE qb_synced_reports DROP CONSTRAINT IF EXISTS uq_qb_synced_report;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_synced_reports_company_type_params_dataset
  ON qb_synced_reports(company_id, report_type, report_params, dataset_version);

CREATE INDEX IF NOT EXISTS idx_qb_synced_reports_company_active
  ON qb_synced_reports(company_id, is_active, report_type, last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_qb_synced_reports_company_dataset
  ON qb_synced_reports(company_id, dataset_version, report_type);
CREATE INDEX IF NOT EXISTS idx_qb_synced_reports_company_source_status
  ON qb_synced_reports(company_id, sync_source, sync_status, updated_at DESC);

-- Compatibility for deployments that still maintain a gl_entries table.
-- If gl_entries does not exist, this block safely no-ops.
DO $$
BEGIN
  IF to_regclass('public.gl_entries') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE gl_entries ADD COLUMN IF NOT EXISTS dataset_version uuid';
    EXECUTE 'ALTER TABLE gl_entries ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false';
    EXECUTE 'ALTER TABLE gl_entries ADD COLUMN IF NOT EXISTS finalized_at timestamptz';
    EXECUTE 'ALTER TABLE gl_entries ADD COLUMN IF NOT EXISTS sync_source text';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_gl_entries_company_dataset ON gl_entries(company_id, dataset_version)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_gl_entries_company_active ON gl_entries(company_id, is_active)';
  END IF;
END $$;

-- Helper for active dataset switching on installations with gl_entries.
-- Mirrors:
--   UPDATE gl_entries SET is_active = false WHERE client_id = $1;
--   UPDATE gl_entries SET is_active = true WHERE dataset_version = $2;
CREATE OR REPLACE FUNCTION switch_active_gl_dataset(
  p_company_id uuid,
  p_dataset_version uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_regclass('public.gl_entries') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'UPDATE gl_entries SET is_active = false WHERE company_id = $1'
    USING p_company_id;

  EXECUTE 'UPDATE gl_entries SET is_active = true WHERE company_id = $1 AND dataset_version = $2'
    USING p_company_id, p_dataset_version;
END;
$$;

-- Backfill legacy rows into a single finalized dataset per company.
WITH legacy_dataset_map AS (
  INSERT INTO dataset_versions (
    id,
    company_id,
    sync_source,
    source,
    status,
    is_active,
    finalized_at,
    metadata,
    created_at,
    updated_at
  )
  SELECT
    gen_random_uuid(),
    r.company_id,
    'quickbooks',
    'quickbooks',
    'finalized',
    true,
    MAX(COALESCE(r.last_synced_at, r.updated_at, r.created_at)),
    jsonb_build_object('backfilled', true),
    MIN(COALESCE(r.created_at, now())),
    now()
  FROM qb_synced_reports r
  WHERE r.dataset_version IS NULL
  GROUP BY r.company_id
  RETURNING id, company_id
)
UPDATE qb_synced_reports r
SET
  dataset_version = m.id,
  is_active = true,
  finalized_at = COALESCE(r.last_synced_at, r.updated_at, r.created_at, now()),
  sync_source = COALESCE(NULLIF(r.source, ''), 'quickbooks'),
  sync_status = 'finalized',
  sync_progress = 100
FROM legacy_dataset_map m
WHERE r.company_id = m.company_id
  AND r.dataset_version IS NULL;

INSERT INTO finalized_datasets (
  company_id,
  dataset_version,
  is_active,
  finalized_at,
  sync_source,
  metadata,
  created_at,
  updated_at
)
SELECT
  dv.company_id,
  dv.id,
  dv.is_active,
  COALESCE(dv.finalized_at, dv.updated_at, now()),
  dv.sync_source,
  COALESCE(dv.metadata, '{}'::jsonb),
  COALESCE(dv.created_at, now()),
  now()
FROM dataset_versions dv
LEFT JOIN finalized_datasets fd
  ON fd.company_id = dv.company_id
 AND fd.dataset_version = dv.id
WHERE dv.sync_source = 'quickbooks'
  AND fd.id IS NULL;

INSERT INTO sync_metadata (
  company_id,
  sync_source,
  sync_status,
  sync_progress,
  current_job_id,
  current_dataset_version,
  last_successful_sync,
  last_attempted_sync,
  last_error,
  updated_at,
  metadata
)
SELECT
  dv.company_id,
  'quickbooks',
  'idle',
  100,
  NULL,
  dv.id,
  dv.finalized_at,
  dv.finalized_at,
  NULL,
  now(),
  jsonb_build_object('backfilled', true)
FROM dataset_versions dv
WHERE dv.sync_source = 'quickbooks'
  AND dv.is_active = true
ON CONFLICT (company_id, sync_source)
DO UPDATE SET
  current_dataset_version = EXCLUDED.current_dataset_version,
  last_successful_sync = COALESCE(sync_metadata.last_successful_sync, EXCLUDED.last_successful_sync),
  last_attempted_sync = COALESCE(sync_metadata.last_attempted_sync, EXCLUDED.last_attempted_sync),
  sync_status = CASE
    WHEN sync_metadata.sync_status IN ('running', 'queued') THEN sync_metadata.sync_status
    ELSE 'idle'
  END,
  sync_progress = CASE
    WHEN sync_metadata.sync_status IN ('running', 'queued') THEN sync_metadata.sync_progress
    ELSE 100
  END,
  updated_at = now(),
  metadata = COALESCE(sync_metadata.metadata, '{}'::jsonb) || jsonb_build_object('backfilled', true);

INSERT INTO connection_status (
  company_id,
  source,
  is_connected,
  disconnected_at,
  disconnected_reason,
  last_checked_at,
  metadata,
  created_at,
  updated_at
)
SELECT
  c.id,
  'quickbooks',
  COALESCE(c.quickbooks_connected, false),
  CASE WHEN COALESCE(c.quickbooks_connected, false) THEN NULL ELSE now() END,
  CASE WHEN COALESCE(c.quickbooks_connected, false) THEN NULL ELSE 'not_connected' END,
  now(),
  '{}'::jsonb,
  now(),
  now()
FROM companies c
ON CONFLICT (company_id, source)
DO UPDATE SET
  is_connected = EXCLUDED.is_connected,
  last_checked_at = now(),
  updated_at = now();
