-- Reverse of 0018.
--
-- Restores the index that does not apply to unnumbered accounts. The rows the
-- up-migration deleted are not restored; they were duplicates that nothing
-- should have been able to create.

DROP INDEX IF EXISTS uq_chart_of_accounts_numbered;
DROP INDEX IF EXISTS uq_chart_of_accounts_unnumbered;

-- Recreated as a CONSTRAINT rather than a bare index, which is what it was.
ALTER TABLE chart_of_accounts
  ADD CONSTRAINT uq_chart_of_accounts_version_account
  UNIQUE (version_id, account_number, account_name);
