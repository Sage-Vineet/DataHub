-- One attempt at pulling a source's data in, and how far it got.
--
-- REPLACES FOUR ABSENT TABLES AND TWO IN-MEMORY MAPS
-- --------------------------------------------------
-- Legacy spread this across `sync_jobs`, `sync_logs`, `sync_metadata` and
-- `connection_status` — none of which exist in the database — plus, for the
-- progress the UI actually polls, two module-level `Map`s in
-- `manualReportUploadService.js` keyed by company id.
--
-- The maps are the interesting part, because they are not merely absent: they
-- are wrong in three ways that a table fixes.
--
--   1. Progress does not survive a restart. Deploy mid-sync and the UI shows
--      "idle" while the work is still running, so somebody starts it again.
--   2. It does not survive a second process. Any poll that lands on a gateway
--      which did not start the sync reports "idle" — so the moment this runs
--      on more than one instance, the progress bar becomes a coin toss.
--   3. There is no history. "Did last night's sync finish?" has no answer, and
--      a sync that failed at 3am looks exactly like one that never ran.
--
-- STALLED RUNS
-- ------------
-- A row that says `running` because the process died holding it would show as
-- active forever, and the UI would never offer the button again. So a run
-- carries a heartbeat, and a reader treats one that has not beaten recently as
-- stalled rather than trusting the status column. That is a judgement the
-- reader makes, not a state written here — nothing can write "I died".

CREATE TABLE IF NOT EXISTS sync_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Which source is being pulled. Same vocabulary as
  -- `report_source_records.source_key`.
  source_key     text NOT NULL,
  -- What kind of work this is: 'documents' for a parse-and-extract pass,
  -- 'quickbooks' for an API pull. Free text rather than a CHECK, because the
  -- set grows with every source and a constraint here would mean a migration
  -- to add one.
  kind           text NOT NULL DEFAULT 'documents',

  status         text NOT NULL DEFAULT 'queued',

  -- What the progress bar renders.
  total_files    integer NOT NULL DEFAULT 0,
  processed_files integer NOT NULL DEFAULT 0,
  current_file   text,
  current_step   text,

  -- What it produced, and what went wrong. Both, not either: a run can finish
  -- having imported nine files and failed on the tenth, and reporting only the
  -- failure loses the nine.
  result         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message  text,

  started_at     timestamptz NOT NULL DEFAULT now(),
  -- Bumped as work proceeds. A reader compares it to now rather than trusting
  -- `status`, because a process that died cannot write its own epitaph.
  heartbeat_at   timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  started_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sync_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  -- A finished run has a finish time and an unfinished one does not. Without
  -- this the two drift apart and "how long did it take" stops being answerable.
  CONSTRAINT sync_runs_finished_check CHECK (
    (status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL)
    OR (status IN ('queued', 'running') AND finished_at IS NULL)
  )
);

-- "The current run for this company", which is every poll.
CREATE INDEX IF NOT EXISTS idx_sync_runs_company_recent
  ON sync_runs(company_id, started_at DESC);

-- At most one unfinished run per company and source. Two concurrent syncs of
-- the same source race each other into the same tables, and the second one
-- wins by accident of timing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_runs_one_active
  ON sync_runs(company_id, source_key)
  WHERE status IN ('queued', 'running');
