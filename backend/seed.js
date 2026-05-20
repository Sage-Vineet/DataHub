/**
 * Seed script — run once after clearing the database to restore demo users.
 * Uses direct Postgres connection (pg) to bypass Supabase HTTP API quota restriction.
 * Usage: node seed.js
 */
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const COMPANIES = [
  { name: "Dataroom",     industry: "Technology", contact_name: "Rajesh Sharma", contact_email: "broker@leo.com",     contact_phone: "+91-9000000001" },
  { name: "DataHub",      industry: "Technology", contact_name: "System Admin",  contact_email: "admin@datahub.com",  contact_phone: "+91-9000000002" },
  { name: "Demo Company", industry: "Technology", contact_name: "Demo User",     contact_email: "demo@leo.com",       contact_phone: "+91-9000000003" },
  { name: "Infosys Ltd.", industry: "Technology", contact_name: "Ananya Mehta",  contact_email: "client@infosys.com", contact_phone: "+91-9000000004" },
];

const USERS = [
  { email: "broker@leo.com",     name: "Rajesh Sharma", role: "broker", password: "broker123", companyName: "Dataroom"     },
  { email: "admin@datahub.com",  name: "System Admin",  role: "admin",  password: "admin123",  companyName: "DataHub"      },
  { email: "admin@leo.com",      name: "System Admin",  role: "admin",  password: "admin123",  companyName: "DataHub"      },
  { email: "demo@leo.com",       name: "Demo User",     role: "buyer",  password: "123456",    companyName: "Demo Company" },
  { email: "client@infosys.com", name: "Ananya Mehta",  role: "buyer",  password: "123456",    companyName: "Infosys Ltd." },
];

async function seedCompanies(client) {
  const companyIdMap = {};

  for (const company of COMPANIES) {
    const { rows: existing } = await client.query(
      "SELECT id, name FROM companies WHERE name = $1",
      [company.name],
    );

    if (existing.length > 0) {
      console.log(`  ✓ Company already exists: ${company.name}`);
      companyIdMap[company.name] = existing[0].id;
      continue;
    }

    const { rows: created } = await client.query(
      `INSERT INTO companies (name, industry, contact_name, contact_email, contact_phone, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, name`,
      [company.name, company.industry, company.contact_name, company.contact_email, company.contact_phone],
    );

    console.log(`  ✓ Created company: ${company.name} (${created[0].id})`);
    companyIdMap[company.name] = created[0].id;
  }

  return companyIdMap;
}

async function seedUsers(client, companyIdMap) {
  for (const user of USERS) {
    const { rows: existing } = await client.query(
      "SELECT id, email FROM users WHERE email = $1",
      [user.email],
    );

    if (existing.length > 0) {
      console.log(`  ✓ User already exists: ${user.email}`);
      continue;
    }

    const companyId = companyIdMap[user.companyName] || null;

    const { rows: created } = await client.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, email`,
      [user.name, user.email, user.password, user.role, companyId],
    );

    console.log(`  ✓ Created user: ${user.email} (${created[0].id})`);

    if (companyId) {
      await client.query(
        `INSERT INTO user_companies (user_id, company_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, company_id) DO NOTHING`,
        [created[0].id, companyId],
      );
    }
  }
}

async function main() {
  console.log("\n=== DataHub Database Seed (direct Postgres) ===\n");

  const client = await pool.connect();
  try {
    console.log("Seeding companies...");
    const companyIdMap = await seedCompanies(client);

    console.log("\nSeeding users...");
    await seedUsers(client, companyIdMap);

    console.log("\n✅ Seed complete.\n");
    console.log("Demo credentials:");
    console.log("  broker@leo.com     / broker123");
    console.log("  admin@datahub.com  / admin123");
    console.log("  admin@leo.com      / admin123");
    console.log("  demo@leo.com       / 123456");
    console.log("  client@infosys.com / 123456\n");
  } catch (err) {
    console.error("\n✗ Seed error:", err.message);
    if (err.message.includes("read-only") || err.message.includes("quota")) {
      console.log("\n⚠ The database is in read-only mode due to storage quota.");
      console.log("  Go to your Supabase dashboard → SQL Editor and run:");
      console.log("  VACUUM FULL;");
      console.log("  Then wait a few minutes and run this script again.\n");
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
