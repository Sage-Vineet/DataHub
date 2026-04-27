const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const asyncHandler = require("../utils");

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET || "change_me", {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

async function syncUserCompanyAssignment(userId, companyId) {
  if (!userId || !companyId) return;
  const { error } = await supabase
    .from("user_companies")
    .upsert({ user_id: userId, company_id: companyId }, { onConflict: "user_id,company_id" });
  
  if (error) console.error("❌ Error syncing user company assignment:", error.message);
}

async function attachAssignedCompanies(user) {
  if (!user?.id) return user;

  const { data: companies, error } = await supabase
    .from("user_companies")
    .select(`
      company_id,
      companies:company_id (
        id, name, industry, status, contact_email
      )
    `)
    .eq("user_id", user.id)
    .order("company_id", { ascending: true });

  if (error) {
    console.error("❌ Error fetching assigned companies:", error.message);
    return user;
  }

  // Flatten the result to match existing structure
  const assignedCompanies = (companies || []).map(uc => uc.companies).filter(Boolean);

  const hasPrimary = user.company_id && assignedCompanies.some((company) => String(company.id) === String(user.company_id));
  const finalCompanies = hasPrimary || !user.company_id
    ? assignedCompanies
    : [{ id: user.company_id, name: user.company_name }, ...assignedCompanies];

  const normalizedEmail = String(user.email || "").trim().toLowerCase();
  const isSeller = finalCompanies.some((company) => (
    String(company.contact_email || "").trim().toLowerCase() === normalizedEmail
  ));
  const effectiveRole = user.role === "buyer"
    ? (isSeller ? "client" : "user")
    : user.role;

  return {
    ...user,
    effective_role: effectiveRole,
    company_ids: finalCompanies.map((company) => company.id).filter(Boolean),
    assigned_companies: finalCompanies,
  };
}

const DEMO_USERS = [
  {
    email: "broker@leo.com",
    password: "broker123",
    name: "Rajesh Sharma",
    role: "broker",
    companyName: "Dataroom",
  },
  {
    email: "client@infosys.com",
    password: CLIENT_STATIC_PASSWORD,
    name: "Ananya Mehta",
    role: "buyer",
    companyName: "Infosys Ltd.",
  },
];

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

async function ensureDemoUser(demo) {
  const { data: existing, error: findError } = await supabase
    .from("users")
    .select(`
      id, name, email, password_hash, role, company_id, status,
      companies:company_id ( name )
    `)
    .eq("email", demo.email)
    .maybeSingle();

  if (findError) console.error("❌ Error finding demo user:", findError.message);
  if (existing) {
    // Flatten company name
    return { ...existing, company_name: existing.companies?.name };
  }

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

  return { ...created, company_name: created.companies?.name };
}

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

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const demo = DEMO_USERS.find((candidate) => candidate.email === normalizedEmail);

  let user = null;

  if (demo && password === demo.password) {
    user = await ensureDemoUser(demo);
    if (user) {
      await syncUserCompanyAssignment(user.id, user.company_id);
    }
  }

  if (!user) {
    const { data: users, error: findError } = await supabase
      .from("users")
      .select(`
        id, name, email, password_hash, role, company_id, status,
        companies:company_id ( name )
      `)
      .eq("email", normalizedEmail);

    if (findError) console.error("❌ Error finding user:", findError.message);
    
    user = (users || [])[0];
    if (user) {
      user.company_name = user.companies?.name;
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.role === "buyer" && password === CLIENT_STATIC_PASSWORD) {
      await syncUserCompanyAssignment(user.id, user.company_id);
      await ensureDefaultFolders(user.company_id, user.id);
    } else {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
    }
  }

  const token = signToken(user.id);
  const safeUser = { ...(await attachAssignedCompanies(user)) };
  delete safeUser.password_hash;
  delete safeUser.companies; // Cleanup flattened field

  return res.json({ token, user: safeUser });
});

const logout = asyncHandler(async (req, res) => {
  return res.status(204).send();
});

const me = asyncHandler(async (req, res) => {
  return res.json({ user: req.user });
});

module.exports = { login, logout, me };