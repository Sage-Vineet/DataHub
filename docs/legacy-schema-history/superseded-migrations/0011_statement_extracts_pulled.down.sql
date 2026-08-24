-- Reverse of 0011.
--
-- Every statement obtained from an API pull rather than a file is deleted
-- first: they have no document, and the column becomes NOT NULL again. They
-- can be pulled afresh from the source, which is the one saving grace here.

DELETE FROM statement_extracts WHERE document_id IS NULL;

DROP INDEX IF EXISTS uq_statement_extracts_from_pull;
ALTER TABLE statement_extracts DROP CONSTRAINT IF EXISTS statement_extracts_pull_key_check;
ALTER TABLE statement_extracts DROP COLUMN IF EXISTS pull_key;
DROP INDEX IF EXISTS uq_statement_extracts_from_document;
ALTER TABLE statement_extracts DROP CONSTRAINT IF EXISTS statement_extracts_provenance_check;
ALTER TABLE statement_extracts
  DROP COLUMN IF EXISTS report_params,
  DROP COLUMN IF EXISTS dataset_version_id,
  DROP COLUMN IF EXISTS sync_run_id;
ALTER TABLE statement_extracts ALTER COLUMN document_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_extracts_document_type
  ON statement_extracts(company_id, document_id, statement_type);
