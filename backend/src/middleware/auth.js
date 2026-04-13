const jwt = require("jsonwebtoken");
const db = require("../db");

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

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
  const companies = rowsOf(await db.query(
    `SELECT c.id, c.name, c.industry, c.status, c.contact_email
     FROM user_companies uc
     JOIN companies c ON c.id = uc.company_id
     WHERE uc.user_id = ?
     ORDER BY c.name ASC`,
    [user.id]
  ));

  const hasPrimary = user.company_id && companies.some((company) => String(company.id) === String(user.company_id));
  const assignedCompanies = hasPrimary || !user.company_id
    ? companies
    : [{ id: user.company_id, name: user.company_name }, ...companies];
  const normalizedEmail = String(user.email || "").trim().toLowerCase();
  const isSeller = assignedCompanies.some((company) => (
    String(company.contact_email || "").trim().toLowerCase() === normalizedEmail
  ));
  const effectiveRole = user.role === "buyer"
    ? (isSeller ? "client" : "user")
    : user.role;

  return {
    ...user,
    effective_role: effectiveRole,
    company_ids: assignedCompanies.map((company) => company.id).filter(Boolean),
    assigned_companies: assignedCompanies,
  };
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "change_me");
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.company_id, u.status, c.name AS company_name
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = ?`,
      [payload.sub]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.user = await attachAssignedCompanies(rows[0]);
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
