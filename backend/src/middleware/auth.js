const jwt = require("jsonwebtoken");
const { supabase } = require("../db");

function extractToken(req) {
  const authorization = req.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice(7);
  }

  const alternateHeaders = [
    req.headers["x-access-token"],
    req.headers["x-auth-token"],
    req.headers["x-token"],
  ];

  const headerToken = alternateHeaders.find((value) => typeof value === "string" && value.trim());
  if (headerToken) return headerToken.trim();

  const queryToken = req.query?.token || req.query?.access_token || req.query?.accessToken;
  if (typeof queryToken === "string" && queryToken.trim()) {
    return queryToken.trim();
  }

  return null;
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

async function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "change_me");
    
    const { data: user, error } = await supabase
      .from("users")
      .select(`
        id, name, email, role, company_id, status,
        companies:company_id ( name )
      `)
      .eq("id", payload.sub)
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Flatten company name
    const flattenedUser = {
      ...user,
      company_name: user.companies?.name
    };
    delete flattenedUser.companies;

    req.user = await attachAssignedCompanies(flattenedUser);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };

