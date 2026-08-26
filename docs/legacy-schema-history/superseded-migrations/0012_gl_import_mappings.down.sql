-- Reverse of 0012.
--
-- Dropping this loses every column mapping somebody confirmed. The uploads
-- survive and detection will run again, but any correction a person made to a
-- wrong guess is gone, and the next import silently uses the guess.

DROP TABLE IF EXISTS gl_import_mappings;
