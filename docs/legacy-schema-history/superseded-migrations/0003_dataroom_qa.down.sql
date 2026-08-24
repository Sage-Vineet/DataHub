-- Reverse of 0003. Q&A first: qa_attachments references documents, so it must go
-- before anything in the data room half.

DROP TABLE IF EXISTS qa_item_visibility;
DROP TABLE IF EXISTS qa_attachments;
DROP TABLE IF EXISTS qa_presentations;
DROP TABLE IF EXISTS qa_responses;
DROP TABLE IF EXISTS qa_assignment_events;
DROP TABLE IF EXISTS qa_assignees;
DROP TABLE IF EXISTS qa_items;
DROP TABLE IF EXISTS qa_nominations;
DROP TABLE IF EXISTS qa_categories;

DROP TABLE IF EXISTS upload_chunks;
DROP TABLE IF EXISTS upload_sessions;
DROP TABLE IF EXISTS document_comments;

-- The pointer must go before the table it points into, or the backfilled rows
-- leave documents referencing versions that no longer exist.
ALTER TABLE documents DROP COLUMN IF EXISTS current_version_id;
ALTER TABLE documents DROP COLUMN IF EXISTS version_count;
DROP TABLE IF EXISTS document_versions;
