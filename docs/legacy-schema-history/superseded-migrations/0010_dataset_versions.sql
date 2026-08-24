-- A numbered, activatable snapshot of a company's imported financial data.
--
-- REPLACES `dataset_versions` AND `finalized_datasets`, BOTH ABSENT
-- ----------------------------------------------------------------
-- `backend/sql/schema.sql` says in its own header that it references
-- `dataset_versions(id)` without creating it, and that it therefore cannot
-- apply to an empty database. It also records that `dataset_versions` is
-- created TWICE in the legacy migrations with materially different
-- definitions. Legacy's own authors did not have one answer to what this is.
--
-- `finalized_datasets` was the second table: the same rows again, once they
-- reached a terminal state. One table with a status says the same thing and
-- cannot disagree with itself.
--
-- WHAT THIS IS NOT
-- ----------------
-- Not a `key_report_versions`. That table is a REPORTING configuration — which
-- documents are mapped, which chart of accounts applies — and it already
-- carries `resolved_dataset_version` pointing at one of these. A dataset
-- version is the DATA as imported at a moment: same books, different question.
-- Conflating them was tempting and would have been wrong.
--
-- WHY A NUMBER AND NOT JUST AN ID
-- -------------------------------
-- `version_number` is what the rest of the system filters by — it appears in
-- manual-GL report params as `datasetVersion`, and the SPA reads it as `value`.
-- It is per company and monotonic, so "v3" means something to a person in a
-- way a uuid does not.

CREATE TABLE IF NOT EXISTS dataset_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Per company, monotonic. What a person means by "v3".
  version_number integer NOT NULL,
  label          text,
  -- Which source the data came from, so a QuickBooks pull and a spreadsheet
  -- import do not share a numbering sequence they have nothing to do with.
  source_key     text NOT NULL DEFAULT 'manual_gl_upload',

  -- staging     — rows are being written
  -- validating  — written, being checked
  -- finalized   — usable
  -- failed      — abandoned, kept so the failure is visible
  -- rolled_back — was finalized, superseded by an earlier one being reactivated
  status         text NOT NULL DEFAULT 'staging',

  -- Exactly one active version per company. This is what every report reads
  -- through when nobody has picked one explicitly.
  is_active      boolean NOT NULL DEFAULT false,

  -- The run that produced it, when there was one.
  sync_run_id    uuid REFERENCES sync_runs(id) ON DELETE SET NULL,

  -- What is in it. Counts rather than a recomputation, because "is this
  -- version bigger than the last one" is the first question anyone asks and it
  -- should not cost a table scan.
  row_count      integer NOT NULL DEFAULT 0,
  fiscal_years   integer[] NOT NULL DEFAULT '{}',

  finalized_at   timestamptz,
  activated_at   timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dataset_versions_status_check
    CHECK (status IN ('staging', 'validating', 'finalized', 'failed', 'rolled_back')),
  -- Only a finalized version may be the active one. Activating something still
  -- staging would point every report at half-written data.
  CONSTRAINT dataset_versions_active_is_finalized
    CHECK (NOT is_active OR status = 'finalized')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_versions_company_number
  ON dataset_versions(company_id, source_key, version_number);

-- At most one active per company. The reports read through it, and two would
-- make "the current data" a question of which row was found first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_versions_one_active
  ON dataset_versions(company_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_dataset_versions_company_recent
  ON dataset_versions(company_id, version_number DESC);
