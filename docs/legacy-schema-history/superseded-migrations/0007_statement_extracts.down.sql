-- Reverse of 0007.
--
-- Dropping this discards every statement read out of an uploaded document.
-- The documents themselves survive, so the extracts can in principle be
-- rebuilt by re-running extraction over them — but any correction somebody
-- made to an extracted figure goes with the table, and nothing else records
-- those.

DROP TABLE IF EXISTS statement_extracts;
