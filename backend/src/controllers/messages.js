const { supabase } = require("../db");
const asyncHandler = require("../utils");
const { getUserCompanyIds, canAccessCompany } = require("../services/userService");

function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
}

const COMPANY_BROKER_COLUMN_CANDIDATES = [
  "onboarded_by",
  "created_by",
  "added_by",
  "broker_id",
  "created_by_user_id",
];

const USER_COMPANY_BROKER_COLUMN_CANDIDATES = [
  "assigned_by",
  "created_by",
  "broker_id",
  "assigned_by_user_id",
];

function getMessagingRole(user, company) {
  if (isBroker(user)) return "broker";

  const explicitRole = String(user?.effective_role || "").toLowerCase();
  if (["client", "user"].includes(explicitRole)) return explicitRole;

  const normalizedRole = String(user?.role || "").toLowerCase();
  const normalizedEmail = String(user?.email || "").trim().toLowerCase();
  const contactEmail = String(company?.contact_email || "").trim().toLowerCase();

  if (normalizedRole === "buyer" && normalizedEmail && contactEmail && normalizedEmail === contactEmail) {
    return "client";
  }

  return "user";
}

function uniqueIds(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function buildParticipantFromUserRow(userRow, company) {
  return {
    id: userRow.id,
    name: userRow.name,
    email: userRow.email,
    role: normalizeParticipantRole(userRow, company),
    status: userRow.status,
  };
}

function dedupeParticipants(participants) {
  const map = new Map();
  for (const participant of participants || []) {
    if (!participant?.id) continue;
    map.set(String(participant.id), participant);
  }
  return Array.from(map.values()).sort((a, b) => compareNameAsc(a.name, b.name));
}

async function getBrokerParticipantsByIds(company, brokerIds) {
  const uniqueBrokerIds = uniqueIds(brokerIds);
  if (!uniqueBrokerIds.length) return [];

  const { data, error } = await supabase
    .from("users")
    .select("id, name, email, role, status")
    .in("id", uniqueBrokerIds)
    .eq("status", "active");

  if (error) return [];

  return (data || [])
    .filter((row) => ["broker", "admin"].includes(String(row.role || "").toLowerCase()))
    .map((row) => buildParticipantFromUserRow(row, company));
}

async function getCompanyBrokerIdsFromCompanyColumns(companyId) {
  const brokerIds = [];

  for (const columnName of COMPANY_BROKER_COLUMN_CANDIDATES) {
    const { data, error } = await supabase
      .from("companies")
      .select(columnName)
      .eq("id", companyId)
      .maybeSingle();

    if (error) continue;
    if (data?.[columnName]) brokerIds.push(data[columnName]);
  }

  return uniqueIds(brokerIds);
}

async function getCompanyBrokerIdsFromCompanyActivity(companyId) {
  const [requestRowsResult, folderRowsResult] = await Promise.all([
    supabase
      .from("requests")
      .select("created_by, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("folders")
      .select("created_by, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  const requestRows = requestRowsResult.error ? [] : (requestRowsResult.data || []);
  const folderRows = folderRowsResult.error ? [] : (folderRowsResult.data || []);

  const orderedEvents = [...requestRows, ...folderRows]
    .filter((row) => row?.created_by)
    .sort((a, b) => {
      const aTime = new Date(a?.created_at || 0).getTime();
      const bTime = new Date(b?.created_at || 0).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return String(a?.created_by || "").localeCompare(String(b?.created_by || ""));
    });

  const candidateIds = uniqueIds(orderedEvents.map((row) => row.created_by));

  if (!candidateIds.length) return [];

  const { data: users, error } = await supabase
    .from("users")
    .select("id, role, status")
    .in("id", candidateIds)
    .eq("status", "active");

  if (error) return [];

  const brokerIdSet = new Set(
    (users || [])
      .filter((row) => ["broker", "admin"].includes(String(row.role || "").toLowerCase()))
      .map((row) => String(row.id)),
  );

  return candidateIds.filter((id) => brokerIdSet.has(String(id)));
}

async function getOnboardingBrokerIdsForCompany(companyId) {
  const fromCompanyColumns = await getCompanyBrokerIdsFromCompanyColumns(companyId);
  if (fromCompanyColumns.length) return [fromCompanyColumns[0]];
  const fromActivity = await getCompanyBrokerIdsFromCompanyActivity(companyId);
  return fromActivity.length ? [fromActivity[0]] : [];
}

async function getAssignedBrokerIdsForUserCompany(companyId, userId) {
  const brokerIds = [];

  for (const columnName of USER_COMPANY_BROKER_COLUMN_CANDIDATES) {
    const { data, error } = await supabase
      .from("user_companies")
      .select(columnName)
      .eq("company_id", companyId)
      .eq("user_id", userId)
      .limit(100);

    if (error) continue;
    for (const row of data || []) {
      if (row?.[columnName]) brokerIds.push(row[columnName]);
    }
  }

  const uniqueBrokerIds = uniqueIds(brokerIds);
  return uniqueBrokerIds.length ? [uniqueBrokerIds[0]] : [];
}

async function getAssignedBrokerIdsForUser(userId) {
  const brokerIds = [];

  for (const columnName of USER_COMPANY_BROKER_COLUMN_CANDIDATES) {
    const { data, error } = await supabase
      .from("user_companies")
      .select(columnName)
      .eq("user_id", userId)
      .limit(1000);

    if (error) continue;
    for (const row of data || []) {
      if (row?.[columnName]) brokerIds.push(row[columnName]);
    }
  }

  return uniqueIds(brokerIds);
}

async function getHistoricalBrokerIdsForUserCompany(companyId, userId) {
  const { data, error } = await supabase
    .from("direct_messages")
    .select("sender_id, recipient_id, created_at")
    .eq("company_id", companyId)
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) return [];

  const counterpartyIds = uniqueIds(
    (data || []).map((row) => {
      const senderId = String(row.sender_id || "");
      const recipientId = String(row.recipient_id || "");
      return senderId === String(userId) ? recipientId : senderId;
    }),
  );

  if (!counterpartyIds.length) return [];

  const { data: users, error: usersError } = await supabase
    .from("users")
    .select("id, role, status")
    .in("id", counterpartyIds)
    .eq("status", "active");

  if (usersError) return [];

  const brokerIdSet = new Set(
    (users || [])
      .filter((row) => ["broker", "admin"].includes(String(row.role || "").toLowerCase()))
      .map((row) => String(row.id)),
  );

  return counterpartyIds.filter((id) => brokerIdSet.has(String(id)));
}

async function getCompanyAssignmentBrokerIds(companyId) {
  const brokerIds = [];

  for (const columnName of USER_COMPANY_BROKER_COLUMN_CANDIDATES) {
    const { data, error } = await supabase
      .from("user_companies")
      .select(columnName)
      .eq("company_id", companyId)
      .limit(500);

    if (error) continue;
    for (const row of data || []) {
      if (row?.[columnName]) brokerIds.push(row[columnName]);
    }
  }

  return uniqueIds(brokerIds);
}

async function getRelevantBrokerIdsForCompany(companyId) {
  const [onboardingIds, assignmentIds] = await Promise.all([
    getOnboardingBrokerIdsForCompany(companyId),
    getCompanyAssignmentBrokerIds(companyId),
  ]);

  return uniqueIds([...onboardingIds, ...assignmentIds]);
}

async function getRelevantBrokerIdsForUser(user) {
  const companyIds = getUserCompanyIds(user);
  if (!companyIds.length) return [];

  const brokerIdLists = await Promise.all(
    companyIds.map((companyId) => getRelevantBrokerIdsForCompany(companyId)),
  );

  return uniqueIds(brokerIdLists.flat());
}

async function getAnyActiveBrokerIds() {
  const { data, error } = await supabase
    .from("users")
    .select("id, role, status")
    .in("role", ["broker", "admin"])
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) return [];
  return uniqueIds((data || []).map((row) => row.id));
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
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, industry, logo, contact_name, contact_email, status, created_at")
    .eq("id", companyId)
    .maybeSingle();

  if (error) return null;
  return data;
}

async function getCompanyParticipants(company) {
  const [buyerRowsResult, relevantBrokerIds] = await Promise.all([
    supabase
      .from("users")
      .select(`
        id, name, email, role, status, company_id,
        user_companies!left(company_id)
      `)
      .eq("status", "active")
      .eq("role", "buyer")
      .order("name", { ascending: true }),
    getRelevantBrokerIdsForCompany(company.id),
  ]);

  const buyerRows = buyerRowsResult.error ? [] : (buyerRowsResult.data || []);

  const buyers = buyerRows.filter((row) => {
    if (String(row.company_id || "") === String(company.id)) return true;
    if (row.user_companies && row.user_companies.some((uc) => String(uc.company_id) === String(company.id))) return true;
    return false;
  }).map((row) => buildParticipantFromUserRow(row, company));

  const brokers = await getBrokerParticipantsByIds(company, relevantBrokerIds);
  return dedupeParticipants([...buyers, ...brokers]);
}

async function getCompanyBuyerParticipants(company) {
  const { data: users, error } = await supabase
    .from("users")
    .select(`
      id, name, email, role, status, company_id,
      user_companies!left(company_id)
    `)
    .eq("status", "active")
    .eq("role", "buyer")
    .order("name", { ascending: true });

  if (error) return [];

  const participants = (users || []).filter((u) => {
    if (String(u.company_id || "") === String(company.id)) return true;
    if (u.user_companies && u.user_companies.some((uc) => String(uc.company_id) === String(company.id))) return true;
    return false;
  });

  return participants.map((row) => buildParticipantFromUserRow(row, company));
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

  const messagingRole = getMessagingRole(user, company);
  const buyerParticipants = await getCompanyBuyerParticipants(company);
  const contactsForBroker = buyerParticipants.filter((participant) => String(participant.id) !== String(user.id));

  let brokerIds = [];
  if (messagingRole === "client") {
    brokerIds = await getOnboardingBrokerIdsForCompany(companyId);
  } else if (messagingRole === "user") {
    const [
      assignedBrokerIds,
      userLevelAssignedBrokerIds,
      onboardingBrokerIds,
      historicalBrokerIds,
      userRelevantBrokerIds,
    ] = await Promise.all([
      getAssignedBrokerIdsForUserCompany(companyId, user.id),
      getAssignedBrokerIdsForUser(user.id),
      getOnboardingBrokerIdsForCompany(companyId),
      getHistoricalBrokerIdsForUserCompany(companyId, user.id),
      getRelevantBrokerIdsForUser(user),
    ]);
    brokerIds = uniqueIds([
      ...assignedBrokerIds,
      ...userLevelAssignedBrokerIds,
      ...onboardingBrokerIds,
      ...historicalBrokerIds,
      ...userRelevantBrokerIds,
    ]);
  } else {
    brokerIds = await getRelevantBrokerIdsForCompany(companyId);
  }

  if (!brokerIds.length && messagingRole !== "broker") {
    brokerIds = await getRelevantBrokerIdsForCompany(companyId);
  }
  if (!brokerIds.length && messagingRole === "user") {
    brokerIds = await getAnyActiveBrokerIds();
  }

  const brokerParticipants = await getBrokerParticipantsByIds(company, brokerIds);

  let participants = dedupeParticipants([...buyerParticipants, ...brokerParticipants]);
  let selfParticipant = participants.find((participant) => String(participant.id) === String(user.id)) || null;

  if (!selfParticipant && messagingRole === "broker") {
    selfParticipant = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: "broker",
      status: user.status || "active",
    };
    participants = dedupeParticipants([...participants, selfParticipant]);
  }

  if (!selfParticipant) {
    return { error: { status: 403, body: { error: "Forbidden" } } };
  }

  const contacts = (messagingRole === "broker" ? contactsForBroker : brokerParticipants)
    .filter((participant) => String(participant.id) !== String(user.id))
    .sort((a, b) => compareNameAsc(a.name, b.name));

  const participantById = buildParticipantMap(participants);

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
    .or(`and(sender_id.eq.${currentUserId},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${currentUserId})`)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return [];

  const rows = (data || []).map(m => ({
    ...m,
    sender_name: m.sender?.name,
    sender_email: m.sender?.email,
    sender_role: m.sender?.role
  }));

  return rows.reverse(); // since we ordered desc, reverse to asc
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
  if (!participantById[String(req.user.id)] && !isBroker(req.user)) {
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

