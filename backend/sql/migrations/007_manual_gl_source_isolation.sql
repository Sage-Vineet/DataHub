-- Migration: Manual GL source/session isolation hardening
-- Purpose:
-- 1) isolate staged datasets by source/session/switch version
-- 2) prevent cross-batch dedupe collisions
-- 3) keep reporting reads aligned to latest staged batch
-- Date: 2026-05-11

-- ---- manual_gl_batches ----------------------------------------------------
ALTER TABLE manual_gl_batches
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual_gl_upload',
  ADD COLUMN IF NOT EXISTS source_switch_version timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS upload_session_id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS staged_at timestamptz NOT NULL DEFAULT now();

UPDATE manual_gl_batches
SET source_type = 'manual_gl_upload'
WHERE coalesce(source_type, '') = '';

UPDATE manual_gl_batches
SET source_switch_version = coalesce(source_switch_version, created_at, now())
WHERE source_switch_version IS NULL;

UPDATE manual_gl_batches
SET staged_at = coalesce(staged_at, updated_at, created_at, now())
WHERE staged_at IS NULL;

UPDATE manual_gl_batches
SET upload_session_id = gen_random_uuid()
WHERE upload_session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_status_created
  ON manual_gl_batches(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_source_isolation
  ON manual_gl_batches(company_id, source_type, source_switch_version, upload_session_id, created_at DESC);

-- ---- manual_gl_staged_transactions ---------------------------------------
ALTER TABLE manual_gl_staged_transactions
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual_gl_upload',
  ADD COLUMN IF NOT EXISTS source_switch_version timestamptz,
  ADD COLUMN IF NOT EXISTS upload_session_id uuid,
  ADD COLUMN IF NOT EXISTS staged_at timestamptz NOT NULL DEFAULT now();

UPDATE manual_gl_staged_transactions t
SET
  source_type = coalesce(nullif(t.source_type, ''), 'manual_gl_upload'),
  source_switch_version = coalesce(t.source_switch_version, b.source_switch_version, b.created_at, now()),
  upload_session_id = coalesce(t.upload_session_id, b.upload_session_id),
  staged_at = coalesce(t.staged_at, b.staged_at, b.updated_at, b.created_at, now())
FROM manual_gl_batches b
WHERE t.batch_id = b.id;

UPDATE manual_gl_staged_transactions
SET source_switch_version = coalesce(source_switch_version, now())
WHERE source_switch_version IS NULL;

UPDATE manual_gl_staged_transactions
SET upload_session_id = gen_random_uuid()
WHERE upload_session_id IS NULL;

ALTER TABLE manual_gl_staged_transactions
  DROP CONSTRAINT IF EXISTS uq_manual_gl_txn_hash;

ALTER TABLE manual_gl_staged_transactions
  ADD CONSTRAINT uq_manual_gl_txn_hash_batch
  UNIQUE (company_id, batch_id, transaction_hash);

CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_source_isolation
  ON manual_gl_staged_transactions(company_id, source_type, source_switch_version, upload_session_id, staged_at DESC);

-- ---- manual_gl_balance_sheet_lines ---------------------------------------
ALTER TABLE manual_gl_balance_sheet_lines
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual_gl_upload',
  ADD COLUMN IF NOT EXISTS source_switch_version timestamptz,
  ADD COLUMN IF NOT EXISTS upload_session_id uuid,
  ADD COLUMN IF NOT EXISTS staged_at timestamptz NOT NULL DEFAULT now();

UPDATE manual_gl_balance_sheet_lines l
SET
  source_type = coalesce(nullif(l.source_type, ''), 'manual_gl_upload'),
  source_switch_version = coalesce(l.source_switch_version, b.source_switch_version, b.created_at, now()),
  upload_session_id = coalesce(l.upload_session_id, b.upload_session_id),
  staged_at = coalesce(l.staged_at, b.staged_at, b.updated_at, b.created_at, now())
FROM manual_gl_batches b
WHERE l.batch_id = b.id;

UPDATE manual_gl_balance_sheet_lines
SET source_switch_version = coalesce(source_switch_version, now())
WHERE source_switch_version IS NULL;

UPDATE manual_gl_balance_sheet_lines
SET upload_session_id = gen_random_uuid()
WHERE upload_session_id IS NULL;

ALTER TABLE manual_gl_balance_sheet_lines
  DROP CONSTRAINT IF EXISTS uq_manual_gl_bs_line_hash;

ALTER TABLE manual_gl_balance_sheet_lines
  ADD CONSTRAINT uq_manual_gl_bs_line_hash_batch
  UNIQUE (company_id, batch_id, sheet_type, line_hash);

CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_source_isolation
  ON manual_gl_balance_sheet_lines(company_id, source_type, source_switch_version, upload_session_id, staged_at DESC);
