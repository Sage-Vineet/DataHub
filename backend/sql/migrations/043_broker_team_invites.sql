-- Migration 043: Broker Team Invites
-- Tracks explicit broker-to-broker team invitations.
-- Invited broker's existing company_id / user_companies rows are NEVER modified.
-- The relationship is purely between two broker accounts.

CREATE TABLE IF NOT EXISTS broker_team_invites (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_owner_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_broker_id uuid      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_owner_id, invited_broker_id)
);

CREATE INDEX IF NOT EXISTS idx_bti_owner   ON broker_team_invites(team_owner_id);
CREATE INDEX IF NOT EXISTS idx_bti_invited ON broker_team_invites(invited_broker_id);
