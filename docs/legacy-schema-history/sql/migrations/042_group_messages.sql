-- Migration 042: Group Messages
-- Adds per-group message storage so each auto-created message group
-- (broker_internal, deal_team, broker_client, broker_buyer, etc.) has its
-- own isolated thread of messages, separate from the existing
-- company_messages (broadcast) and direct_messages (1-to-1) tables.

CREATE TABLE IF NOT EXISTS group_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid        NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE,
  sender_id   uuid        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  body        text        NOT NULL CHECK (length(body) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group_id    ON group_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_created_at  ON group_messages(group_id, created_at DESC);

-- Track last-read position per user per group (for unread counts)
CREATE TABLE IF NOT EXISTS group_message_reads (
  group_id      uuid        NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_message_reads_user ON group_message_reads(user_id);
