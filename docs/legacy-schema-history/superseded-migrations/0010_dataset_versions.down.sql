-- Reverse of 0010.
--
-- Dropping this loses which import is current and the history of the ones
-- before it. The imported rows survive in their own tables, but nothing then
-- says which of them a report should read — so every report reads everything,
-- and a superseded import silently doubles the figures.

DROP TABLE IF EXISTS dataset_versions;
