// Force IPv4 DNS resolution globally.
// Render's free tier does not support IPv6 outbound connections. Without this,
// every outgoing TCP connection (Postgres, Supabase, Gmail SMTP) that resolves
// to an IPv6 address fails with ENETUNREACH.
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

require("dotenv").config();
const app = require("./app");
const db = require("./db");
const { Pool } = require("pg");
const { checkEmailHealth } = require("./services/emailService");

const port = process.env.PORT || 4000;

/**
 * Ensures the email_verifications table exists in the database.
 * Runs automatically on startup so no manual migration is needed on Render or
 * any other cloud deployment. Failures are non-fatal — server still starts.
 */
async function ensureEmailVerificationsTable() {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[Startup] DATABASE_URL not set — skipping email_verifications table init. " +
      "OTP flow will use in-memory fallback (unreliable on multi-instance deployments)."
    );
    return;
  }

  const isLocal = process.env.DATABASE_URL.includes("localhost") ||
                  process.env.DATABASE_URL.includes("127.0.0.1");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 5000,
  });

  try {
    await pool.query(`
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
    `);
    console.log("[Startup] email_verifications table ready");
  } catch (err) {
    console.warn(
      "[Startup] Could not auto-create email_verifications table:", err.message,
      "— OTP will use in-memory fallback. Run migration 040_email_verifications.sql manually for production."
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

async function ensureBrokerTeamInvitesTable() {
  if (!process.env.DATABASE_URL) return;
  const isLocal = process.env.DATABASE_URL.includes("localhost") ||
                  process.env.DATABASE_URL.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 5000,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broker_team_invites (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        team_owner_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invited_broker_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invited_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (team_owner_id, invited_broker_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bti_owner   ON broker_team_invites(team_owner_id);
      CREATE INDEX IF NOT EXISTS idx_bti_invited ON broker_team_invites(invited_broker_id);
    `);
    console.log("[Startup] broker_team_invites table ready");
  } catch (err) {
    console.warn("[Startup] Could not auto-create broker_team_invites table:", err.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function ensureBankReconAdjTable() {
  if (!process.env.DATABASE_URL) return;
  const isLocal = process.env.DATABASE_URL.includes("localhost") ||
                  process.env.DATABASE_URL.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 5000,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation_adjustments (
        id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id      uuid           NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        month           text           NOT NULL,
        row_key         text           NOT NULL,
        amount          numeric(18, 2) NOT NULL DEFAULT 0,
        created_at      timestamptz    NOT NULL DEFAULT now(),
        updated_at      timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT uq_bank_recon_adjustment UNIQUE (company_id, month, row_key)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_recon_adj_company
        ON bank_reconciliation_adjustments(company_id, month);
    `);
    console.log("[Startup] bank_reconciliation_adjustments table ready");
  } catch (err) {
    console.warn("[Startup] Could not auto-create bank_reconciliation_adjustments table:", err.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function ensureBankReconAddbackItemsTable() {
  if (!process.env.DATABASE_URL) return;
  const isLocal = process.env.DATABASE_URL.includes("localhost") ||
                  process.env.DATABASE_URL.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 5000,
  });
  try {
    await pool.query(`
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
      CREATE INDEX IF NOT EXISTS idx_brai_company_source_section
        ON bank_reconciliation_addback_items(company_id, report_source, section);
    `);
    console.log("[Startup] bank_reconciliation_addback_items table ready");
  } catch (err) {
    console.warn("[Startup] Could not auto-create bank_reconciliation_addback_items table:", err.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

(async () => {
  try {
    await db.ready;
    // Start listening immediately — do NOT block on table creation.
    // The server must be ready to accept connections (including Render's health
    // check probe) before we run any slow startup tasks.
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Leo backend running on port ${port}`);
      // Run background startup tasks — neither blocks the server.
      ensureEmailVerificationsTable().catch((err) =>
        console.warn("[Startup] email_verifications table init failed:", err.message)
      );
      ensureBrokerTeamInvitesTable().catch((err) =>
        console.warn("[Startup] broker_team_invites table init failed:", err.message)
      );
      ensureBankReconAdjTable().catch((err) =>
        console.warn("[Startup] bank_reconciliation_adjustments table init failed:", err.message)
      );
      ensureBankReconAddbackItemsTable().catch((err) =>
        console.warn("[Startup] bank_reconciliation_addback_items table init failed:", err.message)
      );
      checkEmailHealth().catch((err) =>
        console.warn("[Startup] Email health check threw:", err.message)
      );
    });
  } catch (error) {
    console.error("Failed to start backend:", error.message);
    process.exit(1);
  }
})();
