const db = require("../db");
const asyncHandler = require("../utils");

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

function isBroker(user) {
  return ["broker", "admin"].includes(user?.role);
}

function normalizeCompanyIds(user) {
  return Array.from(
    new Set(
      [
        ...(user?.company_ids || []),
        ...((user?.assigned_companies || []).map((company) => company.id)),
        user?.company_id,
      ].filter(Boolean).map(String),
    ),
  );
}

function canAccessCompany(user, companyId) {
  if (isBroker(user)) return true;
  return normalizeCompanyIds(user).includes(String(companyId));
}

function normalizeParticipantRole(user, company) {
  if (["broker", "admin"].includes(user.role)) return "broker";
  const normalizedEmail = String(user.email || "").trim().toLowerCase();
  const contactEmail = String(company?.contact_email || "").trim().toLowerCase();
  if (user.role === "buyer" && normalizedEmail && contactEmail && normalizedEmail === contactEmail) {
    return "client";
  }
  if (user.role === "buyer") return "user";
  return user.role || "user";
}

async function getCompany(companyId) {
  const companies = rowsOf(await db.query(
    `SELECT id, name, industry, logo, contact_name, contact_email, status, created_at
     FROM companies
     WHERE id = ?`,
    [companyId],
  ));
  return companies[0] || null;
}

async function getConversationParticipants(company) {
  const users = rowsOf(await db.query(
    `SELECT DISTINCT u.id, u.name, u.email, u.role, u.status
     FROM users u
     LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = ?
     WHERE u.status = 'active'
       AND (
         u.role IN ('broker', 'admin')
         OR uc.company_id IS NOT NULL
         OR u.company_id = ?
       )
     ORDER BY u.name ASC`,
    [company.id, company.id],
  ));

  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: normalizeParticipantRole(user, company),
    status: user.status,
  }));
}

async function getMessageRows(companyId) {
  return rowsOf(await db.query(
    `SELECT
       cm.id,
       cm.company_id,
       cm.sender_id,
       cm.body,
       cm.created_at,
       u.name AS sender_name,
       u.email AS sender_email,
       u.role AS sender_role
     FROM company_messages cm
     JOIN users u ON u.id = cm.sender_id
     WHERE cm.company_id = ?
     ORDER BY datetime(cm.created_at) ASC, cm.rowid ASC`,
    [companyId],
  ));
}

async function serializeConversation(companyId) {
  const company = await getCompany(companyId);
  if (!company) return null;

  const [participants, messages] = await Promise.all([
    getConversationParticipants(company),
    getMessageRows(companyId),
  ]);

  const participantById = participants.reduce((map, participant) => {
    map[participant.id] = participant;
    return map;
  }, {});

  return {
    company,
    participants,
    messages: messages.map((message) => ({
      id: message.id,
      company_id: message.company_id,
      sender_id: message.sender_id,
      body: message.body,
      created_at: message.created_at,
      sender: participantById[message.sender_id] || {
        id: message.sender_id,
        name: message.sender_name,
        email: message.sender_email,
        role: message.sender_role,
      },
    })),
  };
}

const listThreads = asyncHandler(async (req, res) => {
  let companies = [];

  if (isBroker(req.user)) {
    companies = rowsOf(await db.query(
      `SELECT id, name, industry, logo, contact_name, contact_email, status, created_at
       FROM companies
       ORDER BY name ASC`,
    ));
  } else {
    const companyIds = normalizeCompanyIds(req.user);
    if (!companyIds.length) {
      return res.json([]);
    }
    const placeholders = companyIds.map(() => "?").join(",");
    companies = rowsOf(await db.query(
      `SELECT id, name, industry, logo, contact_name, contact_email, status, created_at
       FROM companies
       WHERE id IN (${placeholders})
       ORDER BY name ASC`,
      companyIds,
    ));
  }

  if (!companies.length) {
    return res.json([]);
  }

  const placeholders = companies.map(() => "?").join(",");
  const allMessages = rowsOf(await db.query(
    `SELECT
       cm.company_id,
       cm.id,
       cm.body,
       cm.created_at,
       cm.sender_id,
       u.name AS sender_name
     FROM company_messages cm
     JOIN users u ON u.id = cm.sender_id
     WHERE cm.company_id IN (${placeholders})
     ORDER BY datetime(cm.created_at) DESC, cm.rowid DESC`,
    companies.map((company) => company.id),
  ));

  const latestByCompany = {};
  allMessages.forEach((message) => {
    if (!latestByCompany[message.company_id]) {
      latestByCompany[message.company_id] = message;
    }
  });

  const threads = companies.map((company) => {
    const latest = latestByCompany[company.id];
    return {
      company,
      last_message: latest ? {
        id: latest.id,
        body: latest.body,
        created_at: latest.created_at,
        sender_id: latest.sender_id,
        sender_name: latest.sender_name,
      } : null,
    };
  });

  threads.sort((a, b) => {
    const aDate = a.last_message?.created_at || a.company.created_at || "";
    const bDate = b.last_message?.created_at || b.company.created_at || "";
    return String(bDate).localeCompare(String(aDate));
  });

  return res.json(threads);
});

const getConversation = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  if (!canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const conversation = await serializeConversation(companyId);
  if (!conversation) {
    return res.status(404).json({ error: "Company not found" });
  }

  return res.json(conversation);
});

const createMessage = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const body = String(req.body?.body || "").trim();

  if (!canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!body) {
    return res.status(400).json({ error: "Message body is required" });
  }

  const company = await getCompany(companyId);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }

  const participants = await getConversationParticipants(company);
  const allowedParticipant = participants.some((participant) => String(participant.id) === String(req.user.id));
  if (!allowedParticipant) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const inserted = rowsOf(await db.query(
    `INSERT INTO company_messages (company_id, sender_id, body)
     VALUES (?, ?, ?)
     RETURNING id, company_id, sender_id, body, created_at`,
    [companyId, req.user.id, body],
  ));

  const participantById = participants.reduce((map, participant) => {
    map[participant.id] = participant;
    return map;
  }, {});

  return res.status(201).json({
    ...inserted[0],
    sender: participantById[req.user.id] || {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.effective_role || req.user.role,
    },
  });
});

module.exports = {
  listThreads,
  getConversation,
  createMessage,
};
