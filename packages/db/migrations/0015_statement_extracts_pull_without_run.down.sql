-- Reverse of 0015.
--
-- Restoring the run requirement REFUSES on a database holding an on-demand
-- pull, because Postgres validates a new CHECK against existing rows. That is
-- the wanted behaviour: those rows are real reports somebody looked at, and a
-- rollback that silently kept them would leave a constraint that lies about
-- its own table.

ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_provenance_check;

ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_provenance_check
  CHECK (document_id IS NOT NULL OR sync_run_id IS NOT NULL);
