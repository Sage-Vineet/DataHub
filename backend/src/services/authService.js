const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { attachAssignedCompanies, flattenUser, getUserByEmail } = require("./userService");

const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

const DEMO_USERS = [
  {
    email: "broker@leo.com",
    password: "broker123",
    name: "Rajesh Sharma",
    role: "broker",
    companyName: "Dataroom",
  },
  {
    email: "admin@datahub.com",
    password: "admin123",
    name: "System Admin",
    role: "admin",
    companyName: "DataHub",
  },
  {
    email: "admin@leo.com",
    password: "admin123",
    name: "System Admin",
    role: "admin",
    companyName: "DataHub",
  },
  {
    email: "demo@leo.com",
    password: "123456",
    name: "Demo User",
    role: "buyer",
    companyName: "Demo Company",
  },
  {
    email: "client@infosys.com",
    password: CLIENT_STATIC_PASSWORD,
    name: "Ananya Mehta",
    role: "buyer",
    companyName: "Infosys Ltd.",
  },
];

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

/**
 * Ensures a company exists by name
 * @param {string} companyName - Name of the company
 * @returns {Promise<Object>} Company object
 */
async function ensureCompany(companyName) {
  if (!companyName) return null;

  const { data: existing, error: findError } = await supabase
    .from("companies")
    .select("id, name")
    .eq("name", companyName)
    .maybeSingle();

  if (findError) console.error("❌ Error finding company:", findError.message);
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from("companies")
    .insert({
      name: companyName,
      industry: "Technology",
      contact_name: "Demo Contact",
      contact_email: "demo@leo.com",
      contact_phone: "+91-9000000000"
    })
    .select("id, name")
    .single();

  if (insertError) {
    console.error("❌ Error creating company:", insertError.message);
    return null;
  }
  return created;
}

/**
 * Ensures a demo user exists in the database
 * @param {Object} demo - Demo user definition
 * @returns {Promise<Object>} Enriched user object
 */
async function ensureDemoUser(demo) {
  const existing = await getUserByEmail(demo.email);
  if (existing) return existing;

  const company = await ensureCompany(demo.companyName);
  const passwordHash = await bcrypt.hash(demo.password, 10);

  const { data: created, error: insertError } = await supabase
    .from("users")
    .insert({
      name: demo.name,
      email: demo.email,
      password_hash: passwordHash,
      role: demo.role,
      company_id: company?.id || null,
      status: "active"
    })
    .select(`
      id, name, email, password_hash, role, company_id, status,
      companies:company_id ( name )
    `)
    .single();

  if (insertError) {
    console.error("❌ Error creating demo user:", insertError.message);
    return null;
  }

  return await attachAssignedCompanies(flattenUser(created));
}

/**
 * Syncs user company assignment in the join table
 */
async function syncUserCompanyAssignment(userId, companyId) {
  if (!userId || !companyId) return;
  const { error } = await supabase
    .from("user_companies")
    .upsert({ user_id: userId, company_id: companyId }, { onConflict: "user_id,company_id" });
  
  if (error) console.error("❌ Error syncing user company assignment:", error.message);
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
 * Validates user credentials and handles demo logic
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} { user, token }
 */
async function authenticate(email, password) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const demo = DEMO_USERS.find((candidate) => candidate.email === normalizedEmail);

  let user = null;

  // 1. Check Demo Logic
  if (demo && password === demo.password) {
    user = await ensureDemoUser(demo);
    if (user) {
      await syncUserCompanyAssignment(user.id, user.company_id);
    }
  }

  // 2. Check Database Logic
  if (!user) {
    console.log(`[Auth] Checking database for: ${normalizedEmail}`);
    user = await getUserByEmail(normalizedEmail);
    
    if (!user) {
      console.log(`[Auth] User not found: ${normalizedEmail}`);
      throw new Error("Invalid credentials");
    }

    console.log(`[Auth] User found in DB: ${user.id} (${user.role})`);

    // 3. Password Validation
    if (user.role === "buyer" && password === CLIENT_STATIC_PASSWORD) {
      console.log(`[Auth] Buyer logged in with static password: ${user.id}`);
      await syncUserCompanyAssignment(user.id, user.company_id);
      await ensureDefaultFolders(user.company_id, user.id);
    } else {
      console.log(`[Auth] Performing standard password check for: ${user.id}`);
      const { data: authData } = await supabase
        .from("users")
        .select("password_hash")
        .eq("id", user.id)
        .single();

      if (!authData?.password_hash) {
        console.log(`[Auth] No password hash for user: ${user.id}`);
        throw new Error("Invalid credentials");
      }

      const ok = await bcrypt.compare(password, authData.password_hash);
      if (!ok) {
        console.log(`[Auth] Password mismatch for user: ${user.id}`);
        throw new Error("Invalid credentials");
      }
      console.log(`[Auth] Password match for user: ${user.id}`);
    }
  }

  const token = signToken(user.id);
  
  // Final cleanup of user object for response
  const safeUser = { ...user };
  delete safeUser.password_hash;
  
  return { user: safeUser, token };
}

module.exports = {
  authenticate,
  signToken,
  ensureDefaultFolders
};
