-- A pull does not have to be part of a run.
--
-- Migration 0011 added `sync_run_id` so a statement pulled from an API could
-- name where it came from, and made the provenance CHECK
-- `document_id IS NOT NULL OR sync_run_id IS NOT NULL`. That was right for the
-- case in front of me: every pull then came from a sync run.
--
-- The Reports page does not work that way. When somebody asks for a period no
-- sync has covered, it fetches that report on demand — one report, now,
-- because a person is waiting. There is no run, and inventing a `sync_runs`
-- row per page load would fill the run history with things nobody ran.
--
-- WHAT PROVENANCE ACTUALLY MEANS HERE
-- -----------------------------------
-- The rule the CHECK is trying to express is "no row whose origin cannot be
-- named". For a file, that is the document. For a pull it is the `pull_key` —
-- source, type, dataset version, period and basis — together with
-- `report_params`, which records the question asked, and `extracted_by`, which
-- records who asked it. `sync_run_id` says WHICH RUN, when there was one, and
-- that is extra rather than the identity.
--
-- So the CHECK becomes document-or-pull_key. The existing
-- `(document_id IS NULL) = (pull_key IS NOT NULL)` constraint already
-- guarantees exactly one of the two is set, which makes this one a statement
-- of intent more than a separate gate — and it is kept for that reason: the
-- next person to add a provenance needs to see the rule written down.

ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_provenance_check;

ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_provenance_check
  CHECK (document_id IS NOT NULL OR pull_key IS NOT NULL);
