const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db");
const asyncHandler = require("../utils");

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET || "change_me", {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function ensureRows(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "Password@123";

async function syncUserCompanyAssignment(userId, companyId) {
  if (!userId || !companyId) return;
  await db.query(
    "INSERT INTO user_companies (user_id, company_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [userId, companyId]
  );
}

async function attachAssignedCompanies(user) {
  if (!user?.id) return user;
  const companies = ensureRows(await db.query(
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

const DEMO_USERS = [
  {
    email: "broker@datahub.com",
    password: "Password@123",
    name: "Rajesh Sharma",
    role: "broker",
    companyName: "Dataroom",
  },
  {
    email: "buyer2@datahub.com",
    password: CLIENT_STATIC_PASSWORD,
    name: "Ananya Mehta",
    role: "buyer",
    companyName: "Infosys Ltd.",
  },
];

async function ensureCompany(companyName) {
  if (!companyName) return null;
  const existing = ensureRows(
    await db.query("SELECT id, name FROM companies WHERE name = ?", [companyName])
  );
  if (existing[0]) return existing[0];

  await db.query(
    `INSERT INTO companies (name, industry, contact_name, contact_email, contact_phone)
     VALUES (?, ?, ?, ?, ?)`,
    [companyName, "Technology", "Demo Contact", "demo@leo.com", "+91-9000000000"]
  );
  const created = ensureRows(
    await db.query("SELECT id, name FROM companies WHERE name = ?", [companyName])
  );
  return created[0] || null;
}

async function ensureDemoUser(demo) {
  const existing = ensureRows(
    await db.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id, u.status, c.name AS company_name
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.email = ?`,
      [demo.email]
    )
  );

  if (existing[0]) return existing[0];

  const company = await ensureCompany(demo.companyName);
  const passwordHash = await bcrypt.hash(demo.password, 10);

  await db.query(
    `INSERT INTO users (name, email, password_hash, role, company_id, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [demo.name, demo.email, passwordHash, demo.role, company?.id || null]
  );

  const created = ensureRows(
    await db.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id, u.status, c.name AS company_name
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.email = ?`,
      [demo.email]
    )
  );

  return created[0] || null;
}

async function ensureCompanyForEmail(email) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = ensureRows(
    await db.query("SELECT id, name FROM companies WHERE contact_email = ?", [normalizedEmail])
  );
  if (existing[0]) return existing[0];

  const domain = normalizedEmail.split("@")[1] || "Client Company";
  const companyName = domain.split(".")[0]
    ? domain.split(".")[0].replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    : "Client Company";

  await db.query(
    `INSERT INTO companies (name, industry, contact_name, contact_email, contact_phone)
     VALUES (?, ?, ?, ?, ?)`,
    [companyName, "Technology", "Client Admin", normalizedEmail, "+91-9000000000"]
  );
  const created = ensureRows(
    await db.query("SELECT id, name FROM companies WHERE contact_email = ?", [normalizedEmail])
  );
  return created[0] || null;
}

async function ensureBuyerForEmail(email) {
  const company = await ensureCompanyForEmail(email);
  const passwordHash = await bcrypt.hash(CLIENT_STATIC_PASSWORD, 10);
  const name = email.split("@")[0] || "Client User";
  await db.query(
    `INSERT INTO users (name, email, password_hash, role, company_id, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [name, email, passwordHash, "buyer", company?.id || null]
  );
  const created = ensureRows(
    await db.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id, u.status, c.name AS company_name
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.email = ?`,
      [email]
    )
  );
  return created[0] || null;
}

async function ensureDefaultFolders(companyId, createdBy) {
  if (!companyId || !createdBy) return;
  const existing = ensureRows(
    await db.query("SELECT id FROM folders WHERE company_id = $1 LIMIT 1", [companyId])
  );
  if (existing[0]) return;

  const defaults = ["Finance", "Legal", "Compliance", "HR", "Tax", "M&A", "Other"];
  for (const name of defaults) {
    await db.query(
      "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1, $2, $3, $4, $5)",
      [companyId, null, name, null, createdBy]
    );
  }
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
    await syncUserCompanyAssignment(user?.id, user?.company_id);
  }

  if (!user) {
    const users = ensureRows(
      await db.query(
        `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id, u.status, c.name AS company_name
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
         WHERE u.email = ?`,
        [normalizedEmail]
      )
    );

    user = users[0];
    if (!user) {
      if (password === CLIENT_STATIC_PASSWORD) {
        user = await ensureBuyerForEmail(normalizedEmail);
        if (user) {
          await syncUserCompanyAssignment(user.id, user.company_id);
          await ensureDefaultFolders(user.company_id, user.id);
        }
      } else {
        return res.status(401).json({ error: "Invalid credentials" });
      }
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

  return res.json({ token, user: safeUser });
});

const logout = asyncHandler(async (req, res) => {
  // Stateless JWT: client deletes token.
  return res.status(204).send();
});

const me = asyncHandler(async (req, res) => {
  return res.json({ user: req.user });
});

module.exports = { login, logout, me };
