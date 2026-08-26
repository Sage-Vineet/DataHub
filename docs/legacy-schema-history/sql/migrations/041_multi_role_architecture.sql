-- Migration 041: Multi-Role Architecture
-- Adds sub_role, designation, buyer_company_name, parent_user_id to users.
-- Creates message_groups and message_group_members tables.
-- Backward-compatible: all new columns are nullable with no defaults that
-- would conflict with existing rows.

-- ─── User profile extensions ────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sub_role         text,
  ADD COLUMN IF NOT EXISTS designation      text,
  ADD COLUMN IF NOT EXISTS buyer_company_name text,
  ADD COLUMN IF NOT EXISTS parent_user_id   uuid REFERENCES users(id) ON DELETE SET NULL;

-- Index for fast team-member lookups by parent
CREATE INDEX IF NOT EXISTS idx_users_parent_user_id ON users(parent_user_id);

-- Index for listing users by sub_role within a company
CREATE INDEX IF NOT EXISTS idx_users_sub_role ON users(sub_role) WHERE sub_role IS NOT NULL;

-- ─── Messaging group tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS message_groups (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  -- group_type: broker_internal | deal_team | broker_client | broker_buyer | client_internal | buyer_internal
  group_type  text        NOT NULL,
  -- For deal-team and broker_client groups this is the client company id (same as company_id)
  -- For broker_buyer groups this is the buyer's primary user id
  buyer_user_id uuid      REFERENCES users(id) ON DELETE SET NULL,
  auto_created boolean    NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_groups_company_id ON message_groups(company_id);
CREATE INDEX IF NOT EXISTS idx_message_groups_type       ON message_groups(group_type);

CREATE TABLE IF NOT EXISTS message_group_members (
  group_id   uuid        NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_group_members_user_id ON message_group_members(user_id);

-- ─── Seed sub_role for existing broker users ─────────────────────────────────
-- Existing brokers get sub_role = 'broker_primary' so the new UI can display
-- them correctly without any application-level migration step.
UPDATE users
SET    sub_role = 'broker_primary'
WHERE  role = 'broker'
  AND  sub_role IS NULL;

-- Existing client/buyer users (company owners) get sub_role = 'company_owner'
UPDATE users
SET    sub_role = 'company_owner'
WHERE  role = 'buyer'
  AND  sub_role IS NULL;
