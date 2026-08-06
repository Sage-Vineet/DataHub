-- Migration 088: fix document_activity.activity_type column type
--
-- After the Supabase project migration, this table was recreated with its
-- activity_type column mistakenly typed against the generic `activity_type`
-- enum ('upload','request','approved','reminder' — used by the unrelated
-- activity_log table) instead of accepting the 'view'/'download' values this
-- table actually needs (see migrations 038_document_activity.sql / schema.sql).
-- Every "View Activity" write since then has failed with
-- "invalid input value for enum activity_type: ...", so no views/downloads
-- have been recorded post-migration.
--
-- Safe to run: document_activity currently has 0 rows.

ALTER TABLE document_activity
  ALTER COLUMN activity_type TYPE text USING activity_type::text;

ALTER TABLE document_activity
  ADD CONSTRAINT document_activity_activity_type_check
  CHECK (activity_type IN ('view', 'download'));
