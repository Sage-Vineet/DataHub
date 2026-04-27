const { supabase } = require("../db");
const asyncHandler = require("../utils");
const { getUserCompanyIds, canAccessCompany } = require("../services/userService");

function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
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
  return String(a?.id || "").localeCompare(String(a?.id || ""));
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
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, industry, logo, contact_name, contact_email, status, created_at")
    .eq("id", companyId)
    .maybeSingle();

  if (error) return null;
  return data;
}

async function getCompanyParticipants(company) {
  // Complex query: users active and (broker OR company_id OR user_companies)
  // We'll do it in stages or use a filter
  const { data: users, error } = await supabase
    .from("users")
    .select(`
      id, name, email, role, status,
      user_companies!left(company_id)
    `)
    .eq("status", "active")
    .order("name", { ascending: true });

  if (error) return [];

  const participants = users.filter(u => {
    if (["broker", "admin"].includes(u.role)) return true;
    if (u.company_id === company.id) return true;
    if (u.user_companies && u.user_companies.some(uc => uc.company_id === company.id)) return true;
    return false;
  });

  return participants.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: normalizeParticipantRole(row, company),
    status: row.status,
  }));
}

async function getCompanyMessageRows(companyId) {
  const { data, error } = await supabase
    .from("company_messages")
    .select(`
      id, company_id, sender_id, body, created_at,
      sender:users!company_messages_sender_id_fkey(name, email, role)
    `)
    .eq("company_id", companyId);

  if (error) return [];

  const rows = (data || []).map(m => ({
    ...m,
    sender_name: m.sender?.name,
    sender_email: m.sender?.email,
    sender_role: m.sender?.role
  }));

  return rows.sort(compareTimestampAsc);
}

async function getAccessibleCompanies(user) {
  if (isBroker(user)) {
    const { data } = await supabase
      .from("companies")
      .select("id, name, industry, logo, contact_name, contact_email, status, created_at")
      .order("name", { ascending: true });
    return data || [];
  }

  const companyIds = normalizeCompanyIds(user);
  if (!companyIds.length) return [];

  const { data } = await supabase
    .from("companies")
    .select("id, name, industry, logo, contact_name, contact_email, status, created_at")
    .in("id", companyIds)
    .order("name", { ascending: true });
  return data || [];
}

async function getLatestCompanyMessages(companyIds) {
  if (!companyIds.length) return {};

  const { data, error } = await supabase
    .from("company_messages")
    .select(`
      company_id, id, body, created_at, sender_id,
      sender:users!company_messages_sender_id_fkey(name)
    `)
    .in("company_id", companyIds);

  if (error) return {};

  const rows = (data || []).map(m => ({
    ...m,
    sender_name: m.sender?.name
  })).sort(compareTimestampDesc);

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
  const { data, error } = await supabase
    .from("direct_messages")
    .select(`
      id, company_id, sender_id, recipient_id, body, created_at,
      sender:users!direct_messages_sender_id_fkey(name, email, role)
    `)
    .eq("company_id", companyId)
    .or(`and(sender_id.eq.${currentUserId},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${currentUserId})`);

  if (error) return [];

  const rows = (data || []).map(m => ({
    ...m,
    sender_name: m.sender?.name,
    sender_email: m.sender?.email,
    sender_role: m.sender?.role
  }));

  return rows.sort(compareTimestampAsc);
}

async function getLatestDirectMessagesByContact(companyId, selfUserId, contactIds) {
  if (!contactIds.length) return {};

  const { data, error } = await supabase
    .from("direct_messages")
    .select("id, sender_id, recipient_id, body, created_at")
    .eq("company_id", companyId)
    .or(`and(sender_id.eq.${selfUserId},recipient_id.in.(${contactIds.join(',')})),and(recipient_id.eq.${selfUserId},sender_id.in.(${contactIds.join(',')}))`);

  if (error) return {};

  const rows = (data || []).sort(compareTimestampDesc);

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

  const { data, error } = await supabase
    .from("company_messages")
    .insert({
      company_id: companyId,
      sender_id: req.user.id,
      body
    })
    .select("id, company_id, sender_id, body, created_at")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json({
    ...data,
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

  const { data, error } = await supabase
    .from("direct_messages")
    .insert({
      company_id: companyId,
      sender_id: req.user.id,
      recipient_id: recipientId,
      body
    })
    .select("id, company_id, sender_id, recipient_id, body, created_at")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json({
    ...data,
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

