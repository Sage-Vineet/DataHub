-- Two more things a QuickBooks pull can be, and the last of them.
--
-- The Reports and Invoices pages ask QuickBooks for a customer list and an
-- invoice list. Those go through a different Intuit endpoint — `/query`, taking
-- a SQL-like string, rather than `/reports` — and come back as lists of records
-- rather than statements with rows and columns.
--
-- THE NAME IS NOW WRONG, AND THAT IS THE COST BEING PAID
-- ------------------------------------------------------
-- `statement_extracts` began as "what we read out of an uploaded financial
-- statement". It now holds seven kinds of financial report plus a chart of
-- accounts plus, here, two entity lists. What it actually holds is "what a
-- source told us, and when, and what we asked" — and the name says something
-- narrower than that.
--
-- The alternative was a second table for entity snapshots. It was considered
-- and rejected on the same grounds as migration 0014: it would carry the same
-- columns (company, source, type, payload, provenance, when), be filled by the
-- same cache-then-live code, and mean the QuickBooks service held two
-- repositories and two code paths for one idea. Splitting the storage to fix a
-- name buys a better word and worse code.
--
-- This is the last widening. If a third KIND of thing appears — something that
-- is neither a report nor a list of records — the answer is to rename this
-- table to what it holds, not to admit another type into a name that already
-- does not describe it.

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
    'account_list',
    'customers',
    'invoices'
  ));
