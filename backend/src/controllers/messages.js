const db = require("../db");
const asyncHandler = require("../utils");

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((value) => String(value))));
}

function normalizeCompanyIds(user) {
  return uniqueStrings([
    ...(user?.company_ids || []),
    ...((user?.assigned_companies || []).map((company) => company.id)),
    user?.company_id,
  ]);
}

function canAccessCompany(user, companyId) {
  if (isBroker(user)) return true;
  return normalizeCompanyIds(user).includes(String(companyId));
}

function normalizeParticipantRole(userRow, company) {
  const normalizedRole = String(userRow?.role || "").toLowerCase();
  if (["broker", "admin"].includes(normalizedRole)) return "broker";

  const normalizedEmail = String(userRow?.email || "").trim().toLowerCase();
  const contactEmail = String(company?.contact_email || "").trim().toLowerCase();

  if (normalizedRole === "buyer" && normalizedEmail && contactEmail && normalizedEmail === contactEmail) {
    return "client";
  }

  if (normalizedRole === "buyer") return "user";
  return normalizedRole || "user";
}

function compareIsoDesc(a, b) {
  return String(b || "").localeCompare(String(a || ""));
}

function compareTimestampAsc(a, b) {
  const aTime = new Date(a?.created_at || 0).getTime();
  const bTime = new Date(b?.created_at || 0).getTime();
  if (aTime !== bTime) return aTime - bTime;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function compareTimestampDesc(a, b) {
  const aTime = new Date(a?.created_at || 0).getTime();
  const bTime = new Date(b?.created_at || 0).getTime();
  if (aTime !== bTime) return bTime - aTime;
  return String(b?.id || "").localeCompare(String(a?.id || ""));
}

function compareNameAsc(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function buildParticipantMap(participants) {
  return participants.reduce((map, participant) => {
    map[String(participant.id)] = participant;
    return map;
  }, {});
}

function mapSender(message, participantById) {
  return participantById[String(message.sender_id)] || {
    id: message.sender_id,
    name: message.sender_name,
    email: message.sender_email,
    role: message.sender_role,
  };
}

function mapConversationMessage(message, participantById) {
  return {
    id: message.id,
    company_id: message.company_id,
    sender_id: message.sender_id,
    recipient_id: message.recipient_id,
    body: message.body,
    created_at: message.created_at,
    sender: mapSender(message, participantById),
  };
}

async function getCompany(companyId) {
  const rows = rowsOf(await db.query(
    `SELECT id, name, industry, logo, contact_name, contact_email, status, created_at
     FROM companies
     WHERE id = ?`,
    [companyId],
  ));
  return rows[0] || null;
}

async function getCompanyParticipants(company) {
  const rows = rowsOf(await db.query(
    `SELECT DISTINCT
       u.id,
       u.name,
       u.email,
       u.role,
       u.status
     FROM users u
     LEFT JOIN user_companies uc
       ON uc.user_id = u.id
      AND uc.company_id = ?
     WHERE u.status = 'active'
       AND (
         u.role IN ('broker', 'admin')
         OR u.company_id = ?
         OR uc.company_id IS NOT NULL
       )
     ORDER BY u.name ASC, u.id ASC`,
    [company.id, company.id],
  ));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: normalizeParticipantRole(row, company),
    status: row.status,
  }));
}

async function getCompanyMessageRows(companyId) {
  const rows = rowsOf(await db.query(
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
     WHERE cm.company_id = ?`,
    [companyId],
  ));

  return rows.sort(compareTimestampAsc);
}

async function getAccessibleCompanies(user) {
  if (isBroker(user)) {
    return rowsOf(await db.query(
      `SELECT id, name, industry, logo, contact_name, contact_email, status, created_at
       FROM companies
       ORDER BY name ASC, id ASC`,
    ));
  }

  const companyIds = normalizeCompanyIds(user);
  if (!companyIds.length) return [];

  const placeholders = companyIds.map(() => "?").join(",");
  return rowsOf(await db.query(
    `SELECT id, name, industry, logo, contact_name, contact_email, status, created_at
     FROM companies
     WHERE id IN (${placeholders})
     ORDER BY name ASC, id ASC`,
    companyIds,
  ));
}

async function getLatestCompanyMessages(companyIds) {
  if (!companyIds.length) return {};

  const placeholders = companyIds.map(() => "?").join(",");
  const rows = rowsOf(await db.query(
    `SELECT
       cm.company_id,
       cm.id,
       cm.body,
       cm.created_at,
       cm.sender_id,
       u.name AS sender_name
     FROM company_messages cm
     JOIN users u ON u.id = cm.sender_id
     WHERE cm.company_id IN (${placeholders})`,
    companyIds,
  )).sort(compareTimestampDesc);

  return rows.reduce((map, row) => {
    const key = String(row.company_id);
    if (!map[key]) {
      map[key] = {
        id: row.id,
        body: row.body,
        created_at: row.created_at,
        sender_id: row.sender_id,
        sender_name: row.sender_name,
      };
    }
    return map;
  }, {});
}

async function resolveDirectMessagingContext(user, companyId) {
  if (!canAccessCompany(user, companyId)) {
    return { error: { status: 403, body: { error: "Forbidden" } } };
  }

  const company = await getCompany(companyId);
  if (!company) {
    return { error: { status: 404, body: { error: "Company not found" } } };
  }

  const participants = await getCompanyParticipants(company);
  const participantById = buildParticipantMap(participants);
  const selfParticipant = participantById[String(user.id)] || null;

  if (!selfParticipant) {
    return { error: { status: 403, body: { error: "Forbidden" } } };
  }

  const contacts = participants
    .filter((participant) => {
      if (String(participant.id) === String(user.id)) return false;
      if (isBroker(user)) return ["user", "client"].includes(participant.role);
      return participant.role === "broker";
    })
    .sort((a, b) => compareNameAsc(a.name, b.name));

  return {
    company,
    contacts,
    participantById,
    selfParticipant,
  };
}

async function getDirectMessageRows(companyId, currentUserId, recipientId) {
  const rows = rowsOf(await db.query(
    `SELECT
       dm.id,
       dm.company_id,
       dm.sender_id,
       dm.recipient_id,
       dm.body,
       dm.created_at,
       u.name AS sender_name,
       u.email AS sender_email,
       u.role AS sender_role
     FROM direct_messages dm
     JOIN users u ON u.id = dm.sender_id
     WHERE dm.company_id = ?
       AND (
         (dm.sender_id = ? AND dm.recipient_id = ?)
         OR (dm.sender_id = ? AND dm.recipient_id = ?)
       )`,
    [companyId, currentUserId, recipientId, recipientId, currentUserId],
  ));

  return rows.sort(compareTimestampAsc);
}

async function getLatestDirectMessagesByContact(companyId, selfUserId, contactIds) {
  if (!contactIds.length) return {};

  const placeholders = contactIds.map(() => "?").join(",");
  const params = [companyId, selfUserId, ...contactIds, selfUserId, ...contactIds];
  const rows = rowsOf(await db.query(
    `SELECT
       dm.id,
       dm.sender_id,
       dm.recipient_id,
       dm.body,
       dm.created_at
     FROM direct_messages dm
     WHERE dm.company_id = ?
       AND (
         (dm.sender_id = ? AND dm.recipient_id IN (${placeholders}))
         OR (dm.recipient_id = ? AND dm.sender_id IN (${placeholders}))
       )`,
    params,
  )).sort(compareTimestampDesc);

  return rows.reduce((map, row) => {
    const contactId = String(row.sender_id) === String(selfUserId)
      ? String(row.recipient_id)
      : String(row.sender_id);

    if (!map[contactId]) {
      map[contactId] = {
        id: row.id,
        body: row.body,
        created_at: row.created_at,
        sender_id: row.sender_id,
      };
    }

    return map;
  }, {});
}

const listThreads = asyncHandler(async (req, res) => {
  const companies = await getAccessibleCompanies(req.user);
  if (!companies.length) return res.json([]);

  const latestByCompany = await getLatestCompanyMessages(companies.map((company) => company.id));

  const threads = companies
    .map((company) => ({
      company,
      last_message: latestByCompany[String(company.id)] || null,
    }))
    .sort((a, b) => {
      const aDate = a.last_message?.created_at || a.company.created_at || "";
      const bDate = b.last_message?.created_at || b.company.created_at || "";
      return compareIsoDesc(aDate, bDate) || compareNameAsc(a.company.name, b.company.name);
    });

  return res.json(threads);
});

const getConversation = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  if (!canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const company = await getCompany(companyId);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }

  const [participants, messages] = await Promise.all([
    getCompanyParticipants(company),
    getCompanyMessageRows(companyId),
  ]);

  const participantById = buildParticipantMap(participants);

  return res.json({
    company,
    participants,
    messages: messages.map((message) => mapConversationMessage(message, participantById)),
  });
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

  const participants = await getCompanyParticipants(company);
  const participantById = buildParticipantMap(participants);
  if (!participantById[String(req.user.id)]) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const insertedRows = rowsOf(await db.query(
    `INSERT INTO company_messages (company_id, sender_id, body)
     VALUES (?, ?, ?)
     RETURNING id, company_id, sender_id, body, created_at`,
    [companyId, req.user.id, body],
  ));

  const inserted = insertedRows[0];
  return res.status(201).json({
    ...inserted,
    sender: participantById[String(req.user.id)] || {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.effective_role || req.user.role,
    },
  });
});

const listDirectContacts = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const context = await resolveDirectMessagingContext(req.user, companyId);

  if (context.error) {
    return res.status(context.error.status).json(context.error.body);
  }

  const latestByContact = await getLatestDirectMessagesByContact(
    companyId,
    req.user.id,
    context.contacts.map((contact) => contact.id),
  );

  const contacts = context.contacts
    .map((contact) => ({
      ...contact,
      last_message: latestByContact[String(contact.id)] || null,
    }))
    .sort((a, b) => {
      const aDate = a.last_message?.created_at || "";
      const bDate = b.last_message?.created_at || "";
      return compareIsoDesc(aDate, bDate) || compareNameAsc(a.name, b.name);
    });

  return res.json({
    company: context.company,
    contacts,
  });
});

const getDirectConversation = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const recipientId = req.params.recipientId;
  const context = await resolveDirectMessagingContext(req.user, companyId);

  if (context.error) {
    return res.status(context.error.status).json(context.error.body);
  }

  const participant = context.contacts.find((contact) => String(contact.id) === String(recipientId));
  if (!participant) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const messages = await getDirectMessageRows(companyId, req.user.id, recipientId);

  return res.json({
    company: context.company,
    participant,
    messages: messages.map((message) => mapConversationMessage(message, context.participantById)),
  });
});

const createDirectMessage = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const recipientId = req.params.recipientId;
  const body = String(req.body?.body || "").trim();
  const context = await resolveDirectMessagingContext(req.user, companyId);

  if (context.error) {
    return res.status(context.error.status).json(context.error.body);
  }
  if (!body) {
    return res.status(400).json({ error: "Message body is required" });
  }

  const participant = context.contacts.find((contact) => String(contact.id) === String(recipientId));
  if (!participant) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const insertedRows = rowsOf(await db.query(
    `INSERT INTO direct_messages (company_id, sender_id, recipient_id, body)
     VALUES (?, ?, ?, ?)
     RETURNING id, company_id, sender_id, recipient_id, body, created_at`,
    [companyId, req.user.id, recipientId, body],
  ));

  const inserted = insertedRows[0];
  return res.status(201).json({
    ...inserted,
    sender: context.participantById[String(req.user.id)] || context.selfParticipant,
    participant,
  });
});

module.exports = {
  listThreads,
  getConversation,
  createMessage,
  listDirectContacts,
  getDirectConversation,
  createDirectMessage,
};
