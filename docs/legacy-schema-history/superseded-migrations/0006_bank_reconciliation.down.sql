-- Reverse of 0006.
--
-- Dropping these loses every hand-entered correction and every add-back line on
-- every reconciliation — figures a person typed and nothing else records. There
-- is no way to rebuild them from the ledger, because they exist precisely to
-- say what the ledger does not.

DROP TABLE IF EXISTS bank_reconciliation_addback_items;
DROP TABLE IF EXISTS bank_reconciliation_adjustments;
