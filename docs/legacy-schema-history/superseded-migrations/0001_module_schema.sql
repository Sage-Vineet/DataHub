-- Business schema the Phase 2 modules require, on top of the legacy schema.
--
-- Why this file exists: the DDL these modules depend on has only ever existed as
-- TypeScript in packages/db/src/schema.ts. `db:generate` was never run, so there
-- were no business-table migrations at all — the integration tests create the
-- tables they need inline, which is why the gap stayed invisible. Enabling any
-- module against a database built from backend/sql/schema.sql fails: the folders
-- module reads folders.archived_at, which does not exist there.
--
-- Scope is deliberately the DIFFERENCE, not a baseline. Legacy already creates
-- companies, users, folders, folder_access, requests, uploads, documents,
-- key_report_versions and the rest; re-declaring them would conflict. Every
-- statement is idempotent so it is safe to re-run and safe to apply to a database
-- that legacy migrations have already partly advanced.
--
-- This is NOT the reconciliation Phase C owes. That one is `db:pull` against a
-- production snapshot, which will find drift this file cannot know about — the
-- 76 ad-hoc legacy migrations moved production away from schema.sql, and
-- schema.sql itself references tables it never creates (ebitda_adjustments,
-- dataset_versions) and indexes a column that does not exist (line 278).

BEGIN;

-- ── enums ────────────────────────────────────────────────────────────────────
-- requests.approval_status (requests-domain). Legacy has request_status but not
-- this one.
DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── companies ────────────────────────────────────────────────────────────────
-- Every companies-module read selects project_name, so without it `GET /companies`
-- 500s outright.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS project_name text;

-- ── document_activity: naming divergence ─────────────────────────────────────
-- NOT a simple gap. Legacy created this table as
--   (user_id, activity_type, created_at)
-- while packages/db declares it as
--   (actor_id,  action,        at)
-- Same concept, three different column names. Adding the module's columns lets it
-- run, but the two sides then write to DIFFERENT columns of the SAME row, so
-- activity recorded by one is invisible to the other.
--
-- That is a real parity defect in the uploads domain, not something this migration
-- fixes. It is added here so the stack runs and the divergence is visible; the
-- decision (rename in the module, or read both) belongs to the uploads cutover.
ALTER TABLE document_activity ADD COLUMN IF NOT EXISTS actor_id uuid;
ALTER TABLE document_activity ADD COLUMN IF NOT EXISTS action   text;
ALTER TABLE document_activity ADD COLUMN IF NOT EXISTS at       timestamptz DEFAULT now();

-- ── users: multi-role + profile columns ──────────────────────────────────────
-- Legacy migration 041 added the multi-role fields and later ones the profile
-- fields, so production has them — but backend/sql/schema.sql was never updated,
-- which is exactly the "no authoritative schema" finding. Every module that reads
-- `users` selects these columns, so without them even the Better Auth backfill
-- fails on `column "sub_role" does not exist`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_role           text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation        text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS buyer_company_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_user_id     uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth      date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS occupation         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address            text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS broker_company     text;

-- Broker-team invitations (users-domain). The legacy backend auto-creates this
-- table at startup as (id, team_owner_id, invited_broker_id, invited_at), so the
-- CREATE below is usually a no-op and the ALTER is what actually matters:
-- packages/db declares `created_at`, which that shape does not have.
CREATE TABLE IF NOT EXISTS broker_team_invites (
  team_owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_broker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_owner_id, invited_broker_id)
);
ALTER TABLE broker_team_invites ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- ── folders: soft delete + idempotent provisioning ───────────────────────────
ALTER TABLE folders ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Replaces the legacy in-process mutex (folders-domain D2): provisioning relies
-- on this uniqueness plus ON CONFLICT DO NOTHING. parent_id NULLs are distinct in
-- Postgres, so coalesce keeps top-level names unique per company too.
CREATE UNIQUE INDEX IF NOT EXISTS folders_company_parent_name_uq
  ON folders (
    company_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
  );

-- ── email_verifications (auth OTP) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  otp_hash      text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  resend_count  integer NOT NULL DEFAULT 0,
  verified      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  verified_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications (email);

-- ── message groups (messages-domain) ─────────────────────────────────────────
-- Legacy creates company_messages and direct_messages; the group tables are new.
CREATE TABLE IF NOT EXISTS message_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  group_type    text NOT NULL,
  buyer_user_id uuid,
  auto_created  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_groups_company ON message_groups (company_id);

CREATE TABLE IF NOT EXISTS message_group_members (
  group_id   uuid NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages (group_id, created_at);

-- Per-user read watermark — how unread counts are derived (messages-domain).
CREATE TABLE IF NOT EXISTS group_message_reads (
  group_id     uuid NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

COMMIT;
