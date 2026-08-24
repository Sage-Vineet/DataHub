-- ═══════════════════════════════════════════════════════════════════════════
-- Reversing the baseline means DESTROYING THE DATABASE.
--
-- Every other migration's down script removes what its up script added. This
-- one's up script added everything, so this one removes everything: all 86
-- tables, every row in them, and the migration ledger's record that any of it
-- ever happened.
--
-- It exists because the runner requires each migration to be reversible, and
-- because a baseline that quietly had no reverse would make `--down` lie about
-- what it can do. It is not a rollback anybody should reach for on a database
-- holding anything: restoring from a dump is the operation you actually want.
--
-- `public` is recreated afterwards so the connection has a schema to resolve
-- against and the next `db:migrate` can rebuild from scratch.
-- ═══════════════════════════════════════════════════════════════════════════

DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
