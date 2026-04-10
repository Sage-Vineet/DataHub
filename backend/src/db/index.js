const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

let dbPromise;

if (isProduction) {
  const { Pool } = require("pg");
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  module.exports = {
    query: (text, params) => db.query(text, params),
    pool: db,
  };
} else {
  const initializeDb = async () => {
    const dbPath = './dev-database.db';
    const isNewDb = !fs.existsSync(dbPath);

    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    await db.exec('PRAGMA foreign_keys = ON');

    if (isNewDb) {
      console.log('📋 Initializing SQLite database schema...');
      const schemaPath = path.join(__dirname, '../../sqlite-schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await db.exec(schema);
      console.log('✅ Database schema initialized');
    }

    try {
      const groupColumns = await db.all("PRAGMA table_info(buyer_groups)");
      const hasDescription = groupColumns.some((col) => col.name === 'description');
      if (!hasDescription) {
        await db.exec("ALTER TABLE buyer_groups ADD COLUMN description TEXT");
      }
    } catch (_err) {
    }

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
      const hasUploadId = documentColumns.some((col) => col.name === 'upload_id');
      if (!hasUploadId) {
        await db.exec("ALTER TABLE documents ADD COLUMN upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL");
      }

      await db.exec("CREATE INDEX IF NOT EXISTS idx_documents_upload_id ON documents(upload_id)");
    } catch (_err) {
    }

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          txn_date TEXT NOT NULL,
          narration TEXT,
          amount REAL NOT NULL
        )
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS reconciliation_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          txn_date TEXT NOT NULL,
          amount REAL NOT NULL,
          name TEXT,
          transaction_type TEXT
        )
      `);
    } catch (_err) {
    }

    return db;
  };

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
    pool: null,
  };
}
