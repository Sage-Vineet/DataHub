const { supabase } = require("../db");
const asyncHandler = require("../utils");
const permissionService = require("../services/permissionService");

const DEFAULT_ACTIVITY_LIMIT = 120;
const MAX_ACTIVITY_LIMIT = 250;
const PER_SOURCE_LIMIT = 80;

const EVENT_ORDER = {
  activity: 10,
  user_added: 20,
  user_assigned: 21,
  group_created: 30,
  group_member_added: 31,
  folder_created: 40,
  folder_access_granted: 41,
  request_created: 50,
  request_updated: 51,
  request_approved: 52,
  request_document_linked: 53,
  request_narrative_updated: 54,
  reminder_created: 60,
  reminder_sent: 61,
  document_uploaded: 70,
  document_status_changed: 71,
  message_sent: 80,
  direct_message_sent: 81,
};

function asIsoDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

function sortActivities(items) {
  return [...items].sort((a, b) => {
    const leftTime = new Date(a.created_at || 0).getTime();
    const rightTime = new Date(b.created_at || 0).getTime();
    if (rightTime !== leftTime) return rightTime - leftTime;

    const leftOrder = EVENT_ORDER[a.type] ?? EVENT_ORDER.activity;
    const rightOrder = EVENT_ORDER[b.type] ?? EVENT_ORDER.activity;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;

    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

function withSequence(items, limit) {
  return sortActivities(items)
    .slice(0, limit)
    .map((item, index) => ({ ...item, sequence: index + 1 }));
}

async function safeQuery(builder, fallbackBuilder) {
  const result = await builder;
  if (!result.error) return result.data || [];
  if (!fallbackBuilder) return [];

  const fallbackResult = await fallbackBuilder;
  return fallbackResult.error ? [] : fallbackResult.data || [];
}

function normalizeActivityLogRows(rows, userNameById) {
  return (rows || []).map((row) => ({
    id: `activity-log-${row.id || row.created_at}`,
    type: row.type || row.event_type || "activity",
    title: row.title || null,
    message: row.message || row.title || row.detail || "Activity recorded",
    detail: row.detail || null,
    actor_name: row.actor_name || row.created_by_name || userNameById.get(row.created_by) || null,
    created_by: row.created_by || row.actor_id || null,
    created_at: asIsoDate(row.created_at || row.occurred_at) || new Date().toISOString(),
    source: "activity_log",
  }));
}

function addActor(actorIds, value) {
  if (value) actorIds.add(value);
}

function collectActorIds(collections) {
  const actorIds = new Set();
  for (const rows of collections) {
    for (const row of rows || []) {
      addActor(actorIds, row.created_by);
      addActor(actorIds, row.uploaded_by);
      addActor(actorIds, row.updated_by);
      addActor(actorIds, row.sent_by);
      addActor(actorIds, row.sender_id);
      addActor(actorIds, row.recipient_id);
      addActor(actorIds, row.approved_by);
      addActor(actorIds, row.assigned_to);
      addActor(actorIds, row.user_id);
    }
  }
  return actorIds;
}

async function buildUserNameMap(actorIds) {
  if (!actorIds.size) return new Map();
  const { data, error } = await supabase
    .from("users")
    .select("id, name, email")
    .in("id", Array.from(actorIds));

  if (error) return new Map();
  return new Map((data || []).map((user) => [user.id, user.name || user.email || "User"]));
}

function compactDetail(parts) {
  return parts.filter(Boolean).join(" · ") || null;
}

async function buildCompanyActivity(companyId, limit) {
  const [
    activityRows,
    requests,
    documents,
    folders,
    groups,
    directUsers,
    userCompanies,
    companyMessages,
    directMessages,
    reminders,
  ] = await Promise.all([
    safeQuery(
      supabase
        .from("activity_log")
        .select("id, type, message, created_by, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("requests")
        .select("id, title, sub_label, description, category, priority, status, due_date, assigned_to, visible, created_by, approval_status, approved_at, approved_by, created_at, updated_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      supabase
        .from("requests")
        .select("id, title, sub_label, description, category, priority, status, due_date, assigned_to, visible, created_by, created_at, updated_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("documents")
        .select("id, name, folder_id, size, ext, status, uploaded_by, uploaded_at")
        .eq("company_id", companyId)
        .order("uploaded_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("folders")
        .select("id, name, parent_id, created_by, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("buyer_groups")
        .select("id, name, description, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("users")
        .select("id, name, email, role, status, company_id, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("user_companies")
        .select("user_id, company_id, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("company_messages")
        .select("id, sender_id, body, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("direct_messages")
        .select("id, sender_id, recipient_id, body, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE_LIMIT)
    ),
    safeQuery(
      supabase
        .from("reminders")
        .select("id, request_id, title, message, due_date, priority, sent_count, last_sent_at, next_due_at, status, created_by")
        .eq("company_id", companyId)
        .limit(PER_SOURCE_LIMIT)
    ),
  ]);

  const requestIds = requests.map((request) => request.id).filter(Boolean);
  const folderIds = folders.map((folder) => folder.id).filter(Boolean);
  const groupIds = groups.map((group) => group.id).filter(Boolean);

  const [
    requestDocuments,
    requestNarratives,
    requestReminders,
    folderAccess,
    groupMembers,
  ] = await Promise.all([
    requestIds.length
      ? safeQuery(
          supabase
            .from("request_documents")
            .select("id, request_id, document_id, visible, created_at")
            .in("request_id", requestIds)
            .order("created_at", { ascending: false })
            .limit(PER_SOURCE_LIMIT)
        )
      : [],
    requestIds.length
      ? safeQuery(
          supabase
            .from("request_narratives")
            .select("id, request_id, content, updated_by, updated_at")
            .in("request_id", requestIds)
            .order("updated_at", { ascending: false })
            .limit(PER_SOURCE_LIMIT)
        )
      : [],
    requestIds.length
      ? safeQuery(
          supabase
            .from("request_reminders")
            .select("id, request_id, sent_by, sent_at")
            .in("request_id", requestIds)
            .order("sent_at", { ascending: false })
            .limit(PER_SOURCE_LIMIT)
        )
      : [],
    folderIds.length
      ? safeQuery(
          supabase
            .from("folder_access")
            .select("id, folder_id, user_id, group_id, can_read, can_write, can_download, created_by, created_at")
            .in("folder_id", folderIds)
            .order("created_at", { ascending: false })
            .limit(PER_SOURCE_LIMIT)
        )
      : [],
    groupIds.length
      ? safeQuery(
          supabase
            .from("buyer_group_members")
            .select("group_id, user_id, created_at")
            .in("group_id", groupIds)
            .order("created_at", { ascending: false })
            .limit(PER_SOURCE_LIMIT)
        )
      : [],
  ]);

  const userNameById = await buildUserNameMap(collectActorIds([
    activityRows,
    requests,
    documents,
    folders,
    directUsers,
    userCompanies,
    companyMessages,
    directMessages,
    reminders,
    requestNarratives,
    requestReminders,
    folderAccess,
    groupMembers,
  ]));

  const requestById = new Map(requests.map((request) => [request.id, request]));
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const groupById = new Map(groups.map((group) => [group.id, group]));

  const events = [
    ...normalizeActivityLogRows(activityRows, userNameById),
  ];

  for (const request of requests) {
    events.push({
      id: `request-created-${request.id}`,
      type: "request_created",
      message: `Request created: ${request.title || "Untitled request"}`,
      detail: compactDetail([request.category, request.priority, request.status, request.due_date ? `Due ${request.due_date}` : null]),
      actor_name: userNameById.get(request.created_by) || null,
      created_by: request.created_by || null,
      created_at: asIsoDate(request.created_at) || new Date().toISOString(),
      source: "requests",
    });

    const updatedAt = asIsoDate(request.updated_at);
    const createdAt = asIsoDate(request.created_at);
    if (updatedAt && updatedAt !== createdAt) {
      events.push({
        id: `request-updated-${request.id}`,
        type: "request_updated",
        message: `Request updated: ${request.title || "Untitled request"}`,
        detail: compactDetail([request.status, request.visible === false ? "Hidden" : "Visible"]),
        actor_name: userNameById.get(request.created_by) || null,
        created_by: request.created_by || null,
        created_at: updatedAt,
        source: "requests",
      });
    }

    if (String(request.approval_status || "").toLowerCase() === "approved" && request.approved_at) {
      events.push({
        id: `request-approved-${request.id}`,
        type: "request_approved",
        message: `Request approved: ${request.title || "Untitled request"}`,
        detail: null,
        actor_name: userNameById.get(request.approved_by) || null,
        created_by: request.approved_by || null,
        created_at: asIsoDate(request.approved_at) || createdAt || new Date().toISOString(),
        source: "requests",
      });
    }
  }

  for (const document of documents) {
    events.push({
      id: `document-uploaded-${document.id}`,
      type: "document_uploaded",
      message: `Document uploaded: ${document.name || "Document"}`,
      detail: compactDetail([document.ext ? document.ext.toUpperCase() : null, document.size, document.status]),
      actor_name: userNameById.get(document.uploaded_by) || null,
      created_by: document.uploaded_by || null,
      created_at: asIsoDate(document.uploaded_at) || new Date().toISOString(),
      source: "documents",
    });
  }

  for (const folder of folders) {
    events.push({
      id: `folder-created-${folder.id}`,
      type: "folder_created",
      message: `Folder created: ${folder.name || "Untitled folder"}`,
      detail: folder.parent_id ? "Nested folder" : "Root folder",
      actor_name: userNameById.get(folder.created_by) || null,
      created_by: folder.created_by || null,
      created_at: asIsoDate(folder.created_at) || new Date().toISOString(),
      source: "folders",
    });
  }

  for (const group of groups) {
    events.push({
      id: `group-created-${group.id}`,
      type: "group_created",
      message: `Group created: ${group.name || "Untitled group"}`,
      detail: group.description || null,
      actor_name: null,
      created_by: null,
      created_at: asIsoDate(group.created_at) || new Date().toISOString(),
      source: "buyer_groups",
    });
  }

  for (const user of directUsers) {
    events.push({
      id: `user-added-${user.id}`,
      type: "user_added",
      message: `User added: ${user.name || user.email || "Unknown user"}`,
      detail: compactDetail([user.role, user.status]),
      actor_name: null,
      created_by: null,
      created_at: asIsoDate(user.created_at) || new Date().toISOString(),
      source: "users",
    });
  }

  for (const assignment of userCompanies) {
    events.push({
      id: `user-assigned-${assignment.user_id}-${assignment.company_id}`,
      type: "user_assigned",
      message: `User assigned to company: ${userNameById.get(assignment.user_id) || "User"}`,
      detail: null,
      actor_name: null,
      created_by: null,
      created_at: asIsoDate(assignment.created_at) || new Date().toISOString(),
      source: "user_companies",
    });
  }

  for (const member of groupMembers) {
    events.push({
      id: `group-member-added-${member.group_id}-${member.user_id}`,
      type: "group_member_added",
      message: `Member added to group: ${groupById.get(member.group_id)?.name || "Group"}`,
      detail: userNameById.get(member.user_id) ? `User: ${userNameById.get(member.user_id)}` : null,
      actor_name: null,
      created_by: null,
      created_at: asIsoDate(member.created_at) || new Date().toISOString(),
      source: "buyer_group_members",
    });
  }

  for (const access of folderAccess) {
    const subject = access.user_id
      ? userNameById.get(access.user_id) || "User"
      : groupById.get(access.group_id)?.name || "Group";
    const permissions = compactDetail([
      access.can_read ? "read" : null,
      access.can_write ? "write" : null,
      access.can_download ? "download" : null,
    ]);
    events.push({
      id: `folder-access-${access.id}`,
      type: "folder_access_granted",
      message: `Folder access granted: ${folderById.get(access.folder_id)?.name || "Folder"}`,
      detail: compactDetail([subject, permissions]),
      actor_name: userNameById.get(access.created_by) || null,
      created_by: access.created_by || null,
      created_at: asIsoDate(access.created_at) || new Date().toISOString(),
      source: "folder_access",
    });
  }

  for (const link of requestDocuments) {
    events.push({
      id: `request-document-linked-${link.id}`,
      type: "request_document_linked",
      message: `Document linked to request: ${requestById.get(link.request_id)?.title || "Request"}`,
      detail: documentById.get(link.document_id)?.name || null,
      actor_name: null,
      created_by: null,
      created_at: asIsoDate(link.created_at) || new Date().toISOString(),
      source: "request_documents",
    });
  }

  for (const narrative of requestNarratives) {
    events.push({
      id: `request-narrative-updated-${narrative.id}`,
      type: "request_narrative_updated",
      message: `Narrative response updated: ${requestById.get(narrative.request_id)?.title || "Request"}`,
      detail: narrative.content ? narrative.content.slice(0, 140) : null,
      actor_name: userNameById.get(narrative.updated_by) || null,
      created_by: narrative.updated_by || null,
      created_at: asIsoDate(narrative.updated_at) || new Date().toISOString(),
      source: "request_narratives",
    });
  }

  for (const reminder of requestReminders) {
    events.push({
      id: `request-reminder-${reminder.id}`,
      type: "reminder_sent",
      message: `Reminder sent: ${requestById.get(reminder.request_id)?.title || "Request reminder"}`,
      detail: null,
      actor_name: userNameById.get(reminder.sent_by) || null,
      created_by: reminder.sent_by || null,
      created_at: asIsoDate(reminder.sent_at) || new Date().toISOString(),
      source: "request_reminders",
    });
  }

  for (const reminder of reminders) {
    if (reminder.last_sent_at) {
      events.push({
        id: `reminder-sent-${reminder.id}`,
        type: "reminder_sent",
        message: `Reminder sent: ${reminder.title || "Reminder"}`,
        detail: compactDetail([reminder.status, reminder.sent_count ? `${reminder.sent_count} sent` : null]),
        actor_name: userNameById.get(reminder.created_by) || null,
        created_by: reminder.created_by || null,
        created_at: asIsoDate(reminder.last_sent_at),
        source: "reminders",
      });
    }
    if (reminder.next_due_at) {
      events.push({
        id: `reminder-created-${reminder.id}`,
        type: "reminder_created",
        message: `Reminder scheduled: ${reminder.title || "Reminder"}`,
        detail: compactDetail([reminder.priority, reminder.due_date ? `Due ${reminder.due_date}` : null]),
        actor_name: userNameById.get(reminder.created_by) || null,
        created_by: reminder.created_by || null,
        created_at: asIsoDate(reminder.next_due_at),
        source: "reminders",
      });
    }
  }

  for (const message of companyMessages) {
    events.push({
      id: `company-message-${message.id}`,
      type: "message_sent",
      message: "Company message sent",
      detail: message.body ? message.body.slice(0, 140) : null,
      actor_name: userNameById.get(message.sender_id) || null,
      created_by: message.sender_id || null,
      created_at: asIsoDate(message.created_at) || new Date().toISOString(),
      source: "company_messages",
    });
  }

  for (const message of directMessages) {
    events.push({
      id: `direct-message-${message.id}`,
      type: "direct_message_sent",
      message: "Direct message sent",
      detail: compactDetail([
        message.body ? message.body.slice(0, 120) : null,
        message.recipient_id ? `To ${userNameById.get(message.recipient_id) || "user"}` : null,
      ]),
      actor_name: userNameById.get(message.sender_id) || null,
      created_by: message.sender_id || null,
      created_at: asIsoDate(message.created_at) || new Date().toISOString(),
      source: "direct_messages",
    });
  }

  const deduped = new Map();
  for (const event of events) {
    if (!event.created_at) continue;
    deduped.set(`${event.source}:${event.id}`, event);
  }

  return withSequence(Array.from(deduped.values()), limit);
}

const listActivity = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const activity = await buildCompanyActivity(req.params.id, clampLimit(req.query.limit));
  res.set("Cache-Control", "private, max-age=10");
  return res.json(activity);
});

module.exports = { listActivity };
