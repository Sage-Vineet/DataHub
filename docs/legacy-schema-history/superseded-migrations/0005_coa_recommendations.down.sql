-- Reverse of 0005. One table, and its indexes and constraints go with it.
--
-- Dropping this loses every pending and decided recommendation. That is
-- acceptable in a way it would not be for a report table: nothing downstream
-- reads it, so no figure changes — the cost is that reviewers lose their queue
-- and their record of what was already declined, and a regenerate rebuilds the
-- pending half but not the decisions.

DROP TABLE IF EXISTS key_report_coa_hierarchy_recommendations;
