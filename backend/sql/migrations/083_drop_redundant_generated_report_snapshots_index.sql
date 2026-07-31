-- Drops a redundant duplicate index on generated_report_snapshots.
--
-- Migration 061 created BOTH a UNIQUE constraint (uq_generated_report_snapshot)
-- and a separate plain index (idx_generated_report_snapshots_lookup) on the
-- exact same columns, in the exact same order: (version_id, report_type,
-- scope_key). A UNIQUE constraint already creates its own backing btree
-- index, so idx_generated_report_snapshots_lookup is byte-for-byte redundant
-- -- confirmed live via pg_indexes -- every read this index could serve is
-- already served by uq_generated_report_snapshot's own index. It only adds
-- extra write cost and storage on every insert/update to this table.
--
-- This migration removes ONLY the redundant plain index. The UNIQUE
-- constraint (and the index it implicitly owns) is untouched.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.

DROP INDEX IF EXISTS idx_generated_report_snapshots_lookup;
