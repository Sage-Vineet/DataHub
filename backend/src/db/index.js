require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { normalizeCommonSql } = require("./sqlCompat");

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const usePostgres = hasDatabaseUrl && process.env.DISABLE_POSTGRES !== "true";

console.log("====================================");
console.log("🧠 DATABASE MODE CHECK");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "FOUND" : "NOT FOUND");
console.log("USE POSTGRES:", usePostgres ? "YES (SUPABASE)" : "NO (SQLITE)");
console.log("====================================");

let dbPromise;

function buildPgConfig() {
  const connectionString = process.env.DATABASE_URL;
  const explicitSsl = String(process.env.DATABASE_SSL || "").toLowerCase();

  const shouldUseSsl =
    explicitSsl === "true" ||
    (/supabase\.(co|in|com)/i.test(connectionString || "") && explicitSsl !== "false") ||
    (/sslmode=require/i.test(connectionString || "") && explicitSsl !== "false");

  if (usePostgres) {
    console.log("🔒 SSL MODE:", shouldUseSsl ? "ENABLED" : "DISABLED");
  }

  return {
    connectionString,
    ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    keepAlive: true,
  };
}

if (usePostgres) {
  console.log("🚀 Connecting to SUPABASE POSTGRES...");

  const pool = new Pool(buildPgConfig());

  pool.on("error", (err) => {
    console.error("❌ Unexpected PostgreSQL pool error:", err.message);
  });

  const testConnection = async () => {
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT NOW()");
        console.log("✅ SUPABASE CONNECTED SUCCESSFULLY");
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("❌ SUPABASE CONNECTION FAILED:", err.message);
    }
  };

  testConnection();

  module.exports = {
    query: async (text, params = []) => {
      const normalizedText = normalizeCommonSql(text, "postgres");
      return pool.query(normalizedText, params);
    },
    pool,
    engine: "postgres",
  };
} else {
  console.log("⚠️ USING SQLITE (NOT SUPABASE)");

  const initializeDb = async () => {
    const sqlite3 = require("sqlite3").verbose();
    const { open } = require("sqlite");
    const dbPath = "./dev-database.db";
    const isNewDb = !fs.existsSync(dbPath);

    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    await db.exec("PRAGMA foreign_keys = ON");

    if (isNewDb) {
      console.log("📋 Initializing SQLite database schema...");
      const schemaPath = path.join(__dirname, "../../sqlite-schema.sql");
      const schema = fs.readFileSync(schemaPath, "utf8");
      await db.exec(schema);
      console.log("✅ SQLite schema initialized");
    }

    try {
      const requestColumns = await db.all("PRAGMA table_info(requests)");
      const hasSubmissionSource = requestColumns.some((col) => col.name === "submission_source");
      const hasApprovalStatus = requestColumns.some((col) => col.name === "approval_status");
      const hasApprovedBy = requestColumns.some((col) => col.name === "approved_by");
      const hasApprovedAt = requestColumns.some((col) => col.name === "approved_at");

      if (!hasSubmissionSource) {
        await db.exec("ALTER TABLE requests ADD COLUMN submission_source TEXT NOT NULL DEFAULT 'broker'");
      }
      if (!hasApprovalStatus) {
        await db.exec("ALTER TABLE requests ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
      }
      if (!hasApprovedBy) {
        await db.exec("ALTER TABLE requests ADD COLUMN approved_by TEXT REFERENCES users(id) ON DELETE SET NULL");
      }
      if (!hasApprovedAt) {
        await db.exec("ALTER TABLE requests ADD COLUMN approved_at TEXT");
      }
      const hasReminderFrequencyDays = requestColumns.some((col) => col.name === "reminder_frequency_days");
      if (!hasReminderFrequencyDays) {
        await db.exec("ALTER TABLE requests ADD COLUMN reminder_frequency_days INTEGER NOT NULL DEFAULT 2");
      }

      await db.exec("UPDATE requests SET submission_source = COALESCE(submission_source, 'broker')");
      await db.exec("UPDATE requests SET approval_status = COALESCE(approval_status, 'approved')");
      await db.exec("UPDATE requests SET reminder_frequency_days = COALESCE(reminder_frequency_days, 2)");
    } catch (_err) {
      console.error("DB Migration Error (Request Approval):", _err);
    }

    try {
      const reminderColumns = await db.all("PRAGMA table_info(reminders)");
      const hasRequestId = reminderColumns.some((col) => col.name === "request_id");
      const hasMessage = reminderColumns.some((col) => col.name === "message");
      const hasPriority = reminderColumns.some((col) => col.name === "priority");
      const hasFrequencyDays = reminderColumns.some((col) => col.name === "frequency_days");
      const hasSentCount = reminderColumns.some((col) => col.name === "sent_count");
      const hasLastSentAt = reminderColumns.some((col) => col.name === "last_sent_at");
      const hasNextDueAt = reminderColumns.some((col) => col.name === "next_due_at");

      if (!hasRequestId) {
        await db.exec("ALTER TABLE reminders ADD COLUMN request_id TEXT REFERENCES requests(id) ON DELETE CASCADE");
      }
      if (!hasMessage) {
        await db.exec("ALTER TABLE reminders ADD COLUMN message TEXT");
      }
      if (!hasPriority) {
        await db.exec("ALTER TABLE reminders ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
      }
      if (!hasFrequencyDays) {
        await db.exec("ALTER TABLE reminders ADD COLUMN frequency_days INTEGER NOT NULL DEFAULT 2");
      }
      if (!hasSentCount) {
        await db.exec("ALTER TABLE reminders ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasLastSentAt) {
        await db.exec("ALTER TABLE reminders ADD COLUMN last_sent_at TEXT");
      }
      if (!hasNextDueAt) {
        await db.exec("ALTER TABLE reminders ADD COLUMN next_due_at TEXT");
      }

      await db.exec("UPDATE reminders SET priority = COALESCE(priority, 'medium')");
      await db.exec("UPDATE reminders SET frequency_days = COALESCE(frequency_days, 2)");
      await db.exec("UPDATE reminders SET sent_count = COALESCE(sent_count, 0)");
    } catch (_err) {
      console.error("DB Migration Error (Reminders):", _err);
    }

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS direct_messages (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const directMessageColumns = await db.all("PRAGMA table_info(direct_messages)");
      const hasCompanyId = directMessageColumns.some((col) => col.name === "company_id");
      if (!hasCompanyId) {
        await db.exec(
          "ALTER TABLE direct_messages ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE",
        );
      }
      await db.exec(`
        UPDATE direct_messages
        SET company_id = COALESCE(
          (
            SELECT uc1.company_id
            FROM user_companies uc1
            JOIN user_companies uc2
              ON uc2.company_id = uc1.company_id
             AND uc2.user_id = direct_messages.recipient_id
            WHERE uc1.user_id = direct_messages.sender_id
            LIMIT 1
          ),
          (
            SELECT u.company_id
            FROM users u
            WHERE u.id = direct_messages.sender_id
            LIMIT 1
          ),
          (
            SELECT u.company_id
            FROM users u
            WHERE u.id = direct_messages.recipient_id
            LIMIT 1
          )
        )
        WHERE company_id IS NULL
      `);
      await db.exec("CREATE INDEX IF NOT EXISTS idx_direct_messages_company_created ON direct_messages(company_id, created_at DESC)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_direct_messages_sender_company ON direct_messages(sender_id, company_id)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_direct_messages_recipient_company ON direct_messages(recipient_id, company_id)");
    } catch (_err) {
      console.error("DB Migration Error (Direct Messages):", _err);
    }

    return db;
  };

  dbPromise = initializeDb();

  module.exports = {
    query: async (text, params = []) => {
      const db = await dbPromise;
      const normalizedText = normalizeCommonSql(text, "sqlite");
      const normalized = normalizedText.trim().toUpperCase();

      const isRead =
        normalized.startsWith("SELECT") ||
        normalized.startsWith("WITH") ||
        normalized.startsWith("PRAGMA");

      if (isRead) {
        const rows = await db.all(normalizedText, params);
        return { rows, rowCount: rows.length };
      }

      const result = await db.run(normalizedText, params);
      return { rows: [], rowCount: result.changes || 0 };
    },
    pool: null,
    engine: "sqlite",
  };
}
