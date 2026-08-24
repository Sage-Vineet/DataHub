-- Reverse of 0004. Publications reference uploads and documents, so they go
-- first; blocks and slides cascade from versions, but are dropped explicitly so
-- the order reads as the dependency graph rather than relying on CASCADE.

DROP TABLE IF EXISTS cim_publications;
DROP TABLE IF EXISTS cim_block_provenance;
DROP TABLE IF EXISTS cim_question_library;
DROP TABLE IF EXISTS cim_blocks;
DROP TABLE IF EXISTS cim_slides;
DROP TABLE IF EXISTS cim_sections;
DROP TABLE IF EXISTS cim_versions;
DROP TABLE IF EXISTS cim_decks;
