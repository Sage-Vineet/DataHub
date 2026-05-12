const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for direct database operations");
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
    ssl: process.env.DATABASE_URL.includes("supabase.com")
      ? { rejectUnauthorized: false }
      : undefined,
  });
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

module.exports = {
  query,
};
