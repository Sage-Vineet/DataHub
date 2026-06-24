const { supabase } = require("../db");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";
const PROFIT_METRIC_VALUES = Object.freeze({
  ADJUSTED_EBITDA: "adjusted_ebitda",
  SDE: "sde",
});

function normalizeOptionalText(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeOptionalEmail(value) {
  return value == null ? "" : String(value).trim().toLowerCase();
}

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
    });
    _pool.on("error", (err) => console.error("[companyService] pg pool error:", err.message));
  }
  return _pool;
}

function normalizeProfitMetric(value, fallback = PROFIT_METRIC_VALUES.ADJUSTED_EBITDA) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return fallback;

  if (
    normalized === PROFIT_METRIC_VALUES.SDE ||
    normalized === "seller_discretionary_earnings" ||
    normalized === "sellers_discretionary_earnings" ||
    normalized === "seller's_discretionary_earnings"
  ) {
    return PROFIT_METRIC_VALUES.SDE;
  }

  if (
    normalized === PROFIT_METRIC_VALUES.ADJUSTED_EBITDA ||
    normalized === "adj_ebitda" ||
    normalized === "adjusted_ebitda" ||
    normalized === "ebitda"
  ) {
    return PROFIT_METRIC_VALUES.ADJUSTED_EBITDA;
  }

  return fallback;
}

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
      contact_name: normalizeOptionalText(companyData.contact_name),
      contact_email: normalizeOptionalEmail(companyData.contact_email),
      contact_phone: normalizeOptionalText(companyData.contact_phone),
      profit_metric: normalizeProfitMetric(companyData.profit_metric ?? companyData.profitMetric),
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
    contact_email: companyData.contact_email !== undefined ? (companyData.contact_email ? String(companyData.contact_email).trim().toLowerCase() : null) : undefined,
    contact_phone: companyData.contact_phone,
    profit_metric: companyData.profit_metric ?? companyData.profitMetric,
  };

  for (const [key, value] of Object.entries(mappable)) {
    if (value !== undefined) {
      patch[key] = key === "profit_metric" ? normalizeProfitMetric(value) : value ?? null;
    }
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
      .in("role", ["buyer", "client"])
      .ilike("email", previousNormalizedEmail)
      .maybeSingle();

    existingUser = previousContactUsers || null;
  }

  if (!existingUser) {
    // Try Supabase first; fall back to Postgres if quota-blocked
    const { data: users, error: lookupErr } = await supabase
      .from("users")
      .select("id, role, company_id")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (!lookupErr) {
      existingUser = users || null;
    } else {
      const pool = getPool();
      if (pool) {
        try {
          const { rows } = await pool.query(
            "SELECT id, role, company_id FROM users WHERE lower(email) = lower($1) LIMIT 1",
            [normalizedEmail],
          );
          existingUser = rows[0] || null;
        } catch { /* ignore */ }
      }
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
    const { error: updateErr } = await supabase.from("users").update({
      name: company.contact_name, email: normalizedEmail,
      phone: company.contact_phone || null, company_id: company.id,
      sub_role: existingUser.sub_role || "company_owner",
      status: "active", updated_at: new Date().toISOString(),
    }).eq("id", existingUser.id);

    if (updateErr) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            `UPDATE users SET name=$1, email=$2, phone=$3, company_id=$4, status='active', updated_at=now() WHERE id=$5`,
            [company.contact_name, normalizedEmail, company.contact_phone || null, company.id, existingUser.id],
          );
        } catch { /* ignore */ }
      }
    }

    const { error: ucErr } = await supabase.from("user_companies")
      .upsert({ user_id: existingUser.id, company_id: company.id }, { onConflict: "user_id,company_id" });
    if (ucErr) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO user_companies (user_id, company_id) VALUES ($1, $2) ON CONFLICT (user_id, company_id) DO NOTHING`,
            [existingUser.id, company.id],
          );
        } catch { /* ignore */ }
      }
    }
    return existingUser.id;
  }

  // Create new buyer — Supabase first, Postgres fallback
  const passwordHash = await bcrypt.hash(CLIENT_STATIC_PASSWORD, 10);

  const { data: createdUser, error: insertError } = await supabase
    .from("users")
    .insert({
      name: company.contact_name, email: normalizedEmail,
      phone: company.contact_phone || null, password_hash: passwordHash,
      role: "buyer", sub_role: "company_owner", company_id: company.id, status: "active",
    })
    .select("id")
    .single();

  let userId = createdUser?.id || null;

  if (insertError) {
    // Supabase insert failed — try Postgres
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (name, email, phone, password_hash, role, sub_role, company_id, status)
           VALUES ($1, $2, $3, $4, 'buyer', 'company_owner', $5, 'active') RETURNING id`,
          [company.contact_name, normalizedEmail, company.contact_phone || null, passwordHash, company.id],
        );
        userId = rows[0]?.id || null;
      } catch (pgErr) {
        console.error("❌ Error creating company representative (pg):", pgErr.message);
        return null;
      }
    } else {
      console.error("❌ Error creating company representative:", insertError.message);
      return null;
    }
  }

  if (userId) {
    const { error: ucErr } = await supabase.from("user_companies")
      .upsert({ user_id: userId, company_id: company.id }, { onConflict: "user_id,company_id" });
    if (ucErr) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO user_companies (user_id, company_id) VALUES ($1, $2) ON CONFLICT (user_id, company_id) DO NOTHING`,
            [userId, company.id],
          );
        } catch { /* ignore */ }
      }
    }
  }
  return userId;
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
  // Fetch IDs needed for tables that lack a direct company_id column.
  const [{ data: folderRows }, { data: requestRows }, { data: groupRows }] = await Promise.all([
    supabase.from("folders").select("id").eq("company_id", id),
    supabase.from("requests").select("id").eq("company_id", id),
    supabase.from("buyer_groups").select("id").eq("company_id", id),
  ]);

  const folderIds  = (folderRows  || []).map((r) => r.id);
  const requestIds = (requestRows || []).map((r) => r.id);
  const groupIds   = (groupRows   || []).map((r) => r.id);

  // Step 1 — nested tables (no company_id column; must be deleted before their parents).
  const nested = [];
  if (folderIds.length)  nested.push(supabase.from("folder_access").delete().in("folder_id", folderIds));
  if (requestIds.length) nested.push(
    supabase.from("request_documents").delete().in("request_id", requestIds),
    supabase.from("request_narratives").delete().in("request_id", requestIds),
    supabase.from("request_reminders").delete().in("request_id", requestIds),
  );
  if (groupIds.length)   nested.push(supabase.from("buyer_group_members").delete().in("group_id", groupIds));
  await Promise.all(nested);

  // Step 2 — all tables with a direct company_id FK, in safe dependency order.
  const directTables = [
    "documents",
    "requests",
    "folders",
    "reminders",
    "activity_log",
    "company_messages",
    "direct_messages",
    "buyer_groups",
    "manual_gl_staged_transactions",
    "manual_gl_balance_sheet_lines",
    "manual_gl_batches",
    "report_source_records",
    "user_companies",
  ];
  for (const table of directTables) {
    const { error } = await supabase.from(table).delete().eq("company_id", id);
    if (error) console.error(`[deleteCompany] cleanup ${table}:`, error.message);
  }

  // Step 3 — unlink users whose primary company was this one (SET NULL, not delete).
  await supabase.from("users").update({ company_id: null }).eq("company_id", id);

  // Step 4 — delete the company.
  const { error } = await supabase.from("companies").delete().eq("id", id);
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
