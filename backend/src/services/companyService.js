const { supabase } = require("../db");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

async function getAllCompanies() {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return attachCompanyStats(data || []);
}

async function getCompaniesForUser(user) {
  const role = String(user?.role || "").toLowerCase();
  let query = supabase
    .from("companies")
    .select("*")
    .order("created_at", { ascending: false });

  if (role !== "admin") {
    const companyIds = Array.from(
      new Set([
        ...(user?.company_ids || []),
        ...((user?.assigned_companies || []).map((company) => company.id)),
        user?.company_id,
      ].filter(Boolean).map(String)),
    );
    if (!companyIds.length) return [];
    query = query.in("id", companyIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  return attachCompanyStats(data || []);
}

async function getCompanyById(id) {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return attachCompanyStats(data);
}

async function createCompany(companyData) {
  const { data, error } = await supabase
    .from("companies")
    .insert({
      name: companyData.name,
      project_name: companyData.project_name || null,
      industry: companyData.industry || null,
      status: companyData.status || "active",
      since: companyData.since || null,
      logo: companyData.logo || null,
      contact_name: companyData.contact_name,
      contact_email: companyData.contact_email,
      contact_phone: companyData.contact_phone || null,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function assignCompanyToUser(userId, companyId) {
  if (!userId || !companyId) return;
  const { error } = await supabase
    .from("user_companies")
    .upsert({ user_id: userId, company_id: companyId }, { onConflict: "user_id,company_id" });
  if (error) throw error;
}

async function updateCompany(id, companyData) {
  const now = new Date().toISOString();

  const patch = {
    updated_at: now,
  };

  // Map only the fields present in companyData to avoid clobbering
  // data-source columns (quickbooks_connected, etc.) managed elsewhere.
  const mappable = {
    name: companyData.name,
    project_name: companyData.project_name ?? null,
    industry: companyData.industry,
    status: companyData.status,
    since: companyData.since,
    logo: companyData.logo,
    contact_name: companyData.contact_name,
    contact_email: companyData.contact_email,
    contact_phone: companyData.contact_phone,
  };

  for (const [key, value] of Object.entries(mappable)) {
    if (value !== undefined) patch[key] = value ?? null;
  }

  const { data, error } = await supabase
    .from("companies")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
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
      .select("id, role, company_id")
      .eq("company_id", previousCompany.id)
      .eq("role", "buyer")
      .ilike("email", previousNormalizedEmail)
      .maybeSingle();

    existingUser = previousContactUsers || null;
  }

  if (!existingUser) {
    const { data: users } = await supabase
      .from("users")
      .select("id, role, company_id")
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

  if (
    existingUser &&
    existingUser.company_id &&
    String(existingUser.company_id) !== String(company.id) &&
    String(existingUser.company_id) !== String(previousCompany?.id || "")
  ) {
    const err = new Error("A client account with this contact email already belongs to another company.");
    err.status = 409;
    throw err;
  }

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

async function deleteCompany(id) {
  // 1. Nullify users.company_id for any users whose primary company is this one
  const { error: userUnlinkErr } = await supabase
    .from("users")
    .update({ company_id: null })
    .eq("company_id", id);
  if (userUnlinkErr) throw userUnlinkErr;

  // 2. Remove user_companies join-table rows referencing this company
  const { error: ucErr } = await supabase
    .from("user_companies")
    .delete()
    .eq("company_id", id);
  if (ucErr) throw ucErr;

  // 3. Now delete the company itself
  const { error } = await supabase
    .from("companies")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

module.exports = {
  getAllCompanies,
  getCompaniesForUser,
  getCompanyById,
  createCompany,
  assignCompanyToUser,
  updateCompany,
  deleteCompany,
  syncCompanyClientRepresentative,
  attachCompanyStats,
};
