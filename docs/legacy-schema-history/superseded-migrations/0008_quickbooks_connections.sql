-- A company's link to its QuickBooks Online account.
--
-- REPLACES `quickbooks_connections`, WHICH DOES NOT EXIST
-- -------------------------------------------------------
-- Legacy's version is created by a migration nothing in this repo applies, so
-- every route that asks whether a company is connected currently cannot
-- answer. `report_source_records` falls back to `companies.quickbooks_connected`
-- for the same reason.
--
-- THE TOKENS ARE ENCRYPTED
-- ------------------------
-- Legacy held `access_token` and `refresh_token` as plain text.
--
-- A QuickBooks refresh token is a standing key to a client's accounting
-- system. It does not expire on its own, it survives a password change, and
-- the client cannot see or revoke it without going into Intuit. A database
-- read that yields one is not "some rows leaked" — it is ongoing access to the
-- books of every company on the platform, for as long as nobody notices.
--
-- So both columns hold sealed values (`apps/api/src/shared/secret-box.ts`):
-- AES-256-GCM under a key derived from the application secret, which lives in
-- the environment and not in the database. A dump, a backup, a replica or a
-- mis-scoped read grant yields ciphertext. It does not defend against an
-- attacker who already has the process — nothing at this layer can — and the
-- shape leaves swapping the key derivation for a KMS call as a one-function
-- change.
--
-- The columns are named `*_sealed` rather than `*_token` so that nothing can
-- write a plaintext token into them by accident and have it look right.

CREATE TABLE IF NOT EXISTS quickbooks_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Intuit's identifier for the connected QuickBooks company.
  realm_id           text NOT NULL,
  realm_company_name text,

  access_token_sealed  text,
  refresh_token_sealed text,
  token_expires_at     timestamptz,

  -- sandbox | production. Kept per connection rather than read from the
  -- environment: a sandbox token pointed at production fails in a way that
  -- looks like a revoked grant, which is an afternoon to diagnose.
  environment        text NOT NULL DEFAULT 'production',
  oauth_client_id    text,
  redirect_uri       text,

  -- False after a disconnect, rather than deleting the row: the history of
  -- having been connected is worth keeping, and a deleted row loses which
  -- realm it was and who did it.
  is_connected       boolean NOT NULL DEFAULT true,
  connected_at       timestamptz,
  disconnected_at    timestamptz,
  last_synced_at     timestamptz,
  connected_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quickbooks_connections_environment_check
    CHECK (environment IN ('sandbox', 'production'))
);

-- One connection per company. Connecting a second QuickBooks account replaces
-- the first rather than leaving two, because every read asks "the" connection.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quickbooks_connections_company
  ON quickbooks_connections(company_id);

-- The OAuth callback arrives knowing only the realm, so it has to find the
-- connection by that. Partial, over live connections only: a realm may
-- legitimately be reconnected to a different company after a disconnect.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quickbooks_connections_realm_live
  ON quickbooks_connections(realm_id) WHERE is_connected;
