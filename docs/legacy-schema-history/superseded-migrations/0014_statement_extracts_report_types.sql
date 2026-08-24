-- Two more things a QuickBooks pull can be.
--
-- The five types the CHECK admitted were the five FINANCIAL STATEMENTS, which
-- was right when every row came from a document somebody uploaded. Migration
-- 0011 let a row come from an API pull instead, and an API pull is not limited
-- to statements: the Reports page also asks QuickBooks for a general ledger
-- and for the account list behind `/all-reports`.
--
-- WHY NOT A SEPARATE CACHE TABLE
-- ------------------------------
-- A "quickbooks_report_cache" would have the same columns as this one:
-- company, source, type, period, payload, provenance, when. It would be a
-- second way to store one thing, which is the exact pattern the thirteen
-- tables this schema replaces got into — `qb_synced_reports`,
-- `report_snapshots` and `reporting_snapshots` were three tables for one idea.
--
-- WHAT IS BEING ADMITTED, AND THE COST OF ADMITTING IT
-- ---------------------------------------------------
-- `general_ledger` is a financial report for a period and sits here
-- comfortably. `account_list` does not: it is a chart of accounts, a list of
-- accounts with no period at all, and calling it a statement is a stretch.
--
-- It is admitted anyway, and the reason is worth stating rather than hiding.
-- What this table actually holds is "a report we have, for a period, from a
-- source, with provenance" — the name says statement because that was every
-- row when it was written. A row is not made wrong by the table's name, and a
-- fourteenth table with identical columns would be.
--
-- The canonical chart of accounts is still `chart_of_accounts`. This holds
-- what QuickBooks answered when asked, which is a different claim: one is what
-- we believe, the other is what they said.

ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_type_check;

ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_type_check CHECK (statement_type IN (
    'balance_sheet',
    'profit_and_loss',
    'cash_flow',
    'bank_reconciliation',
    'tax_return',
    'general_ledger',
    'account_list'
  ));
