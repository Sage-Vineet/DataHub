const { supabase } = require("../db");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { CLIENT_SUB_ROLES } = require("../constants/roles");

// Sub-roles that belong to the client side of the platform.
// Users with these sub_roles always receive effective_role = "client",
// giving them full access to the client portal (file manager, documents, etc.).
const CLIENT_SIDE_SUB_ROLES = ['company_owner', 'client_team_member', 'client_accountant'];

let profilePool = null;
let profileFallbackCooldownUntil = 0;
let _pgOpenUntil = 0;
const PROFILE_FALLBACK_COOLDOWN_MS = 60 * 1000;

function isProfileFallbackCoolingDown() {
  return Date.now() < profileFallbackCooldownUntil;
}

function markProfileFallbackCooldown(error) {
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("terminated") ||
    message.includes("econn") ||
    message.includes("could not connect")
  ) {
    profileFallbackCooldownUntil = Date.now() + PROFILE_FALLBACK_COOLDOWN_MS;
  }
}

function getProfilePool() {
  if (!process.env.DATABASE_URL) return null;
  if (!profilePool) {
    profilePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    profilePool.on("error", () => { }); // suppress unhandled pool errors
  }
  return profilePool;
}

// Base select — safe columns PostgREST always knows about.
const userSelect = `
  id,
  name,
  email,
  phone,
  role,
  company_id,
  status,
  created_at,
  updated_at,
  companies:company_id ( name )
`;

// Extended select with profile columns. Falls back to userSelect if the
// columns haven't been created yet (migration not yet run).
const userSelectWithProfile =
  userSelect.trimEnd() + `,\n  date_of_birth,\n  occupation,\n  address,\n  broker_company\n`;

// Extended select including multi-role columns from migration 041.
// Falls back gracefully — callers must handle the case where these columns
// are absent (supabase schema cache not yet refreshed).
const userSelectWithRoles =
  userSelectWithProfile.trimEnd() +
  `,\n  sub_role,\n  designation,\n  buyer_company_name,\n  parent_user_id\n`;

async function selectUserRow(buildQuery) {
  // Try fullest select first, fall back on schema-cache misses
  let result = await buildQuery(userSelectWithRoles);
  if (result.error) result = await buildQuery(userSelectWithProfile);
  if (result.error) result = await buildQuery(userSelect);
  return result;
}

async function getSqlProfileByEmail(email) {
  const normalizedEmail = String(email || "").trim();
  if (!normalizedEmail) return {};

  // Circuit breaker: skip Postgres entirely while it's known to be unreachable
  if (Date.now() < _pgOpenUntil) return {};

  const pool = getProfilePool();
  if (!pool) return {};

  try {
    const { rows } = await pool.query(
      `SELECT date_of_birth, occupation, address, broker_company
       FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [normalizedEmail],
    );
    return rows[0] || {};
  } catch (err) {
    markProfileFallbackCooldown(err);
    console.warn("Profile SQL fallback read failed:", err.message);
    const isNetworkErr = err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED" ||
      /timeout|ETIMEDOUT|ECONNREFUSED|terminated/i.test(err.message);
    if (isNetworkErr) {
      _pgOpenUntil = Date.now() + 60_000; // open circuit for 60 s
      console.warn("[userService] Postgres unreachable — skipping SQL fallback for 60 s");
    } else {
      console.warn("Profile SQL fallback read failed:", err.message);
    }
    return {};
  }
}

async function mergeSqlProfile(user) {
  if (!user?.email) return user;
  if (
    user.date_of_birth !== undefined &&
    user.occupation !== undefined &&
    user.address !== undefined &&
    user.broker_company !== undefined
  ) {
    return user;
  }

  const profile = await getSqlProfileByEmail(user.email);
  return {
    ...user,
    date_of_birth: user.date_of_birth ?? profile.date_of_birth ?? null,
    occupation: user.occupation ?? profile.occupation ?? null,
    address: user.address ?? profile.address ?? null,
    broker_company: user.broker_company ?? profile.broker_company ?? null,
  };
}

async function updateSqlProfileByEmail(email, profileUpdates) {
  const normalizedEmail = String(email || "").trim();
  const pool = normalizedEmail ? getProfilePool() : null;
  const entries = Object.entries(profileUpdates).filter(([, value]) => value !== undefined);
  if (!pool || entries.length === 0) return false;

  const assignments = entries.map(([field], index) => `${field} = $${index + 2}`);
  const values = entries.map(([, value]) => value);

  try {
    const { rowCount } = await pool.query(
      `UPDATE users SET ${assignments.join(", ")}, updated_at = now() WHERE lower(email) = lower($1)`,
      [normalizedEmail, ...values],
    );
    return rowCount > 0;
  } catch (err) {
    console.warn("[updateSqlProfileByEmail] pg update failed:", err.message);
    return false;
  }
}

// Updates any set of allowed columns by user ID via direct pg connection
const _SAFE_UPDATE_COLS = new Set([
  "name", "email", "phone", "role", "status", "company_id",
  "date_of_birth", "occupation", "address", "broker_company", "password_hash",
  // multi-role columns (migration 041)
  "sub_role", "designation", "buyer_company_name", "parent_user_id",
]);

async function updateSqlById(id, updates) {
  const pool = getProfilePool();
  if (!pool) return false;
  const entries = Object.entries(updates).filter(([k, v]) => _SAFE_UPDATE_COLS.has(k) && v !== undefined);
  if (entries.length === 0) return false;
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
  const vals = entries.map(([, v]) => v);
  try {
    const { rowCount } = await pool.query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
      [id, ...vals],
    );
    return rowCount > 0;
  } catch (err) {
    console.warn("[updateSqlById] pg update failed:", err.message);
    return false;
  }
}

// Fetch a single column from users via direct pg (used as Supabase fallback)
async function getSqlUserField(id, column) {
  const pool = getProfilePool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(`SELECT ${column} FROM users WHERE id = $1 LIMIT 1`, [id]);
    return rows[0]?.[column] ?? null;
  } catch {
    return null;
  }
}

// Strips internal hostnames / credentials from DB errors before surfacing to the client
function sanitizeDbError(err) {
  const msg = String(err?.message || "");
  const isNetworkErr =
    err?.code === "ENOTFOUND" || err?.code === "ETIMEDOUT" || err?.code === "ECONNREFUSED" ||
    /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|supabase\.co|getaddrinfo|connection refused/i.test(msg);
  if (isNetworkErr) {
    const e = new Error("Unable to save changes. Please try again later.");
    e.status = 503;
    return e;
  }
  // Supabase PostgREST schema cache hasn't refreshed after a migration
  if (/schema cache|Could not find.*column|column.*not found/i.test(msg)) {
    const colMatch = msg.match(/['`"]?([\w_]+)['`"]?\s*column/i) || msg.match(/column\s*['`"]?([\w_]+)['`"]?/i);
    const col = colMatch?.[1] || "field";
    const e = new Error(
      `Cannot save '${col}': the database schema cache is stale. ` +
      `In Supabase → Settings → API, click "Reload schema cache", then retry.`,
    );
    e.status = 503;
    return e;
  }
  const clean = msg
    .replace(/\b[\w-]+\.supabase\.co\b/gi, "[db]")
    .replace(/postgresql:\/\/[^@]+@[^\s]+/gi, "[db]");
  const e = new Error(clean || "Failed to save changes.");
  e.status = err?.status || 500;
  return e;
}

/**
 * Flattens the user object to include company_name from the companies relation
 * @param {Object} user - User object from Supabase
 * @returns {Object} Flattened user object
 */
function flattenUser(user) {
  if (!user) return null;
  const flattened = {
    ...user,
    company_name: user.companies?.name || null
  };
  delete flattened.companies;
  return flattened;
}

/**
 * Minimal enrichment used when both Supabase and direct-Postgres are
 * unavailable.  Sets company_ids / assigned_companies from users.company_id
 * so canAccessCompany() still returns true for the user's primary company,
 * and sets effective_role to the DB role (buyer → "user" as a safe default)
 * so downstream filtering code never receives undefined.
 */
function _enrichFromCompanyIdOnly(userList, isSingle) {
  const enriched = userList.map((u) => ({
    ...u,
    effective_role: u.effective_role ?? (
      u.role === "buyer"
        ? (CLIENT_SIDE_SUB_ROLES.includes(u.sub_role) ? "client" : "user")
        : u.role === "client" ? "client" : u.role
    ),
    company_ids: u.company_ids ?? (u.company_id ? [String(u.company_id)] : []),
    assigned_companies: u.assigned_companies ?? (
      u.company_id ? [{ id: u.company_id, name: u.company_name || null }] : []
    ),
  }));
  return isSingle ? enriched[0] : enriched;
}

/**
 * Attaches assigned companies and calculates effective role for users.
 * Supports both single user object and array of users.
 * @param {Object|Array} users - User or users to enrich
 * @returns {Promise<Object|Array>} Enriched user(s)
 */
async function attachAssignedCompanies(users) {
  const isSingle = !Array.isArray(users);
  const userList = isSingle ? [users] : users;

  if (!userList || !userList.length) return users;

  const userIds = userList.map((user) => user.id).filter(Boolean);
  if (!userIds.length) return users;

  let { data: assignments, error } = await supabase
    .from("user_companies")
    .select(`
      user_id,
      company_id,
      companies:company_id (
        id, name, industry, status, contact_email
      )
    `)
    .in("user_id", userIds);

  if (error) {
    console.error("❌ Error fetching assigned companies via Supabase:", error.message);
    // Pg fallback — covers RLS blocks and network errors post-migration
    const pool = getProfilePool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT uc.user_id, uc.company_id,
                  c.id AS c_id, c.name, c.industry, c.status, c.contact_email
           FROM user_companies uc
           LEFT JOIN companies c ON c.id = uc.company_id
           WHERE uc.user_id = ANY($1)`,
          [userIds],
        );
        assignments = rows.map((r) => ({
          user_id: r.user_id,
          company_id: r.company_id,
          companies: r.c_id
            ? { id: r.c_id, name: r.name, industry: r.industry, status: r.status, contact_email: r.contact_email }
            : null,
        }));
      } catch (pgErr) {
        console.error("❌ pg fallback for user_companies also failed:", pgErr.message);
        // Both Supabase and direct-Postgres failed.  Fall back to the
        // minimal enrichment that can be derived from users.company_id alone
        // so canAccessCompany() still works and the user is not locked out.
        return _enrichFromCompanyIdOnly(userList, isSingle);
      }
    } else {
      return _enrichFromCompanyIdOnly(userList, isSingle);
    }
  }

  const byUserId = (assignments || []).reduce((map, uc) => {
    if (!uc.companies) return map;
    if (!map[uc.user_id]) map[uc.user_id] = [];
    map[uc.user_id].push(uc.companies);
    return map;
  }, {});

  const historicalBrokerCompaniesByUserId = await getHistoricalBrokerCompaniesByUserId(userList);
  for (const [userId, companies] of Object.entries(historicalBrokerCompaniesByUserId)) {
    if (!byUserId[userId]) byUserId[userId] = [];
    byUserId[userId].push(...companies);
  }

  // Batch-fetch contact_email for companies that appear only as user.company_id (no user_companies row)
  // This covers the post-migration case where user_companies is empty but company_id is set
  const missingCompanyIds = Array.from(new Set(
    userList
      .filter((u) => u.company_id && !(byUserId[u.id] || []).some((c) => String(c.id) === String(u.company_id)))
      .map((u) => String(u.company_id)),
  ));
  const fallbackCompanyMap = new Map();
  if (missingCompanyIds.length) {
    const { data: missingCompanies } = await supabase
      .from("companies")
      .select("id, name, contact_email")
      .in("id", missingCompanyIds);
    for (const c of missingCompanies || []) {
      fallbackCompanyMap.set(String(c.id), c);
    }
  }

  const enriched = userList.map((user) => {
    const assignedCompanies = dedupeCompanies(byUserId[user.id] || []);
    const hasPrimary = user.company_id && assignedCompanies.some((company) => String(company.id) === String(user.company_id));
    const fallbackCompany = user.company_id
      ? (fallbackCompanyMap.get(String(user.company_id)) || { id: user.company_id, name: user.company_name })
      : null;
    const normalizedCompanies = hasPrimary || !user.company_id
      ? assignedCompanies
      : [fallbackCompany, ...assignedCompanies];

    const normalizedEmail = String(user.email || "").trim().toLowerCase();
    const isSeller = normalizedCompanies.some((company) => (
      String(company.contact_email || "").trim().toLowerCase() === normalizedEmail
    ));
    const effectiveRole = user.role === "client"
      ? "client"
      : user.role === "buyer"
        ? (CLIENT_SIDE_SUB_ROLES.includes(user.sub_role) || isSeller ? "client" : "user")
        : user.role;

    return {
      ...user,
      effective_role: effectiveRole,
      company_ids: normalizedCompanies.map((company) => company.id).filter(Boolean),
      assigned_companies: normalizedCompanies,
    };
  });

  return isSingle ? enriched[0] : enriched;
}

function dedupeCompanies(companies) {
  const byId = new Map();
  for (const company of companies || []) {
    if (!company?.id) continue;
    const existing = byId.get(String(company.id)) || {};
    byId.set(String(company.id), { ...existing, ...company });
  }
  return Array.from(byId.values());
}

async function getHistoricalBrokerCompaniesByUserId(userList) {
  const brokerIds = userList
    .filter((user) => String(user?.role || "").toLowerCase() === "broker")
    .map((user) => user.id)
    .filter(Boolean);

  if (!brokerIds.length) return {};

  const [folderRows, requestRows, documentRows, activityRows, reminderRows] = await Promise.all([
    getCompanyActorRows("folders", "created_by", brokerIds),
    getCompanyActorRows("requests", "created_by", brokerIds),
    getCompanyActorRows("documents", "uploaded_by", brokerIds),
    getCompanyActorRows("activity_log", "created_by", brokerIds),
    getCompanyActorRows("reminders", "created_by", brokerIds),
  ]);

  const companyIdsByUserId = {};
  for (const row of [...folderRows, ...requestRows, ...documentRows, ...activityRows, ...reminderRows]) {
    const userId = row.created_by || row.uploaded_by;
    if (!userId || !row.company_id) continue;
    if (!companyIdsByUserId[userId]) companyIdsByUserId[userId] = new Set();
    companyIdsByUserId[userId].add(String(row.company_id));
  }

  const allCompanyIds = Array.from(new Set(
    Object.values(companyIdsByUserId).flatMap((set) => Array.from(set)),
  ));
  if (!allCompanyIds.length) return {};

  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name, industry, status, contact_email, project_name")
    .in("id", allCompanyIds);

  if (error) {
    console.error("❌ Error fetching historical broker companies:", error.message);
    return {};
  }

  const companyById = new Map((companies || []).map((company) => [String(company.id), company]));
  return Object.fromEntries(
    Object.entries(companyIdsByUserId).map(([userId, companyIds]) => [
      userId,
      Array.from(companyIds).map((companyId) => companyById.get(companyId)).filter(Boolean),
    ]),
  );
}

async function getCompanyActorRows(table, actorColumn, brokerIds) {
  const { data, error } = await supabase
    .from(table)
    .select(`company_id, ${actorColumn}`)
    .in(actorColumn, brokerIds)
    .limit(1000);

  if (error) {
    console.error(`❌ Error fetching ${table} broker company links:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Normalizes company IDs into a unique array of strings
 * @param {string} companyId - Primary company ID
 * @param {Array} companyIds - Additional company IDs
 * @returns {Array<string>} Unique company IDs
 */
function normalizeCompanyIds(companyId, companyIds) {
  const ids = Array.isArray(companyIds) ? companyIds : [];
  return Array.from(new Set([companyId, ...ids].filter(Boolean).map(String)));
}

/**
 * Extracts all unique company IDs associated with a user
 * @param {Object} user - User object
 * @returns {Array<string>} Unique company IDs
 */
function getUserCompanyIds(user) {
  const ids = [
    ...(user?.company_ids || []),
    ...((user?.assigned_companies || []).map((c) => c.id)),
    user?.company_id,
    user?.companyId
  ];
  return Array.from(new Set(ids.filter(Boolean).map(String)));
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalizePhone(value) {
  return normalizeOptionalText(value);
}

function normalizeDateOfBirth(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return normalized;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const err = new Error("Please enter a valid date of birth.");
    err.status = 400;
    throw err;
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    const err = new Error("Please enter a valid date of birth.");
    err.status = 400;
    throw err;
  }

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (date > todayUtc) {
    const err = new Error("Date of birth cannot be in the future.");
    err.status = 400;
    throw err;
  }

  return normalized;
}

async function passwordMatches(candidate, storedPassword) {
  if (!storedPassword) return false;
  if (candidate === storedPassword) return true;
  if (/^\$2[aby]\$/.test(storedPassword)) {
    try {
      return await bcrypt.compare(candidate, storedPassword);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Checks if a user has access to a specific company
 * @param {Object} user - Authenticated user
 * @param {string} companyId - Company ID to check
 * @returns {boolean}
 */
function canAccessCompany(user, companyId) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "admin") return true;
  return getUserCompanyIds(user).includes(String(companyId));
}

function isAdmin(user) {
  return String(user?.role || "").toLowerCase() === "admin";
}

function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
}

/**
 * Syncs user company assignments in the join table
 * @param {string} userId - User ID
 * @param {Array<string>} companyIds - Array of company IDs
 */
async function syncUserCompanies(userId, companyIds) {
  if (!userId) return;

  // Delete existing
  await supabase.from("user_companies").delete().eq("user_id", userId);

  if (companyIds && companyIds.length > 0) {
    const records = companyIds.map(cid => ({ user_id: userId, company_id: cid }));
    await supabase.from("user_companies").upsert(records, { onConflict: "user_id,company_id" });
  }
}

/**
 * Gets a user by ID with enriched company data
 * @param {string} id - User ID
 * @returns {Promise<Object|null>} Enriched user object
 */
async function getUserById(id) {
  if (!id) return null;
  const { data, error } = await selectUserRow((sel) =>
    supabase.from("users").select(sel).eq("id", id).maybeSingle()
  );
  if (!error && data) {
    return await attachAssignedCompanies(await mergeSqlProfile(flattenUser(data)));
  }
  // Supabase quota fallback — query Postgres directly
  const pool = getProfilePool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.company_id,
              u.status, u.created_at, u.updated_at, u.password_hash,
              u.date_of_birth, u.occupation, u.address, u.broker_company,
              c.name AS company_name
       FROM users u LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.id = $1 LIMIT 1`,
      [id],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    const base = {
      id: r.id, name: r.name, email: r.email, phone: r.phone || null,
      role: r.role, company_id: r.company_id, company_name: r.company_name || null,
      password_hash: r.password_hash, status: r.status,
      date_of_birth: r.date_of_birth || null,
      occupation: r.occupation || null,
      address: r.address || null,
      broker_company: r.broker_company || null,
      created_at: r.created_at, updated_at: r.updated_at,
    };
    // Apply minimal enrichment so canAccessCompany() works even when
    // Supabase is unreachable and we can't run attachAssignedCompanies.
    return _enrichFromCompanyIdOnly([base], true);
  } catch (pgErr) {
    console.warn("[getUserById] Direct Postgres fallback failed:", pgErr.message);
    return null;
  }
}

/**
 * Gets a user by email with enriched company data
 * @param {string} email - User email
 * @returns {Promise<Object|null>} Enriched user object
 */
async function getUserByEmail(email) {
  if (!email) return null;
  const { data, error } = await selectUserRow((sel) =>
    supabase.from("users").select(sel).eq("email", email).maybeSingle()
  );
  if (!error && data) {
    return await attachAssignedCompanies(await mergeSqlProfile(flattenUser(data)));
  }

  // Supabase API unavailable (e.g. quota restriction) — fall back to direct Postgres
  const pool = getProfilePool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.company_id,
              u.status, u.created_at, u.updated_at, u.password_hash,
              c.name AS company_name
       FROM users u
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE lower(u.email) = lower($1)
       LIMIT 1`,
      [String(email).trim()],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    const base = {
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone || null,
      role: r.role,
      company_id: r.company_id,
      company_name: r.company_name || null,
      password_hash: r.password_hash,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    // Apply minimal enrichment so canAccessCompany() works even when
    // Supabase is unreachable and we can't run attachAssignedCompanies.
    return _enrichFromCompanyIdOnly([base], true);
  } catch (pgErr) {
    console.warn("[getUserByEmail] Direct Postgres fallback failed:", pgErr.message);
    return null;
  }
}

// ── Broker Team Invite helpers ───────────────────────────────────────────────

/**
 * Returns invited_broker_id values for all invites where team_owner_id = ownerId.
 */
async function getBrokerTeamInviteIds(ownerId) {
  if (!ownerId) return [];
  const { data, error } = await supabase
    .from("broker_team_invites")
    .select("invited_broker_id")
    .eq("team_owner_id", ownerId);
  if (error) {
    console.warn("[getBrokerTeamInviteIds] error:", error.message);
    return [];
  }
  return (data || []).map((r) => r.invited_broker_id);
}

/**
 * Creates a broker-team invite record (idempotent via upsert).
 * Does NOT modify the invited broker's company_id / user_companies rows.
 */
async function inviteBrokerToTeam(teamOwnerId, invitedBrokerId) {
  if (!teamOwnerId || !invitedBrokerId) throw new Error("teamOwnerId and invitedBrokerId required");
  if (String(teamOwnerId) === String(invitedBrokerId)) {
    throw Object.assign(new Error("Cannot invite yourself to your own team."), { status: 400 });
  }
  const { error } = await supabase
    .from("broker_team_invites")
    .upsert(
      { team_owner_id: teamOwnerId, invited_broker_id: invitedBrokerId },
      { onConflict: "team_owner_id,invited_broker_id" },
    );
  if (error) throw error;
}

/**
 * Removes a broker-team invite record.
 * Does NOT touch the invited broker's user_companies or account.
 */
async function removeBrokerFromTeam(teamOwnerId, invitedBrokerId) {
  if (!teamOwnerId || !invitedBrokerId) return;
  const { error } = await supabase
    .from("broker_team_invites")
    .delete()
    .eq("team_owner_id", teamOwnerId)
    .eq("invited_broker_id", invitedBrokerId);
  if (error) throw error;
}

// ── Company-assignment helpers (Features 2 & 3) ───────────────────────────────

/**
 * Adds companyIds to an existing user's company assignments (merges, does not replace).
 */
async function addUserToCompanies(userId, companyIdsToAdd) {
  if (!userId || !companyIdsToAdd?.length) return;
  const existing = await getUserById(userId);
  const merged = Array.from(new Set([
    ...(existing?.company_ids || []).map(String),
    ...companyIdsToAdd.map(String),
  ]));
  await syncUserCompanies(userId, merged);
}

/**
 * Removes specific companyIds from an existing user's company assignments.
 */
async function removeUserFromCompanies(userId, companyIdsToRemove) {
  if (!userId) return;
  const existing = await getUserById(userId);
  const removeSet = new Set((companyIdsToRemove || []).map(String));
  const remaining = (existing?.company_ids || []).filter((id) => !removeSet.has(String(id)));
  await syncUserCompanies(userId, remaining);
}

/**
 * Resolves a replacement user ID for records belonging to a user about to be deleted.
 * @param {string} preferredUserId - The user ID to prefer (usually the requester)
 * @param {Object} userToDelete - The user object being deleted
 * @returns {Promise<string|null>}
 */
async function resolveReplacementUserId(preferredUserId, userToDelete) {
  if (preferredUserId && String(preferredUserId) !== String(userToDelete?.id)) {
    return preferredUserId;
  }

  const companyIds = Array.from(new Set([
    userToDelete?.company_id,
    ...(userToDelete?.company_ids || []),
  ].filter(Boolean).map(String)));

  if (companyIds.length > 0) {
    const { data: candidates, error } = await supabase
      .from("users")
      .select("id, role")
      .neq("id", userToDelete.id)
      .in("role", ["broker", "admin"])
      .or(`company_id.in.(${companyIds.join(",")})`)
      .order("created_at", { ascending: true });

    if (!error && candidates && candidates.length > 0) {
      const sorted = candidates.sort((a, b) => (a.role === "admin" ? -1 : 1));
      return sorted[0].id;
    }
  }

  const { data: globalCandidates, error: globalError } = await supabase
    .from("users")
    .select("id, role")
    .neq("id", userToDelete.id)
    .in("role", ["broker", "admin"])
    .order("created_at", { ascending: true });

  if (!globalError && globalCandidates && globalCandidates.length > 0) {
    const sorted = globalCandidates.sort((a, b) => (a.role === "admin" ? -1 : 1));
    return sorted[0].id;
  }

  return null;
}

/**
 * Reassigns all restricted user references from one user to another.
 * @param {string} userId - Original user ID
 * @param {string} replacementUserId - New user ID
 */
async function reassignUserRecords(userId, replacementUserId) {
  const tables = [
    { name: "requests", column: "created_by" },
    { name: "folders", column: "created_by" },
    { name: "documents", column: "uploaded_by" },
    { name: "request_narratives", column: "updated_by" },
    { name: "request_reminders", column: "sent_by" },
    { name: "folder_access", column: "created_by" },
    { name: "reminders", column: "created_by" },
    { name: "activity_log", column: "created_by" },
  ];

  for (const { name, column } of tables) {
    await supabase.from(name).update({ [column]: replacementUserId }).eq(column, userId);
  }

  // Remove user_companies rows so the FK constraint doesn't block the user DELETE.
  await supabase.from("user_companies").delete().eq("user_id", userId);
}

/**
 * Lists all users with enriched company data
 * @returns {Promise<Array>}
 */
async function listAllUsers(viewer = null) {
  // Try fullest select first (includes sub_role, designation, buyer_company_name, parent_user_id),
  // fall back through progressively simpler selects on schema-cache misses.
  let result = await supabase.from("users").select(userSelectWithRoles).order("created_at", { ascending: false });
  if (result.error) result = await supabase.from("users").select(userSelectWithProfile).order("created_at", { ascending: false });
  if (result.error) result = await supabase.from("users").select(userSelect).order("created_at", { ascending: false });
  const { data, error } = result;
  if (error) throw error;
  const flattened = await Promise.all((data || []).map((user) => mergeSqlProfile(flattenUser(user))));
  const enriched = await attachAssignedCompanies(flattened);

  if (!viewer || isAdmin(viewer)) return enriched;

  const viewerCompanyIds = new Set(getUserCompanyIds(viewer).map(String));

  if (isBroker(viewer)) {
    // Fetch broker-team invite relationships so invited brokers appear in the list
    // even if they share no company_id with the viewer.
    const invitedIds = new Set((await getBrokerTeamInviteIds(viewer.id)).map(String));

    return enriched
      .filter((user) => {
        if (String(user.id) === String(viewer.id)) return true;
        if (isAdmin(user)) return false;
        if (invitedIds.has(String(user.id))) return true;
        return getUserCompanyIds(user).some((cid) => viewerCompanyIds.has(String(cid)));
      })
      .map((user) => ({
        ...user,
        // is_team_invite: true means this broker was added via explicit invite,
        // NOT via shared company — UI shows "Remove from Team" instead of "Delete".
        is_team_invite: invitedIds.has(String(user.id)),
      }));
  }

  return enriched.filter((user) => String(user.id) === String(viewer.id));
}

/**
 * Creates a new user with company assignments
 * @param {Object} userData - User data
 * @returns {Promise<Object>} Created user
 */
async function createUser(userData) {
  const {
    name, email, phone, password, role, company_id, company_ids, status, created_by,
    // multi-role fields (migration 041)
    sub_role, designation, buyer_company_name, parent_user_id,
  } = userData;
  const assignedCompanyIds = normalizeCompanyIds(company_id, company_ids);

  if (created_by && !isAdmin(created_by)) {
    const creatorCompanyIds = new Set(getUserCompanyIds(created_by).map(String));
    const invalidCompanyId = assignedCompanyIds.find((id) => !creatorCompanyIds.has(String(id)));
    if (invalidCompanyId) {
      const err = new Error("Cannot assign users to a company outside this broker account.");
      err.status = 403;
      throw err;
    }
  }

  const primaryCompanyId = company_id || assignedCompanyIds[0] || null;
  const passwordHash = await bcrypt.hash(String(password || ""), 10);
  const resolvedStatus = status || "active";

  const insertPayload = {
    name,
    email,
    phone: phone || null,
    password_hash: passwordHash,
    role,
    company_id: primaryCompanyId,
    status: resolvedStatus,
  };

  // Conditionally attach multi-role fields so existing DB rows without these
  // columns are not affected when migration 041 hasn't run yet.
  if (sub_role !== undefined && sub_role !== null) insertPayload.sub_role = sub_role;
  if (designation !== undefined && designation !== null) insertPayload.designation = designation;
  if (buyer_company_name !== undefined && buyer_company_name !== null) insertPayload.buyer_company_name = buyer_company_name;
  if (parent_user_id !== undefined && parent_user_id !== null) insertPayload.parent_user_id = parent_user_id;

  const { data: created, error } = await supabase
    .from("users")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error) throw error;

  await syncUserCompanies(created.id, assignedCompanyIds);
  return await getUserById(created.id);
}

/**
 * Updates an existing user
 * @param {string} id - User ID
 * @param {Object} userData - Update data
 * @returns {Promise<Object>} Updated user
 */
async function updateUser(id, userData) {
  const {
    name, email, phone,
    date_of_birth, occupation, address, broker_company,
    password, current_password,
    role, company_id, company_ids, status,
    // multi-role fields (migration 041)
    sub_role, designation, buyer_company_name, parent_user_id,
  } = userData;

  const hasCompanyAssignments = company_id !== undefined || company_ids !== undefined;
  const assignedCompanyIds = hasCompanyAssignments ? normalizeCompanyIds(company_id, company_ids) : null;
  const now = new Date().toISOString();
  const normalizedPhone = phone !== undefined ? normalizePhone(phone) : undefined;
  const normalizedDob = date_of_birth !== undefined ? normalizeDateOfBirth(date_of_birth) : undefined;
  const normalizedOccupation = occupation !== undefined ? normalizeOptionalText(occupation) : undefined;
  const normalizedAddress = address !== undefined ? normalizeOptionalText(address) : undefined;
  const normalizedBrokerCompany = broker_company !== undefined ? normalizeOptionalText(broker_company) : undefined;

  // ── Core updates (always-safe columns) ──────────────────────────────────
  const coreUpdates = {};
  if (name !== undefined) coreUpdates.name = name;
  if (email !== undefined) coreUpdates.email = email;
  if (phone !== undefined) coreUpdates.phone = normalizedPhone;
  if (role !== undefined) coreUpdates.role = role;
  if (status !== undefined) coreUpdates.status = status;
  if (hasCompanyAssignments) coreUpdates.company_id = company_id || assignedCompanyIds[0] || null;
  // multi-role fields
  if (sub_role !== undefined) coreUpdates.sub_role = sub_role || null;
  if (designation !== undefined) coreUpdates.designation = designation || null;
  if (buyer_company_name !== undefined) coreUpdates.buyer_company_name = buyer_company_name || null;
  if (parent_user_id !== undefined) coreUpdates.parent_user_id = parent_user_id || null;

  if (password !== undefined) {
    const nextPassword = String(password || "");
    if (!nextPassword) {
      const err = new Error("Please enter a new password.");
      err.status = 400;
      throw err;
    }
    if (nextPassword.length < 6) {
      const err = new Error("New password must be at least 6 characters.");
      err.status = 400;
      throw err;
    }
    if (current_password !== undefined) {
      const currentPassword = String(current_password || "");
      if (!currentPassword) {
        const err = new Error("Please enter your current password.");
        err.status = 400;
        throw err;
      }

      let storedHash = null;
      const { data: authData } = await supabase
        .from("users").select("email, password_hash").eq("id", id).single();
      storedHash = authData?.password_hash ?? null;

      // Supabase JS client may return null on network errors — fall back to pg
      if (storedHash === null) {
        storedHash = await getSqlUserField(id, "password_hash");
      }

      const matchesDb = await passwordMatches(currentPassword, storedHash ?? "");

      if (!matchesDb) {
        const err = new Error("Current password is incorrect.");
        err.status = 400;
        throw err;
      }
    }
    coreUpdates.password_hash = await bcrypt.hash(nextPassword, 10);
  }

  if (Object.keys(coreUpdates).length > 0) {
    coreUpdates.updated_at = now;
    const { error } = await supabase.from("users").update(coreUpdates).eq("id", id);
    if (error) {
      // Try direct pg before giving up
      const pgOk = await updateSqlById(id, coreUpdates);
      if (!pgOk) throw sanitizeDbError(error);
    }
  }

  // ── Profile updates (date_of_birth, occupation, address, broker_company) ───
  const profileUpdates = {};
  if (date_of_birth !== undefined) profileUpdates.date_of_birth = normalizedDob;
  if (occupation !== undefined) profileUpdates.occupation = normalizedOccupation;
  if (address !== undefined) profileUpdates.address = normalizedAddress;
  if (broker_company !== undefined) profileUpdates.broker_company = normalizedBrokerCompany;

  if (Object.keys(profileUpdates).length > 0) {
    const { error: profileErr } = await supabase
      .from("users").update({ ...profileUpdates, updated_at: now }).eq("id", id);
    if (profileErr) {
      // Try pg by ID first (fastest fallback, handles all error types)
      const pgOk = await updateSqlById(id, profileUpdates);
      if (!pgOk) {
        // Last resort: pg by email (handles column-missing on Supabase + no DATABASE_URL)
        const { data: userIdentity } = await supabase
          .from("users").select("email").eq("id", id).maybeSingle();
        if (userIdentity?.email) {
          const emailOk = await updateSqlProfileByEmail(userIdentity.email, profileUpdates);
          if (!emailOk) throw sanitizeDbError(profileErr);
        } else {
          throw sanitizeDbError(profileErr);
        }
      }
    }
  }

  if (hasCompanyAssignments) {
    await syncUserCompanies(id, assignedCompanyIds);
  }

  return await getUserById(id);
}

/**
 * Returns all client-side users (company_owner, client_team_member, client_accountant)
 * associated with the given company. Used for request-assignment email notifications.
 */
async function getClientTeamMembersForCompany(companyId) {
  const { data: links } = await supabase
    .from("user_companies")
    .select("user_id")
    .eq("company_id", companyId);

  if (!links?.length) return [];

  const userIds = links.map((l) => l.user_id).filter(Boolean);

  const { data: users } = await supabase
    .from("users")
    .select("id, name, email, sub_role")
    .in("id", userIds)
    .in("sub_role", CLIENT_SUB_ROLES);

  return (users || []).filter((u) => u.email);
}

module.exports = {
  supabase,
  userSelect,
  flattenUser,
  attachAssignedCompanies,
  normalizeCompanyIds,
  getUserCompanyIds,
  canAccessCompany,
  isAdmin,
  isBroker,
  syncUserCompanies,
  getUserById,
  getUserByEmail,
  addUserToCompanies,
  removeUserFromCompanies,
  getBrokerTeamInviteIds,
  inviteBrokerToTeam,
  removeBrokerFromTeam,
  listAllUsers,
  createUser,
  updateUser,
  resolveReplacementUserId,
  reassignUserRecords,
  getClientTeamMembersForCompany,
};
