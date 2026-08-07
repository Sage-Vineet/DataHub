-- ============================================================================
-- 089_security_sessions_and_audit.sql
--
-- Server-side session state, brute-force tracking and a security audit trail.
--
-- WHY: A stateless-only JWT design cannot express "log out", "one device at a
-- time", or "expire after inactivity" — once signed, the token is valid until
-- it expires no matter what happens. These tables make revocation real.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- citext gives case-insensitive email keys, so Attacker@x.com and attacker@x.com
-- share a single lockout counter and cannot be used to double the attempt budget.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Sessions ────────────────────────────────────────────────────────────────
-- One row per active login. The refresh token itself is never stored; only the
-- SHA-256 of its jti, so a database disclosure yields nothing replayable.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Token-family id. Rotation keeps the family and mints a new jti; detecting a
  -- replayed jti within a live family means the token was stolen, so the whole
  -- family is killed. (OAuth 2.0 BCP refresh-token replay detection.)
  family_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  refresh_jti_hash   text        NOT NULL,

  -- Idle timeout is measured from last_seen_at; absolute timeout from created_at.
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,

  revoked_at         timestamptz,
  revoked_reason     text,

  -- Coarse client fingerprint. Stored for audit and to surface "new device"
  -- notices. user_agent is truncated by the application before insert.
  ip_hash            text,
  user_agent         text,

  CONSTRAINT auth_sessions_reason_chk CHECK (
    revoked_reason IS NULL OR revoked_reason IN (
      'logout', 'logout_all', 'superseded', 'idle_timeout', 'absolute_timeout',
      'password_change', 'reuse_detected', 'admin_revoked', 'account_disabled',
      'role_changed'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sessions_refresh_jti
  ON auth_sessions (refresh_jti_hash);

-- Hot path: "find the live sessions for this user".
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions (user_id, revoked_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_family
  ON auth_sessions (family_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
  ON auth_sessions (absolute_expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE auth_sessions IS
  'Server-side refresh-token sessions. Revocation here immediately invalidates a login.';

-- ── Login attempt tracking (account lockout) ────────────────────────────────
-- Keyed by email rather than user_id so attempts against a non-existent account
-- are still counted — otherwise enumeration is possible by observing which
-- addresses can be hammered without ever locking.
CREATE TABLE IF NOT EXISTS login_attempts (
  id            bigserial   PRIMARY KEY,
  email         citext,
  user_id       uuid        REFERENCES users(id) ON DELETE SET NULL,
  ip_hash       text,
  successful    boolean     NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  failure_kind  text
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
  ON login_attempts (email, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
  ON login_attempts (ip_hash, attempted_at DESC);

-- ── Account lockout state ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_lockouts (
  email          citext      PRIMARY KEY,
  failed_count   integer     NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  first_failure_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at  timestamptz NOT NULL DEFAULT now(),
  notified_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_account_lockouts_locked_until
  ON account_lockouts (locked_until)
  WHERE locked_until IS NOT NULL;

-- ── Security event audit trail ──────────────────────────────────────────────
-- Append-only. Never contains credentials — the application layer redacts
-- before insert and `metadata` is validated as non-sensitive by convention.
CREATE TABLE IF NOT EXISTS security_events (
  id          bigserial   PRIMARY KEY,
  event_type  text        NOT NULL,
  severity    text        NOT NULL DEFAULT 'info',
  user_id     uuid        REFERENCES users(id) ON DELETE SET NULL,
  email       citext,
  ip_hash     text,
  user_agent  text,
  request_id  text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT security_events_severity_chk
    CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_security_events_type_time
  ON security_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_user_time
  ON security_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_critical
  ON security_events (created_at DESC)
  WHERE severity = 'critical';

COMMENT ON TABLE security_events IS
  'Append-only security audit trail. Contains no credentials or secret material.';

-- ── User columns supporting credential lifecycle ────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz,
  -- Bumping token_version invalidates every previously issued access token for
  -- the user, even before it expires.
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- ── Retention ───────────────────────────────────────────────────────────────
-- Unbounded audit tables become both a cost problem and a liability. Prune on a
-- schedule (pg_cron, or call from the application's maintenance task).
CREATE OR REPLACE FUNCTION prune_security_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM auth_sessions
   WHERE absolute_expires_at < now() - interval '30 days';

  DELETE FROM login_attempts
   WHERE attempted_at < now() - interval '90 days';

  DELETE FROM security_events
   WHERE created_at < now() - interval '365 days'
     AND severity = 'info';
END;
$$;

COMMIT;
