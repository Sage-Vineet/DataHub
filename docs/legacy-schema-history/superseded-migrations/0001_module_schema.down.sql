-- Reverse of 0001_module_schema.sql.
--
-- Drops only what that migration added. `folders.archived_at` is dropped last and
-- deliberately: doing so discards which folders were archived, so a re-apply
-- restores the column but not the state. Roll back before a soak decides, not
-- after.

BEGIN;

DROP TABLE IF EXISTS group_message_reads;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS message_group_members;
DROP TABLE IF EXISTS message_groups;

DROP INDEX IF EXISTS idx_email_verifications_email;
DROP TABLE IF EXISTS email_verifications;

DROP INDEX IF EXISTS folders_company_parent_name_uq;
ALTER TABLE folders DROP COLUMN IF EXISTS archived_at;

DROP TABLE IF EXISTS broker_team_invites;

ALTER TABLE document_activity DROP COLUMN IF EXISTS at;
ALTER TABLE document_activity DROP COLUMN IF EXISTS action;
ALTER TABLE document_activity DROP COLUMN IF EXISTS actor_id;
ALTER TABLE companies DROP COLUMN IF EXISTS project_name;
-- Only safe on an environment where these columns were added by 0001. On a real
-- database they came from legacy migration 041 and carry data — do not run this
-- half of the rollback there.
ALTER TABLE users DROP COLUMN IF EXISTS broker_company;
ALTER TABLE users DROP COLUMN IF EXISTS address;
ALTER TABLE users DROP COLUMN IF EXISTS occupation;
ALTER TABLE users DROP COLUMN IF EXISTS date_of_birth;
ALTER TABLE users DROP COLUMN IF EXISTS parent_user_id;
ALTER TABLE users DROP COLUMN IF EXISTS buyer_company_name;
ALTER TABLE users DROP COLUMN IF EXISTS designation;
ALTER TABLE users DROP COLUMN IF EXISTS sub_role;

DROP TYPE IF EXISTS approval_status;

COMMIT;
