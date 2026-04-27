const { supabase } = require("../db");
const asyncHandler = require("../utils");
const permissionService = require("../services/permissionService");

const ACTIVITY_LIMIT = 250;

function asIsoDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sortByCreatedAtDesc(items) {
  return [...items].sort((a, b) => {
    const left = new Date(a.created_at || 0).getTime();
    const right = new Date(b.created_at || 0).getTime();
    return right - left;
  });
}

function normalizeActivityLogRows(rows) {
  return (rows || []).map((row) => ({
    id: row.id || `activity-log-${row.created_at || Date.now()}`,
    type: row.type || row.event_type || "activity",
    title: row.title || null,
    message: row.message || row.title || row.detail || "Activity recorded",
    detail: row.detail || null,
    actor_name: row.actor_name || row.created_by_name || null,
    created_by: row.created_by || row.actor_id || null,
    created_at: asIsoDate(row.created_at || row.occurred_at) || new Date().toISOString(),
    source: "activity_log",
  }));
}

async function buildDerivedActivity(companyId) {
  const [
    requestsResult,
    documentsResult,
    groupsResult,
    usersResult,
  ] = await Promise.all([
    supabase
      .from("requests")
      .select(`
        id, title, description, created_at, created_by, approval_status, approved_at, approved_by,
        created_by_user:users!requests_created_by_fkey(name),
        approved_by_user:users!requests_approved_by_fkey(name)
      `)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    supabase
      .from("documents")
      .select(`
        id, name, status, uploaded_at, uploaded_by,
        uploaded_by_user:users!documents_uploaded_by_fkey(name)
      `)
      .eq("company_id", companyId)
      .order("uploaded_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    supabase
      .from("buyer_groups")
      .select("id, name, description, created_at, company_id")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    supabase
      .from("users")
      .select("id, name, company_id, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
  ]);

  if (requestsResult.error) throw requestsResult.error;
  if (documentsResult.error) throw documentsResult.error;
  if (groupsResult.error) throw groupsResult.error;
  if (usersResult.error) throw usersResult.error;

  const requests = requestsResult.data || [];
  const documents = documentsResult.data || [];
  const groups = groupsResult.data || [];
  const users = usersResult.data || [];

  const requestEvents = [];
  const requestIds = [];
  for (const request of requests) {
    requestIds.push(request.id);
    requestEvents.push({
      id: `request-created-${request.id}`,
      type: "request_created",
      message: `Request created: ${request.title || "Untitled request"}`,
      detail: request.description || null,
      actor_name: request.created_by_user?.name || null,
      created_by: request.created_by || null,
      created_at: asIsoDate(request.created_at) || new Date().toISOString(),
      source: "requests",
    });

    if (String(request.approval_status || "").toLowerCase() === "approved" && request.approved_at) {
      requestEvents.push({
        id: `request-approved-${request.id}`,
        type: "request_approved",
        message: `Request approved: ${request.title || "Untitled request"}`,
        detail: null,
        actor_name: request.approved_by_user?.name || null,
        created_by: request.approved_by || null,
        created_at: asIsoDate(request.approved_at) || asIsoDate(request.created_at) || new Date().toISOString(),
        source: "requests",
      });
    }
  }

  let reminderEvents = [];
  if (requestIds.length > 0) {
    const remindersResult = await supabase
      .from("request_reminders")
      .select(`
        id, request_id, sent_by, sent_at,
        sender:users!request_reminders_sent_by_fkey(name),
        request:requests!request_reminders_request_id_fkey(title)
      `)
      .in("request_id", requestIds)
      .order("sent_at", { ascending: false })
      .limit(ACTIVITY_LIMIT);

    if (remindersResult.error) throw remindersResult.error;

    reminderEvents = (remindersResult.data || []).map((reminder) => ({
      id: `reminder-${reminder.id}`,
      type: "reminder_created",
      message: `Reminder sent: ${reminder.request?.title || "Request reminder"}`,
      detail: null,
      actor_name: reminder.sender?.name || null,
      created_by: reminder.sent_by || null,
      created_at: asIsoDate(reminder.sent_at) || new Date().toISOString(),
      source: "request_reminders",
    }));
  }

  const documentEvents = documents.map((document) => ({
    id: `document-uploaded-${document.id}`,
    type: "document_uploaded",
    message: `Document uploaded: ${document.name || "Document"}`,
    detail: document.status ? `Status: ${document.status}` : null,
    actor_name: document.uploaded_by_user?.name || null,
    created_by: document.uploaded_by || null,
    created_at: asIsoDate(document.uploaded_at) || new Date().toISOString(),
    source: "documents",
  }));

  const groupEvents = groups.map((group) => ({
    id: `group-created-${group.id}`,
    type: "group_created",
    message: `Group created: ${group.name || "Untitled group"}`,
    detail: group.description || null,
    actor_name: null,
    created_by: null,
    created_at: asIsoDate(group.created_at) || new Date().toISOString(),
    source: "buyer_groups",
  }));

  const userEvents = users.map((user) => ({
    id: `user-added-${user.id}`,
    type: "user_added",
    message: `User added: ${user.name || "Unknown user"}`,
    detail: null,
    actor_name: null,
    created_by: null,
    created_at: asIsoDate(user.created_at) || new Date().toISOString(),
    source: "users",
  }));

  const groupIds = groups.map((group) => group.id);
  let groupMemberEvents = [];
  if (groupIds.length > 0) {
    const groupMembersResult = await supabase
      .from("buyer_group_members")
      .select(`
        group_id, user_id, created_at,
        user:users!buyer_group_members_user_id_fkey(name),
        group:buyer_groups!buyer_group_members_group_id_fkey(name)
      `)
      .in("group_id", groupIds)
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT);

    if (groupMembersResult.error) throw groupMembersResult.error;

    groupMemberEvents = (groupMembersResult.data || []).map((member, index) => ({
      id: `group-member-added-${member.group_id}-${member.user_id}-${index}`,
      type: "group_member_added",
      message: `Member added to group: ${member.group?.name || "Group"}`,
      detail: member.user?.name ? `User: ${member.user.name}` : null,
      actor_name: null,
      created_by: null,
      created_at: asIsoDate(member.created_at) || new Date().toISOString(),
      source: "buyer_group_members",
    }));
  }

  return sortByCreatedAtDesc([
    ...requestEvents,
    ...documentEvents,
    ...reminderEvents,
    ...groupEvents,
    ...groupMemberEvents,
    ...userEvents,
  ]).slice(0, ACTIVITY_LIMIT);
}

const listActivity = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) {
    const derived = await buildDerivedActivity(req.params.id);
    return res.json(derived);
  }

  const normalized = normalizeActivityLogRows(data || []);
  if (normalized.length > 0) {
    return res.json(normalized.slice(0, ACTIVITY_LIMIT));
  }

  const derived = await buildDerivedActivity(req.params.id);
  return res.json(derived);
});

module.exports = { listActivity };

