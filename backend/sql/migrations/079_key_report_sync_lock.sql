-- Cross-process sync lock for key_report_versions.
--
-- CONFIRMED BUG this fixes: extractAndStore's DELETE-then-INSERT for a
-- document has no mutual exclusion across OS processes. keyReportService.
-- syncVersion's existing _inFlightSyncs guard is an in-memory JS Map, so it
-- only prevents a second concurrent sync call within the SAME Node process —
-- two separate processes (e.g. the live app server and an ad-hoc script,
-- or two app server instances) racing to sync the same version can each
-- independently DELETE then INSERT for the same source_file_id, and if one
-- process's DELETE lands after the other's INSERT has already committed,
-- both processes' inserted rows survive side by side. Confirmed live: this
-- produced 10,875 duplicated general_ledger_entries rows for one version in
-- a single extraction batch.
--
-- sync_locked_at / sync_locked_by implement a simple, atomic "claim if free
-- or stale" lease: a single UPDATE ... WHERE (sync_locked_at IS NULL OR
-- sync_locked_at < staleThreshold) ... RETURNING is one atomic SQL statement,
-- so exactly one concurrent caller ever succeeds in claiming it, regardless
-- of how many processes race for it at the same instant.

ALTER TABLE key_report_versions
  ADD COLUMN IF NOT EXISTS sync_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_locked_by text;
