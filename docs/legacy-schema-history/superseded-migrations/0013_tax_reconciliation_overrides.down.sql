-- Reverse of 0013.
--
-- Dropping this loses every hand correction anybody has made to a tax
-- reconciliation, and unlike an extract there is nothing to recompute them
-- from. An extract can be read out of its document again; a correction exists
-- only because a person disagreed with what the machine read, and that
-- disagreement is not recorded anywhere else.
--
-- The reconciliation will still render — it falls back to the extracted
-- figures — so nothing errors and nothing looks broken. The figures just
-- quietly revert to the ones somebody had already decided were wrong.

DROP TABLE IF EXISTS tax_reconciliation_overrides;
