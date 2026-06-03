const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { supabase } = require("../db");

let _authPool = null;
function getAuthPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_authPool) {
    _authPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    _authPool.on("error", () => { });
  }
  return _authPool;
}
const { attachAssignedCompanies, flattenUser, getUserByEmail, getUserById } = require("./userService");
const { CLIENT_STATIC_PASSWORD } = require("../config/demoUsers");
const { invalidateUserCache } = require("../middleware/auth");

/**
 * Signs a JWT token for a user
 * @param {string} userId - User ID
 * @returns {string} Signed token
 */
function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET || "change_me", {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone() {
  return true;
}

async function setBrokerCompanyProfile(userId, brokerCompany) {
  if (!brokerCompany) return;
  const { error } = await supabase
    .from("users")
    .update({ broker_company: brokerCompany })
    .eq("id", userId);

  const missingColumn = error && (
    error.code === "42703" ||
    error.message?.toLowerCase().includes("broker_company") ||
    error.message?.toLowerCase().includes("column")
  );

  if (error && !missingColumn) throw error;
}

/**
 * Syncs user company assignment in the join table
 */
async function syncUserCompanyAssignment(userId, companyId) {
  if (!userId || !companyId) return;
  const { error } = await supabase
    .from("user_companies")
    .upsert({ user_id: userId, company_id: companyId }, { onConflict: "user_id,company_id" });

  if (error) {
    console.error("❌ Error syncing user company assignment via Supabase:", error.message);
    // Pg fallback — critical for post-migration state where Supabase RLS may block
    const pool = getAuthPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO user_companies (user_id, company_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, company_id) DO NOTHING`,
          [userId, companyId],
        );
      } catch (pgErr) {
        console.error("❌ pg fallback for syncUserCompanyAssignment also failed:", pgErr.message);
      }
    }
  }
}

/**
 * Creates default folders for a company if they don't exist
 */
async function ensureDefaultFolders(companyId, createdBy) {
  if (!companyId || !createdBy) return;

  const { data: existing, error: findError } = await supabase
    .from("folders")
    .select("id")
    .eq("company_id", companyId)
    .limit(1);

  if (findError || (existing && existing.length > 0)) return;

  const defaults = ["Finance", "Compliance", "HR", "Legal", "M&A", "Tax", "Other"];
  const folders = defaults.map(name => ({
    company_id: companyId,
    parent_id: null,
    name,
    color: null,
    created_by: createdBy
  }));

  const { error: insertError } = await supabase.from("folders").insert(folders);
  if (insertError) console.error("❌ Error creating default folders:", insertError.message);
}

/**
 * Validates user credentials against stored database users.
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} { user, token }
 */
async function authenticate(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const rawPassword = String(password || "");
  if (!normalizedEmail || !rawPassword) throw new Error("Invalid credentials");

  const user = await getUserByEmail(normalizedEmail);
  if (!user || String(user.status || "").toLowerCase() === "inactive") {
    throw new Error("Invalid credentials");
  }

  let freshUser = user;

  const isClientUser = user.role === "buyer" || user.role === "client";

  if (isClientUser && rawPassword === CLIENT_STATIC_PASSWORD) {
    // Static-password path: sync company assignment then re-fetch.
    // If company_id is missing (orphaned post-migration account), try to recover
    // it by matching the user's email against companies.contact_email.
    let resolvedCompanyId = user.company_id;
    if (!resolvedCompanyId) {
      const { data: matched } = await supabase
        .from("companies")
        .select("id")
        .ilike("contact_email", normalizedEmail)
        .maybeSingle();
      if (matched?.id) {
        resolvedCompanyId = matched.id;
        await supabase.from("users").update({ company_id: resolvedCompanyId }).eq("id", user.id);
      }
    }
    if (resolvedCompanyId) {
      await syncUserCompanyAssignment(user.id, resolvedCompanyId);
      await ensureDefaultFolders(resolvedCompanyId, user.id);
    }
  } else {
    // Standard credential check for all other users / passwords.
    const { data: authData } = await supabase
      .from("users")
      .select("password_hash")
      .eq("id", user.id)
      .single();

    const storedPassword = authData?.password_hash;
    let ok = rawPassword === storedPassword;

    if (storedPassword && /^\$2[aby]\$/.test(storedPassword)) {
      try {
        ok = await bcrypt.compare(rawPassword, storedPassword);
      } catch {
        ok = false;
      }
    }

    if (!ok) throw new Error("Invalid credentials");

    // For client/buyer users with a custom password, still sync the company
    // association so user_companies is populated after a DB migration
    // that left the join table empty. Also recover company_id via email if missing.
    if (isClientUser) {
      let resolvedCompanyId = user.company_id;
      if (!resolvedCompanyId) {
        const { data: matched } = await supabase
          .from("companies")
          .select("id")
          .ilike("contact_email", normalizedEmail)
          .maybeSingle();
        if (matched?.id) {
          resolvedCompanyId = matched.id;
          await supabase.from("users").update({ company_id: resolvedCompanyId }).eq("id", user.id);
        }
      }
      if (resolvedCompanyId) {
        await syncUserCompanyAssignment(user.id, resolvedCompanyId);
      }
    }
  }

  // Always re-fetch client/buyer users so the response and the 60-second
  // cache both contain the correct effective_role and company_ids.
  if (isClientUser) {
    freshUser = (await getUserById(user.id)) || user;
  }

  // Clear any stale cached user so requireAuth fetches fresh data on the next request.
  invalidateUserCache(freshUser.id);

  const token = signToken(freshUser.id);

  // Final cleanup of user object for response
  const safeUser = { ...freshUser };
  delete safeUser.password_hash;

  return { user: safeUser, token };
}

async function createBrokerAccount(payload = {}) {
  const name = normalizeText(payload.name);
  const email = normalizeEmail(payload.email);
  const phone = normalizeText(payload.phone);
  const password = String(payload.password || "");
  const brokerCompany = normalizeText(payload.broker_company || payload.brokerCompany);

  if (!name) {
    const error = new Error("Full name is required.");
    error.status = 400;
    throw error;
  }
  if (!email || !isValidEmail(email)) {
    const error = new Error("Please enter a valid email address.");
    error.status = 400;
    throw error;
  }
  if (!password || password.length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.status = 400;
    throw error;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    const error = new Error("Password must include at least one letter and one number.");
    error.status = 400;
    throw error;
  }
  if (!isValidPhone(phone)) {
    const error = new Error("Please enter a valid phone number.");
    error.status = 400;
    throw error;
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    const error = new Error("An account with this email already exists.");
    error.status = 409;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: created, error } = await supabase
    .from("users")
    .insert({
      name,
      email,
      phone: phone || null,
      password_hash: passwordHash,
      role: "broker",
      company_id: null,
      status: "active",
    })
    .select(`
      id, name, email, phone, role, company_id, status, created_at, updated_at,
      companies:company_id ( name )
    `)
    .single();

  if (error) {
    if (error.code === "23505") {
      const duplicate = new Error("An account with this email already exists.");
      duplicate.status = 409;
      throw duplicate;
    }
    throw error;
  }

  await setBrokerCompanyProfile(created.id, brokerCompany);

  const user = await attachAssignedCompanies(flattenUser({
    ...created,
    broker_company: brokerCompany || null,
  }));
  const token = signToken(user.id);

  return { user, token };
}

module.exports = {
  authenticate,
  createBrokerAccount,
  signToken,
  ensureDefaultFolders
};
