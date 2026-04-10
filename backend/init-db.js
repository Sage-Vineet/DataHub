const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

async function initDb() {
  const db = await open({
    filename: './dev-database.db',
    driver: sqlite3.Database,
  });

  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON');

  // Run schema
  const schemaPath = path.join(__dirname, 'sqlite-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await db.exec(schema);

  console.log('✅ Database schema initialized');
  await db.close();
}

initDb().catch(console.error);