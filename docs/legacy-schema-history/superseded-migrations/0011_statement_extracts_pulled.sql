-- Let a statement come from an API pull, not only from a file.
--
-- REPLACES `report_snapshots` AND `reporting_snapshots`, BOTH ABSENT
-- -----------------------------------------------------------------
-- `report_snapshots` cached QuickBooks statements keyed by
-- `(company_id, dataset_version, report_type, report_params)`.
-- `reporting_snapshots` did the same for the manual-GL reports. Neither
-- exists, and both are the same thing `statement_extracts` already is: a
-- financial statement we hold, for a period, from a source.
--
-- The only real difference is PROVENANCE. A statement read out of an uploaded
-- PDF points at a document. One pulled from QuickBooks points at the run that
-- pulled it. Adding a third and fourth table to say that would be three ways
-- to store one thing.
--
-- So `document_id` becomes nullable and a `sync_run_id` joins it, with a CHECK
-- that a row must have one or the other. Provenance is never nothing: a
-- statement whose origin cannot be named is a number on a screen that nobody
-- can check, which is the failure this whole schema exists to prevent.
--
-- THE IDENTITY SPLITS IN TWO, AND THAT IS CORRECT
-- -----------------------------------------------
-- For a file, one extract per statement per file — re-reading the same PDF
-- replaces. For a pull, there is no file: the identity is the period and the
-- dataset version, because pulling January twice is the same statement and
-- pulling January and February is two. Two partial unique indexes say exactly
-- that, where one index over a nullable column would say neither.

ALTER TABLE statement_extracts ALTER COLUMN document_id DROP NOT NULL;

ALTER TABLE statement_extracts
  ADD COLUMN IF NOT EXISTS sync_run_id uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  -- Which import this statement belongs to, so switching dataset version
  -- switches the statements with it rather than leaving them behind.
  ADD COLUMN IF NOT EXISTS dataset_version_id uuid
    REFERENCES dataset_versions(id) ON DELETE CASCADE,
  -- The query that produced it, for a pull: accounting method, date range,
  -- whatever the API was asked. Kept so an unexpected figure can be traced to
  -- the question that produced it.
  ADD COLUMN IF NOT EXISTS report_params jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Provenance is never nothing.
ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_provenance_check;
ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_provenance_check
  CHECK (document_id IS NOT NULL OR sync_run_id IS NOT NULL);

-- The old index assumed every row had a document.
DROP INDEX IF EXISTS uq_statement_extracts_document_type;

CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_extracts_from_document
  ON statement_extracts(company_id, document_id, statement_type)
  WHERE document_id IS NOT NULL;

-- For a pull: the same period, pulled again, is the same statement.
--
-- Spelled as one column rather than as a COALESCE over four, for two reasons.
-- NULL never equals NULL, so an index over the raw columns would let two
-- undated pulls both insert; and an expression index cannot be named as an
-- ON CONFLICT target by the query builder, which would leave the upsert
-- reaching for the wrong index and appending instead of replacing.
--
-- The key is built by the writer, which makes the identity legible in one
-- place instead of implied by an index nobody reads.
ALTER TABLE statement_extracts ADD COLUMN IF NOT EXISTS pull_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_extracts_from_pull
  ON statement_extracts(company_id, pull_key)
  WHERE pull_key IS NOT NULL;

-- A pulled statement has a key; a file-sourced one does not. Keeping the two
-- from drifting is worth a constraint, because a pull that lost its key would
-- silently start appending a row per sync.
ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_pull_key_check;
ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_pull_key_check
  CHECK ((document_id IS NULL) = (pull_key IS NOT NULL));
