require("dotenv").config();
const app = require("./app");
const db = require("./db");
const { Pool } = require("pg");

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

(async () => {
  try {
    await db.ready;
    await ensureEmailVerificationsTable();
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Leo backend running on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start backend:", error.message);
    process.exit(1);
  }
})();
