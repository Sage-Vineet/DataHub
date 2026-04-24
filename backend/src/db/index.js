const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const fs = require("fs");
const path = require("path");

const databaseUrl = process.env.DATABASE_URL;
const shouldUsePostgres = Boolean(databaseUrl);

let dbPromise;
const columnPresenceCache = new Map();

function normalizePostgresQuery(text) {
  let normalized = text;

  if (!/\$\d+/.test(normalized) && normalized.includes("?")) {
    let index = 0;
    normalized = normalized.replace(/\?/g, () => `$${++index}`);
  }

  normalized = normalized.replace(/datetime\(\s*'now'\s*\)/gi, "CURRENT_TIMESTAMP");
  normalized = normalized.replace(/datetime\(\s*CURRENT_TIMESTAMP\s*\)/gi, "CURRENT_TIMESTAMP");
  normalized = normalized.replace(
    /datetime\(\s*(([a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)(::[a-z_][a-z0-9_]*)?\s*\)/gi,
    "$1$3",
  );
  normalized = normalized.replace(
    /ORDER BY\s+datetime\(\s*(([a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)(::[a-z_][a-z0-9_]*)?\s*\)\s+(ASC|DESC)/gi,
    "ORDER BY $1$3 $4",
  );
  normalized = normalized.replace(/\b([a-z_][a-z0-9_]*)\.rowid\b/gi, "$1.id");

  return normalized;
}

if (shouldUsePostgres) {
  const { Pool } = require("pg");
  const db = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
  });

  async function hasColumn(tableName, columnName) {
    const cacheKey = `${tableName}.${columnName}`;
    if (columnPresenceCache.has(cacheKey)) {
      return columnPresenceCache.get(cacheKey);
    }

    const result = await db.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
       LIMIT 1`,
      [tableName, columnName],
    );
    const exists = result.rowCount > 0;
    columnPresenceCache.set(cacheKey, exists);
      return exists;
    }

  const ready = (async () => {
    await db.query("ALTER TABLE buyer_groups ADD COLUMN IF NOT EXISTS description text");
  })().catch((error) => {
    console.error("DB Migration Error (buyer_groups.description):", error.message);
    throw error;
  });

  module.exports = {
    query: async (text, params) => {
      await ready;
      return db.query(normalizePostgresQuery(text), params);
    },
    hasColumn,
    ready,
    isPostgres: true,
    pool: db,
  };
} else {
  const initializeDb = async () => {
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
      console.log("✅ Database schema initialized");
    }

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS user_companies (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, company_id)
        )
      `);
      await db.exec("CREATE INDEX IF NOT EXISTS idx_user_companies_user ON user_companies(user_id)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id)");
      await db.exec(`
        INSERT OR IGNORE INTO user_companies (user_id, company_id)
        SELECT id, company_id FROM users WHERE company_id IS NOT NULL
      `);
    } catch (_err) {}

    try {
      const groupColumns = await db.all("PRAGMA table_info(buyer_groups)");
      const hasDescription = groupColumns.some(
        (col) => col.name === "description",
      );
      if (!hasDescription) {
        await db.exec("ALTER TABLE buyer_groups ADD COLUMN description TEXT");
      }
    } catch (_err) {}

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS uploads (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          data BLOB NOT NULL,
          prefix TEXT,
          uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      const documentColumns = await db.all("PRAGMA table_info(documents)");
      const hasUploadId = documentColumns.some(
        (col) => col.name === "upload_id",
      );
      if (!hasUploadId) {
        await db.exec(
          "ALTER TABLE documents ADD COLUMN upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL",
        );
      }

      await db.exec(
        "CREATE INDEX IF NOT EXISTS idx_documents_upload_id ON documents(upload_id)",
      );
    } catch (_err) {}

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT,
          txn_date TEXT NOT NULL,
          narration TEXT,
          amount REAL NOT NULL
        )
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS reconciliation_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT,
          txn_date TEXT NOT NULL,
          amount REAL NOT NULL,
          name TEXT,
          transaction_type TEXT
        )
      `);

      // Migration check for existing tables
      const bankCols = await db.all("PRAGMA table_info(bank_transactions)");
      if (!bankCols.some((c) => c.name === "client_id")) {
        await db.exec(
          "ALTER TABLE bank_transactions ADD COLUMN client_id TEXT",
        );
      }
      const bookCols = await db.all(
        "PRAGMA table_info(reconciliation_transactions)",
      );
      if (!bookCols.some((c) => c.name === "client_id")) {
        await db.exec(
          "ALTER TABLE reconciliation_transactions ADD COLUMN client_id TEXT",
        );
      }
    } catch (_err) {
      console.error("DB Migration Error (Reconciliation):", _err);
    }

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS company_messages (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.exec("CREATE INDEX IF NOT EXISTS idx_company_messages_company_created ON company_messages(company_id, created_at DESC)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_company_messages_sender ON company_messages(sender_id)");
    } catch (_err) {
      console.error("DB Migration Error (Messages):", _err);
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

  async function hasColumn(tableName, columnName) {
    const cacheKey = `${tableName}.${columnName}`;
    if (columnPresenceCache.has(cacheKey)) {
      return columnPresenceCache.get(cacheKey);
    }

    const db = await dbPromise;
    const columns = await db.all(`PRAGMA table_info(${tableName})`);
    const exists = columns.some((column) => column.name === columnName);
    columnPresenceCache.set(cacheKey, exists);
    return exists;
  }

  dbPromise = initializeDb();

  module.exports = {
    query: async (text, params = []) => {
      const db = await dbPromise;
      const normalized = text.trim().toUpperCase();
      const hasReturning = normalized.includes(" RETURNING ");
      const isRead =
        normalized.startsWith("SELECT") ||
        normalized.startsWith("WITH") ||
        normalized.startsWith("PRAGMA");

      if (isRead || hasReturning) {
        const rows = await db.all(text, params);
        return { rows };
      }

      const result = await db.run(text, params);
      return { rows: [], rowCount: result.changes || 0 };
    },
    hasColumn,
    ready: dbPromise,
    isPostgres: false,
    pool: null,
  };
}
