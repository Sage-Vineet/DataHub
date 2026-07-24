-- Removes the cross-process sync lock introduced in migration 079.
--
-- Reverses 079_key_report_sync_lock.sql per an explicit product requirement:
-- the Key Reports pipeline must never reject a sync request because another
-- sync is already running, at any level (version, company, or client). The
-- application code that read/wrote these columns (keyReportService.js's
-- acquireSyncLock/releaseSyncLock) has been removed entirely — this
-- migration removes the now-unused columns themselves so no "hidden"
-- database-level lock flag is left behind.
--
-- KNOWN, ACCEPTED TRADE-OFF (explicitly requested — not an oversight): this
-- lock existed because two concurrent syncs of the SAME version can each
-- independently run extractAndStore's DELETE-then-INSERT for the same
-- document; if one process's DELETE lands after the other's INSERT has
-- already committed, both processes' inserted rows survive side by side —
-- confirmed live to produce 10,875 duplicated general_ledger_entries rows
-- for one version in a single extraction batch before this lock existed.
-- Dropping these columns reintroduces that exact possibility for anyone who
-- deliberately runs overlapping syncs of the same version.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.

ALTER TABLE key_report_versions
  DROP COLUMN IF EXISTS sync_locked_at,
  DROP COLUMN IF EXISTS sync_locked_by;
