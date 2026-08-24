-- Reverse of 0009.
--
-- Dropping this loses the record of what has been synced and when. No figure
-- changes — the data a sync imported lives in its own tables — but the history
-- of whether last night's run finished goes, and any run in flight becomes
-- invisible rather than cancelled.

DROP TABLE IF EXISTS sync_runs;
