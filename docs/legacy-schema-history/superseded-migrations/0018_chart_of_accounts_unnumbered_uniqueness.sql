-- Stop an unnumbered account being added twice.
--
-- `uq_chart_of_accounts_version_account` is UNIQUE over
-- `(version_id, account_number, account_name)` and `account_number` is
-- NULLABLE. In Postgres NULL is never equal to NULL, so two rows naming the
-- same account with no number do not collide — the index simply does not apply
-- to them.
--
-- That is not a corner case. A QuickBooks export carries names and no numbers,
-- which is the commonest chart this product sees, so the constraint that was
-- meant to make a rebuild idempotent protected exactly the charts that do not
-- need it and none of the ones that do. Rebuilding twice doubled the chart,
-- and a doubled chart double-counts every figure rolled up through it.
--
-- TWO PARTIAL INDEXES, NOT ONE OVER A COALESCE
-- --------------------------------------------
-- A `COALESCE(account_number, '')` expression index would say the same thing
-- in one line, and cannot be named as an ON CONFLICT target by the query
-- builder — which would leave the upsert reaching for no index and appending
-- instead of replacing. Two partial indexes are both nameable, and each says
-- plainly which case it covers.

-- Existing duplicates have to go before the index can be created. The row kept
-- is the OLDEST, because anything already pointing at a chart account by id —
-- an adjustment, a classification history entry, a QoE mapping — points at
-- that one, and keeping the newest would orphan all of it.
DELETE FROM chart_of_accounts a
 USING chart_of_accounts b
 WHERE a.account_number IS NULL
   AND b.account_number IS NULL
   AND a.version_id = b.version_id
   AND a.account_name = b.account_name
   AND a.created_at > b.created_at;

-- It is backed by a table CONSTRAINT, not a bare index, so it has to be
-- dropped as one — `DROP INDEX` on it fails with a hint saying so.
ALTER TABLE chart_of_accounts
  DROP CONSTRAINT IF EXISTS uq_chart_of_accounts_version_account;
DROP INDEX IF EXISTS uq_chart_of_accounts_version_account;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chart_of_accounts_numbered
  ON chart_of_accounts(version_id, account_number, account_name)
  WHERE account_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chart_of_accounts_unnumbered
  ON chart_of_accounts(version_id, account_name)
  WHERE account_number IS NULL;
