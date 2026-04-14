const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
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