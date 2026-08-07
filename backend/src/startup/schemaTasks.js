"use strict";

/**
 * Idempotent startup schema tasks.
 *
 * ── Why these changed ───────────────────────────────────────────────────────
 * Each of these previously opened its OWN `pg.Pool`, ran its DDL, and called
 * `.end()`. That meant five pools created and destroyed during boot, five
 * separate TLS handshakes, and — because each swallowed its own error into a
 * `console.warn` — five independent-looking failures from one shared root cause.
 *
 * They now share a single verified pool and report through the startup runner,
 * so a connection fault is diagnosed once.
 *
 * ── On DDL at startup ───────────────────────────────────────────────────────
 * Creating schema at boot is not ideal — it needs an owner-level role at
 * runtime, and concurrent instances race. It is retained because the deployment
 * currently depends on it, and every statement is idempotent
 * (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), so a race is harmless.
 *
 * The authoritative definitions live in backend/sql/migrations/. For a
 * production posture, apply those in CI and set `SKIP_STARTUP_DDL=true`.
 */

const EMAIL_VERIFICATIONS = `
  CREATE TABLE IF NOT EXISTS email_verifications (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email        text        NOT NULL,
    otp_hash     text        NOT NULL,
    attempts     integer     NOT NULL DEFAULT 0,
    resend_count integer     NOT NULL DEFAULT 0,
    verified     boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    verified_at  timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_ev_email   ON email_verifications (email);
  CREATE INDEX IF NOT EXISTS idx_ev_expires ON email_verifications (expires_at);
`;

const BROKER_TEAM_INVITES = `
  CREATE TABLE IF NOT EXISTS broker_team_invites (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    team_owner_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_broker_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_owner_id, invited_broker_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bti_owner   ON broker_team_invites(team_owner_id);
  CREATE INDEX IF NOT EXISTS idx_bti_invited ON broker_team_invites(invited_broker_id);
`;

const BANK_RECON_ADJUSTMENTS = `
  CREATE TABLE IF NOT EXISTS bank_reconciliation_adjustments (
    id         uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid           NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    month      text           NOT NULL,
    row_key    text           NOT NULL,
    amount     numeric(18, 2) NOT NULL DEFAULT 0,
    created_at timestamptz    NOT NULL DEFAULT now(),
    updated_at timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_bank_recon_adjustment UNIQUE (company_id, month, row_key)
  );
  CREATE INDEX IF NOT EXISTS idx_bank_recon_adj_company
    ON bank_reconciliation_adjustments(company_id, month);
`;

const BANK_RECON_ADDBACK_ITEMS = `
  CREATE TABLE IF NOT EXISTS bank_reconciliation_addback_items (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    section       text        NOT NULL CHECK (section IN ('deposits', 'withdrawals')),
    name          text        NOT NULL,
    source        text        NOT NULL DEFAULT 'manual',
    month_amounts jsonb       NOT NULL DEFAULT '{}'::jsonb,
    report_source text        NOT NULL DEFAULT 'quickbooks_online',
    sort_order    integer     NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE bank_reconciliation_addback_items
    ADD COLUMN IF NOT EXISTS report_source text NOT NULL DEFAULT 'quickbooks_online';
  ALTER TABLE bank_reconciliation_addback_items
    ADD COLUMN IF NOT EXISTS key_report_version_id uuid;
  CREATE INDEX IF NOT EXISTS idx_brai_company_source_section
    ON bank_reconciliation_addback_items(company_id, report_source, section);
  CREATE INDEX IF NOT EXISTS idx_bank_recon_addback_kr_version
    ON bank_reconciliation_addback_items(company_id, report_source, key_report_version_id);
`;

const REMINDER_AUTOMATION = `
  ALTER TABLE request_reminders
    ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'sent',
    ADD COLUMN IF NOT EXISTS delivery_channel text NOT NULL DEFAULT 'email_in_app',
    ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

  ALTER TABLE request_reminders
    DROP CONSTRAINT IF EXISTS request_reminders_event_type_check;

  ALTER TABLE request_reminders
    ADD CONSTRAINT request_reminders_event_type_check
    CHECK (event_type IN ('sent', 'skipped', 'overdue'));

  CREATE INDEX IF NOT EXISTS idx_request_reminders_request_event_sent
    ON request_reminders(request_id, event_type, sent_at DESC);

  CREATE INDEX IF NOT EXISTS idx_request_reminders_scheduled_for
    ON request_reminders(scheduled_for)
    WHERE scheduled_for IS NOT NULL;

  CREATE TABLE IF NOT EXISTS user_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    is_read boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE user_notifications
    ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Notification',
    ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_read boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

  CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
    ON user_notifications(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
    ON user_notifications(user_id, is_read, created_at DESC);

  CREATE TABLE IF NOT EXISTS request_assignees (
    request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_request_assignees_user
    ON request_assignees(user_id);

  CREATE INDEX IF NOT EXISTS idx_request_assignees_request_created
    ON request_assignees(request_id, created_at);

  INSERT INTO request_assignees (request_id, user_id)
  SELECT id, assigned_to
  FROM requests
  WHERE assigned_to IS NOT NULL
  ON CONFLICT DO NOTHING;

  SELECT pg_notify('pgrst', 'reload schema');
`;

/**
 * Ordered schema tasks. Order matters: `reminder automation` alters
 * `request_reminders` and references `requests`/`users`, so the base schema
 * must already exist.
 */
const SCHEMA_TASKS = [
  { name: "email_verifications", sql: EMAIL_VERIFICATIONS },
  { name: "broker_team_invites", sql: BROKER_TEAM_INVITES },
  { name: "bank_reconciliation_adjustments", sql: BANK_RECON_ADJUSTMENTS },
  { name: "bank_reconciliation_addback_items", sql: BANK_RECON_ADDBACK_ITEMS },
  { name: "reminder_automation_schema", sql: REMINDER_AUTOMATION },
];

/**
 * Applies one schema task inside a transaction, so a multi-statement task
 * either lands completely or not at all. The previous implementation ran each
 * block as a single implicit-transaction query, which mostly worked, but an
 * explicit transaction makes the atomicity intentional and lets a failure be
 * rolled back cleanly rather than leaving a half-migrated table.
 */
async function applySchemaTask(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Tables and columns that authentication cannot function without.
 *
 * ── Why this check exists ───────────────────────────────────────────────────
 * Moving sessions server-side made login depend on migration 089. When that
 * migration had not been applied, the server started cleanly, reported every
 * task green, and served a healthy /health — but EVERY login returned
 * 503 AUTH_STORE_UNAVAILABLE, which surfaced in the browser as a bare
 * "Failed to fetch". Startup looked perfect while the product was unusable.
 *
 * A boot that cannot authenticate anyone is not a healthy boot. This check
 * makes that visible at startup, with the exact remedy, instead of leaving it
 * to be discovered at the login screen.
 */
const REQUIRED_AUTH_SCHEMA = {
  tables: ["auth_sessions", "account_lockouts", "login_attempts", "security_events"],
  userColumns: ["token_version", "password_changed_at", "must_change_password", "last_login_at"],
};

/**
 * Verifies the authentication schema is present.
 * Throws with code AUTH_SCHEMA_MISSING listing precisely what is absent.
 */
async function verifyAuthSchema(pool) {
  const { rows: tableRows } = await pool.query(
    `SELECT name, to_regclass('public.' || name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS name`,
    [REQUIRED_AUTH_SCHEMA.tables]
  );
  const missingTables = tableRows.filter((r) => !r.present).map((r) => r.name);

  const { rows: columnRows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = ANY($1::text[])`,
    [REQUIRED_AUTH_SCHEMA.userColumns]
  );
  const presentColumns = new Set(columnRows.map((r) => r.column_name));
  const missingColumns = REQUIRED_AUTH_SCHEMA.userColumns.filter((c) => !presentColumns.has(c));

  if (missingTables.length > 0 || missingColumns.length > 0) {
    const parts = [];
    if (missingTables.length) parts.push(`tables: ${missingTables.join(", ")}`);
    if (missingColumns.length) parts.push(`users columns: ${missingColumns.join(", ")}`);
    throw Object.assign(new Error(`Authentication schema incomplete — missing ${parts.join("; ")}`), {
      code: "AUTH_SCHEMA_MISSING",
    });
  }

  return {
    tables: REQUIRED_AUTH_SCHEMA.tables.length,
    columns: REQUIRED_AUTH_SCHEMA.userColumns.length,
  };
}

module.exports = { SCHEMA_TASKS, applySchemaTask, verifyAuthSchema, REQUIRED_AUTH_SCHEMA };
