const { supabase } = require("../db");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return _pool;
}

async function getAllCompanies() {
  const { data: companies, error } = await supabase
    .from("companies")
    .select("*")
    .order("created_at", { ascending: false });

  if (!error) return await attachCompanyStats(companies || []);

  // Supabase quota fallback
  const pool = getPool();
  if (!pool) throw error;
  const { rows } = await pool.query("SELECT * FROM companies ORDER BY created_at DESC");
  return await attachCompanyStats(rows);
}

async function getCompanyById(id) {
  const { data: company, error } = await supabase
    .from("companies")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!error) {
    if (!company) return null;
    return await attachCompanyStats(company);
  }

  // Supabase quota fallback
  const pool = getPool();
  if (!pool) throw error;
  const { rows } = await pool.query("SELECT * FROM companies WHERE id = $1 LIMIT 1", [id]);
  if (!rows[0]) return null;
  return await attachCompanyStats(rows[0]);
}

async function createCompany(companyData) {
  const { data: inserted, error } = await supabase
    .from("companies")
    .insert({
      name: companyData.name,
      industry: companyData.industry,
      status: companyData.status || "active",
      since: companyData.since || null,
      logo: companyData.logo || null,
      contact_name: companyData.contact_name,
      contact_email: companyData.contact_email,
      contact_phone: companyData.contact_phone,
    })
    .select("*")
    .single();

  if (!error) return inserted;

  // Supabase quota fallback
  const pool = getPool();
  if (!pool) throw error;
  const { rows } = await pool.query(
    `INSERT INTO companies (name, industry, status, since, logo, contact_name, contact_email, contact_phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      companyData.name, companyData.industry, companyData.status || "active",
      companyData.since || null, companyData.logo || null,
      companyData.contact_name, companyData.contact_email, companyData.contact_phone,
    ],
  );
  return rows[0];
}

const ALLOWED_COMPANY_COLUMNS = new Set([
  "name", "industry", "status", "since", "logo",
  "contact_name", "contact_email", "contact_phone", "updated_at",
]);

async function updateCompany(id, companyData) {
  const updates = { ...companyData, updated_at: new Date().toISOString() };

  const { data: updated, error } = await supabase
    .from("companies")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (!error) return updated;

  // Supabase quota fallback
  const pool = getPool();
  if (!pool) throw error;

  const keys = Object.keys(updates).filter((k) => ALLOWED_COMPANY_COLUMNS.has(k));
  if (!keys.length) throw new Error("No valid fields to update");
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
  const values = [...keys.map((k) => updates[k]), id];

  const { rows } = await pool.query(
    `UPDATE companies SET ${setClauses} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0];
}

async function syncCompanyClientRepresentative(company, previousCompany = null) {
  if (!company?.id || !company.contact_email || !company.contact_name) return null;

  const normalizedEmail = String(company.contact_email).trim().toLowerCase();
  if (!normalizedEmail) return null;

  const previousNormalizedEmail = String(previousCompany?.contact_email || "").trim().toLowerCase();

  let existingUser = null;

  if (
    previousCompany?.id &&
    previousNormalizedEmail &&
    previousNormalizedEmail !== normalizedEmail
  ) {
    const { data: previousContactUsers } = await supabase
      .from("users")
      .select("id, role")
      .eq("company_id", previousCompany.id)
      .eq("role", "buyer")
      .ilike("email", previousNormalizedEmail)
      .maybeSingle();

    existingUser = previousContactUsers || null;
  }

  if (!existingUser) {
    const { data: users } = await supabase
      .from("users")
      .select("id, role")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    existingUser = users || null;
  }

  // Postgres fallback for user lookup
  if (!existingUser) {
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          "SELECT id, role FROM users WHERE lower(email) = lower($1) LIMIT 1",
          [normalizedEmail],
        );
        existingUser = rows[0] || null;
      } catch { /* ignore */ }
    }
  }

  if (existingUser && existingUser.role !== "buyer") return existingUser.id;

  if (existingUser) {
    const pool = getPool();
    if (pool) {
      await pool.query(
        `UPDATE users SET name=$1, email=$2, phone=$3, company_id=$4, status='active', updated_at=now()
         WHERE id=$5`,
        [company.contact_name, normalizedEmail, company.contact_phone || null, company.id, existingUser.id],
      );
      await pool.query(
        `INSERT INTO user_companies (user_id, company_id) VALUES ($1, $2)
         ON CONFLICT (user_id, company_id) DO NOTHING`,
        [existingUser.id, company.id],
      );
    } else {
      await supabase.from("users").update({
        name: company.contact_name, email: normalizedEmail,
        phone: company.contact_phone || null, company_id: company.id,
        status: "active", updated_at: new Date().toISOString(),
      }).eq("id", existingUser.id);
      await supabase.from("user_companies")
        .upsert({ user_id: existingUser.id, company_id: company.id }, { onConflict: "user_id,company_id" });
    }
    return existingUser.id;
  }

  // Create new buyer
  const passwordHash = await bcrypt.hash(CLIENT_STATIC_PASSWORD, 10);
  const pool = getPool();
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, company_id, status)
       VALUES ($1, $2, $3, $4, 'buyer', $5, 'active') RETURNING id`,
      [company.contact_name, normalizedEmail, company.contact_phone || null, passwordHash, company.id],
    );
    const userId = rows[0]?.id;
    if (userId) {
      await pool.query(
        `INSERT INTO user_companies (user_id, company_id) VALUES ($1, $2)
         ON CONFLICT (user_id, company_id) DO NOTHING`,
        [userId, company.id],
      );
    }
    return userId || null;
  }

  const { data: createdUser, error: insertError } = await supabase
    .from("users")
    .insert({
      name: company.contact_name, email: normalizedEmail,
      phone: company.contact_phone || null, password_hash: passwordHash,
      role: "buyer", company_id: company.id, status: "active",
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("❌ Error creating company representative:", insertError.message);
    return null;
  }

  if (createdUser) {
    await supabase.from("user_companies")
      .upsert({ user_id: createdUser.id, company_id: company.id }, { onConflict: "user_id,company_id" });
  }
  return createdUser?.id || null;
}

async function attachCompanyStats(companies) {
  const isSingle = !Array.isArray(companies);
  const companyList = isSingle ? [companies] : companies;
  if (!companyList.length) return companies;

  const companyIds = companyList.map((c) => c.id);

  // Try Supabase first
  const { data: counts, error: countsError } = await supabase
    .from("requests")
    .select("company_id, status")
    .in("company_id", companyIds);

  let requestRows = null;

  if (!countsError) {
    requestRows = counts;
  } else {
    // Supabase quota fallback
    const pool = getPool();
    if (pool) {
      try {
        const placeholders = companyIds.map((_, i) => `$${i + 1}`).join(",");
        const { rows } = await pool.query(
          `SELECT company_id, status FROM requests WHERE company_id IN (${placeholders})`,
          companyIds,
        );
        requestRows = rows;
      } catch (pgErr) {
        console.error("❌ Error fetching company stats (pg):", pgErr.message);
      }
    } else {
      console.error("❌ Error fetching company stats:", countsError.message);
    }
  }

  const enriched = companyList.map((company) => {
    const companyRequests = (requestRows || []).filter(
      (r) => String(r.company_id) === String(company.id),
    );
    return {
      ...company,
      request_count: companyRequests.length,
      pending_request_count: companyRequests.filter((r) => r.status === "pending").length,
      completed_request_count: companyRequests.filter((r) => r.status === "completed").length,
    };
  });

  return isSingle ? enriched[0] : enriched;
}

module.exports = {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  syncCompanyClientRepresentative,
  attachCompanyStats,
};
