const { supabase } = require("../db");
const { Pool } = require("pg");
const userService = require("./userService");
const { resolveReminderFrequencyDays } = require("../utils/requestReminders");
const { buildSslOptions } = require("../db/pgPool");

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: buildSslOptions(process.env.DATABASE_URL), max: 5, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000 });
    _pool.on("error", (err) => console.error("[requestService] pg pool error:", err.message));
  }
  return _pool;
}
async function pgQuery(sql, params = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const { rows } = await pool.query(sql, params);
  return rows;
}

function roleLabel(role) {
  if (!role) return null;
  if (role === "broker" || role === "admin") return "Broker";
  if (role === "client") return "Client";
  if (role === "user") return "Buyer";
  if (role === "provider") return "Provider";
  return null;
}

function formatUploaderDisplay(user) {
  if (!user) return null;
  const name = user.name || user.email || "User";
  const label = roleLabel(user.role);
  return label ? `${name} (${label})` : name;
}

const REQUEST_CATEGORIES = ["Finance", "Legal", "Compliance", "HR", "Tax", "M&A", "Other"];
const RESPONSE_TYPES = ["Upload", "Narrative", "Both"];
const REQUEST_STATUSES = ["pending", "in-review", "completed", "blocked"];
const APPROVAL_STATUSES = ["pending", "approved"];
const PRIORITY_VALUES = ["critical", "high", "medium", "low"];
const ALL_ASSIGNEE_TOKENS = new Set(["all", "everyone", "*"]);
const ASSIGNEE_INPUT_KEYS = [
  "assigned_to",
  "assigned_to_email",
  "assigned_to_emails",
  "assigned_to_user_ids",
  "assignee_email",
  "assignee_emails",
  "assignee_ids",
  "assignedTo",
  "assignedToEmails",
];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function tokenizeAssigneeInput(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => tokenizeAssigneeInput(item));
  }
  return String(value)
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasAssigneeInput(input = {}) {
  return ASSIGNEE_INPUT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

function extractAssigneeInput(input = {}) {
  for (const key of ASSIGNEE_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function isAllAssigneeInput(value) {
  const tokens = tokenizeAssigneeInput(value);
  return tokens.length === 0 || tokens.some((token) => ALL_ASSIGNEE_TOKENS.has(token.toLowerCase()));
}

function stripAssigneeFields(payload = {}) {
  const cleaned = { ...payload };
  delete cleaned.assignee_input;
  for (const key of ASSIGNEE_INPUT_KEYS) {
    if (key !== "assigned_to") delete cleaned[key];
  }
  return cleaned;
}

function normalizeAssigneeRow(row = {}) {
  return {
    id: row.user_id || row.id,
    name: row.name || row.user_name || null,
    email: row.email || row.user_email || null,
    sub_role: row.sub_role || null,
  };
}

function uniqueAssigneeRows(rows = []) {
  const byId = new Map();
  for (const row of rows) {
    const normalized = normalizeAssigneeRow(row);
    if (!normalized.id) continue;
    byId.set(String(normalized.id), normalized);
  }
  return Array.from(byId.values());
}

function isMissingAssigneeTableError(error) {
  const message = String(error?.message || error || "");
  return /request_assignees|schema cache|Could not find the table|relation .*does not exist/i.test(message);
}

/**
 * Normalizes and validates request input
 */
function validateAndNormalizeRequest(input = {}, fallbackCreatedBy, options = {}) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const subLabelValue = typeof input.sub_label === "string" ? input.sub_label.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const responseType = typeof input.response_type === "string" ? input.response_type.trim() : "";
  const priority = typeof input.priority === "string" ? input.priority.trim().toLowerCase() : "";
  const status = options.forceStatus || (typeof input.status === "string" ? input.status.trim().toLowerCase() : "pending");
  const dueDate = typeof input.due_date === "string" ? input.due_date.trim() : "";
  const assigneeInput = hasAssigneeInput(input) ? extractAssigneeInput(input) : undefined;
  const createdBy = typeof input.created_by === "string" && input.created_by.trim()
    ? input.created_by.trim()
    : fallbackCreatedBy;
  const submissionSource = typeof input.submission_source === "string" && input.submission_source.trim()
    ? input.submission_source.trim().toLowerCase()
    : options.submissionSource || "broker";
  const approvalStatus = typeof input.approval_status === "string" && input.approval_status.trim()
    ? input.approval_status.trim().toLowerCase()
    : options.approvalStatus || "approved";

  const errors = [];

  if (!title) errors.push("title is required");
  if (!description) errors.push("description is required");
  if (!REQUEST_CATEGORIES.includes(category)) {
    errors.push(`category must be one of: ${REQUEST_CATEGORIES.join(", ")}`);
  }
  if (!RESPONSE_TYPES.includes(responseType)) {
    errors.push(`response_type must be one of: ${RESPONSE_TYPES.join(", ")}`);
  }
  if (!PRIORITY_VALUES.includes(priority.toLowerCase())) {
    errors.push(`priority must be one of: ${PRIORITY_VALUES.join(", ")}`);
  }
  if (!REQUEST_STATUSES.includes(status)) {
    errors.push(`status must be one of: ${REQUEST_STATUSES.join(", ")}`);
  }
  
  if (!isValidDate(dueDate)) {
    errors.push("due_date must be in YYYY-MM-DD format");
  } else if (!options.allowPastDates && !isFutureDate(dueDate)) {
    errors.push("due_date must be a future date");
  }
  
  if (!createdBy) errors.push("created_by is required");
  if (!["broker", "user", "client"].includes(submissionSource)) {
    errors.push("submission_source is invalid");
  }
  if (!APPROVAL_STATUSES.includes(approvalStatus)) {
    errors.push("approval_status is invalid");
  }

  return {
    errors,
    value: {
      title,
      sub_label: subLabelValue || null,
      description,
      category,
      response_type: responseType,
      priority,
      reminder_frequency_days: resolveReminderFrequencyDays(priority, input.reminder_frequency_days),
      status,
      due_date: dueDate,
      assigned_to: null,
      assignee_input: assigneeInput,
      visible: normalizeBoolean(input.visible, true),
      created_by: createdBy,
      submission_source: submissionSource,
      approval_status: approvalStatus,
      approved_by: approvalStatus === "approved" ? (options.approvedBy || createdBy) : null,
      approved_at: approvalStatus === "approved" ? new Date().toISOString() : null,
    },
  };
}

function isValidDate(value) {
  if (!value || typeof value !== "string") return false;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime());
}

function isFutureDate(value) {
  return value > new Date().toISOString().slice(0, 10);
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
  }
  return fallback;
}

async function resolveAssigneesForCompany(companyId, rawInput) {
  if (!companyId || isAllAssigneeInput(rawInput)) {
    return { all: true, ids: [], users: [] };
  }

  const tokens = tokenizeAssigneeInput(rawInput);
  const clientUsers = await userService.getClientTeamMembersForCompany(companyId);
  const byEmail = new Map();
  const byId = new Map();

  for (const user of clientUsers || []) {
    if (user?.id) byId.set(String(user.id), user);
    if (user?.email) byEmail.set(normalizeEmail(user.email), user);
  }

  const resolved = new Map();
  const missing = [];
  for (const token of tokens) {
    if (ALL_ASSIGNEE_TOKENS.has(token.toLowerCase())) {
      return { all: true, ids: [], users: [] };
    }
    const match = isUuid(token) ? byId.get(String(token)) : byEmail.get(normalizeEmail(token));
    if (!match) {
      missing.push(token);
      continue;
    }
    resolved.set(String(match.id), match);
  }

  if (missing.length) {
    const err = new Error(`Assigned user not found for this company: ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const users = Array.from(resolved.values());
  return {
    all: users.length === 0,
    ids: users.map((user) => user.id),
    users,
  };
}

async function fetchRequestAssigneeRows(requestIds) {
  if (!requestIds.length) return [];
  try {
    return await pgQuery(
      `SELECT ra.request_id, u.id AS user_id, u.name, u.email, u.sub_role
       FROM request_assignees ra
       JOIN users u ON u.id = ra.user_id
       WHERE ra.request_id = ANY($1)
       ORDER BY ra.created_at ASC`,
      [requestIds],
    );
  } catch {
    try {
      const { data, error } = await supabase
        .from("request_assignees")
        .select("request_id, user:users!request_assignees_user_id_fkey(id, name, email, sub_role)")
        .in("request_id", requestIds);
      if (error) return [];
      return (data || []).map((row) => ({
        request_id: row.request_id,
        user_id: row.user?.id,
        name: row.user?.name,
        email: row.user?.email,
        sub_role: row.user?.sub_role,
      }));
    } catch {
      return [];
    }
  }
}

function decorateRequestAssignees(row, assigneeRows = []) {
  if (!row) return row;
  const joinedAssignees = uniqueAssigneeRows(assigneeRows);
  const legacyAssignees = joinedAssignees.length
    ? []
    : uniqueAssigneeRows([
        {
          user_id: row.assigned_to,
          name: row.assigned_to_name,
          email: row.assigned_to_email,
          sub_role: row.assigned_to_sub_role,
        },
      ]);
  const assignees = joinedAssignees.length ? joinedAssignees : legacyAssignees;
  const assigneeIds = assignees.map((assignee) => assignee.id).filter(Boolean);
  const assigneeEmails = assignees.map((assignee) => assignee.email).filter(Boolean);
  const assigneeNames = assignees.map((assignee) => assignee.name || assignee.email || assignee.id).filter(Boolean);

  return {
    ...row,
    assignees,
    assignee_ids: assigneeIds,
    assigned_to_user_ids: assigneeIds,
    assignee_emails: assigneeEmails,
    assigned_to_emails: assigneeEmails,
    assigned_to_names: assigneeNames,
    assigned_to_display: assigneeNames.length ? assigneeNames.join(", ") : "All client team",
    assigned_to_name: assignees.length === 1 ? (assignees[0].name || row.assigned_to_name || null) : row.assigned_to_name || null,
    assigned_to_email: assignees.length === 1 ? (assignees[0].email || row.assigned_to_email || null) : row.assigned_to_email || null,
    assigned_to_sub_role: assignees.length === 1 ? (assignees[0].sub_role || row.assigned_to_sub_role || null) : row.assigned_to_sub_role || null,
  };
}

async function attachRequestAssignees(rowsOrRow) {
  if (!rowsOrRow) return rowsOrRow;
  const isArrayInput = Array.isArray(rowsOrRow);
  const rows = isArrayInput ? rowsOrRow : [rowsOrRow];
  const requestIds = rows.map((row) => row?.id).filter(Boolean);
  const assigneeRows = await fetchRequestAssigneeRows(requestIds);
  const byRequestId = assigneeRows.reduce((acc, row) => {
    if (!row.request_id) return acc;
    const key = String(row.request_id);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
  const decorated = rows.map((row) => decorateRequestAssignees(row, byRequestId[String(row?.id)] || []));
  return isArrayInput ? decorated : decorated[0];
}

async function syncRequestAssignees(requestId, assigneeIds = []) {
  const ids = Array.from(new Set((assigneeIds || []).filter(Boolean).map(String)));
  try {
    await pgQuery("DELETE FROM request_assignees WHERE request_id=$1", [requestId]);
    if (ids.length) {
      await pgQuery(
        `INSERT INTO request_assignees (request_id, user_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [requestId, ids],
      );
    }
    return;
  } catch (pgError) {
    try {
      const { error: deleteError } = await supabase
        .from("request_assignees")
        .delete()
        .eq("request_id", requestId);
      if (deleteError) throw deleteError;
      if (ids.length) {
        const { error: insertError } = await supabase
          .from("request_assignees")
          .insert(ids.map((userId) => ({ request_id: requestId, user_id: userId })));
        if (insertError) throw insertError;
      }
    } catch (supabaseError) {
      if (isMissingAssigneeTableError(pgError) || isMissingAssigneeTableError(supabaseError)) {
        console.warn("[requestService] request_assignees table is not visible yet; using legacy assigned_to mirror until schema migration/cache reload completes.");
        return;
      }
      const err = new Error(supabaseError?.message || pgError?.message || "Unable to save request assignees.");
      err.status = 500;
      throw err;
    }
  }
}

/**
 * Gets a request by ID with user info
 */
async function getRequestById(requestId) {
  try {
    const rows = await pgQuery(
      `SELECT r.*, u1.name AS created_by_name, u1.email AS created_by_email, u2.name AS approved_by_name,
              u3.name AS assigned_to_name, u3.email AS assigned_to_email, u3.sub_role AS assigned_to_sub_role
       FROM requests r
       LEFT JOIN users u1 ON r.created_by = u1.id
       LEFT JOIN users u2 ON r.approved_by = u2.id
       LEFT JOIN users u3 ON r.assigned_to = u3.id
       WHERE r.id = $1 LIMIT 1`,
      [requestId],
    );
    return rows[0] ? attachRequestAssignees(rows[0]) : null;
  } catch {
    const { data, error } = await supabase
      .from("requests")
      .select(`*, created_by_user:users!requests_created_by_fkey(name, email), approved_by_user:users!requests_approved_by_fkey(name), assigned_to_user:users!requests_assigned_to_fkey(name, email, sub_role)`)
      .eq("id", requestId).maybeSingle();
    if (error || !data) return null;
    return attachRequestAssignees({
      ...data,
      created_by_name: data.created_by_user?.name,
      created_by_email: data.created_by_user?.email,
      approved_by_name: data.approved_by_user?.name,
      assigned_to_name: data.assigned_to_user?.name,
      assigned_to_email: data.assigned_to_user?.email,
      assigned_to_sub_role: data.assigned_to_user?.sub_role,
    });
  }
}

/**
 * Enriches a single request row with user name/sub_role fields for
 * created_by, approved_by, and assigned_to. Safe to call after any UPDATE
 * that returns a raw RETURNING * row without joined user data.
 * Falls back gracefully to the original row if user lookup fails.
 */
async function enrichRequestRow(row) {
  if (!row) return row;
  const ids = [...new Set([row.created_by, row.approved_by, row.assigned_to].filter(Boolean))];
  if (!ids.length) return row;
  try {
    const users = await pgQuery('SELECT id, name, email, sub_role FROM users WHERE id = ANY($1)', [ids]);
    const map = Object.fromEntries(users.map((u) => [String(u.id), u]));
    return {
      ...row,
      created_by_name: map[String(row.created_by)]?.name ?? row.created_by_name ?? null,
      created_by_email: map[String(row.created_by)]?.email ?? row.created_by_email ?? null,
      approved_by_name: map[String(row.approved_by)]?.name ?? row.approved_by_name ?? null,
      assigned_to_name: map[String(row.assigned_to)]?.name ?? row.assigned_to_name ?? null,
      assigned_to_email: map[String(row.assigned_to)]?.email ?? row.assigned_to_email ?? null,
      assigned_to_sub_role: map[String(row.assigned_to)]?.sub_role ?? row.assigned_to_sub_role ?? null,
    };
  } catch {
    try {
      const { data: users } = await supabase.from('users').select('id, name, email, sub_role').in('id', ids);
      const map = Object.fromEntries((users || []).map((u) => [String(u.id), u]));
      return {
        ...row,
        created_by_name: map[String(row.created_by)]?.name ?? row.created_by_name ?? null,
        created_by_email: map[String(row.created_by)]?.email ?? row.created_by_email ?? null,
        approved_by_name: map[String(row.approved_by)]?.name ?? row.approved_by_name ?? null,
        assigned_to_name: map[String(row.assigned_to)]?.name ?? row.assigned_to_name ?? null,
        assigned_to_email: map[String(row.assigned_to)]?.email ?? row.assigned_to_email ?? null,
        assigned_to_sub_role: map[String(row.assigned_to)]?.sub_role ?? row.assigned_to_sub_role ?? null,
      };
    } catch {
      return row;
    }
  }
}

/**
 * Lists requests for a company
 */
async function listRequestsByCompany(companyId) {
  try {
    const rows = await pgQuery(
      `SELECT r.*, u1.name AS created_by_name, u1.email AS created_by_email, u2.name AS approved_by_name,
              u3.name AS assigned_to_name, u3.email AS assigned_to_email, u3.sub_role AS assigned_to_sub_role
       FROM requests r
       LEFT JOIN users u1 ON r.created_by = u1.id
       LEFT JOIN users u2 ON r.approved_by = u2.id
       LEFT JOIN users u3 ON r.assigned_to = u3.id
       WHERE r.company_id = $1
       ORDER BY r.created_at DESC`,
      [companyId],
    );
    return attachRequestAssignees(rows);
  } catch {
    const { data, error } = await supabase
      .from("requests")
      .select("*")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = data || [];
    const creatorIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
    const approverIds = [...new Set(rows.map((r) => r.approved_by).filter(Boolean))];
    const assigneeIds = [...new Set(rows.map((r) => r.assigned_to).filter(Boolean))];
    const allUserIds = [...new Set([...creatorIds, ...approverIds, ...assigneeIds])];
    let userMap = {};
    if (allUserIds.length) {
      const { data: users } = await supabase.from("users").select("id, name, email, sub_role").in("id", allUserIds);
      userMap = Object.fromEntries((users || []).map((u) => [u.id, u]));
    }
    const enrichedRows = rows.map((r) => ({
      ...r,
      created_by_name: userMap[r.created_by]?.name || null,
      created_by_email: userMap[r.created_by]?.email || null,
      approved_by_name: userMap[r.approved_by]?.name || null,
      assigned_to_name: userMap[r.assigned_to]?.name || null,
      assigned_to_email: userMap[r.assigned_to]?.email || null,
      assigned_to_sub_role: userMap[r.assigned_to]?.sub_role || null,
    }));
    return attachRequestAssignees(enrichedRows);
  }
}

/**
 * Creates a new request
 */
async function createRequest(companyId, payload, options = {}) {
  const assigneeIds = Array.isArray(options.assigneeIds) ? options.assigneeIds : null;
  const cleanedPayload = stripAssigneeFields(payload);
  if (assigneeIds) cleanedPayload.assigned_to = assigneeIds[0] || null;
  const fields = { company_id: companyId, ...cleanedPayload };
  let raw;
  try {
    const keys = Object.keys(fields);
    const cols = keys.map((k) => `"${k}"`).join(", ");
    const vals = keys.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await pgQuery(
      `INSERT INTO requests (${cols}) VALUES (${vals}) RETURNING *`,
      keys.map((k) => fields[k]),
    );
    raw = rows[0];
  } catch {
    const { data, error } = await supabase.from("requests").insert(fields).select("*").single();
    if (error) throw error;
    raw = data;
  }
  if (assigneeIds) await syncRequestAssignees(raw.id, assigneeIds);
  return attachRequestAssignees(await enrichRequestRow(raw));
}

/**
 * Updates an existing request
 */
async function updateRequest(requestId, payload, options = {}) {
  let raw;
  const cleanedPayload = stripAssigneeFields(payload);
  try {
    const keys = Object.keys(cleanedPayload);
    if (!keys.length) throw new Error("Nothing to update");
    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(", ");
    const rows = await pgQuery(
      `UPDATE requests SET ${set} WHERE id=$${keys.length + 1} RETURNING *`,
      [...keys.map((k) => cleanedPayload[k]), requestId],
    );
    raw = rows[0];
  } catch {
    const { data, error } = await supabase.from("requests").update(cleanedPayload).eq("id", requestId).select("*").single();
    if (error) throw error;
    raw = data;
  }
  if (Array.isArray(options.assigneeIds)) {
    await syncRequestAssignees(requestId, options.assigneeIds);
  }
  return attachRequestAssignees(await enrichRequestRow(raw));
}

/**
 * Creates a reminder event
 */
async function createReminderEvent(requestId, sentBy, sentAt = null, options = {}) {
  const reminderSentAt = sentAt || new Date().toISOString();
  const eventType = ["sent", "skipped", "overdue"].includes(String(options.eventType || "sent"))
    ? String(options.eventType || "sent")
    : "sent";
  const deliveryChannel = typeof options.deliveryChannel === "string" && options.deliveryChannel.trim()
    ? options.deliveryChannel.trim()
    : eventType === "skipped"
    ? "in_app"
    : "email_in_app";
  const scheduledFor = options.scheduledFor || null;
  const metadata = options.metadata && typeof options.metadata === "object" ? options.metadata : {};

  try {
    const rows = await pgQuery(
      `INSERT INTO request_reminders
        (request_id, sent_by, sent_at, event_type, delivery_channel, scheduled_for, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [requestId, sentBy, reminderSentAt, eventType, deliveryChannel, scheduledFor, metadata],
    );
    return rows[0];
  } catch (pgError) {
    if (eventType !== "sent" && /column .* does not exist|schema cache|event_type/i.test(pgError.message || "")) {
      throw pgError;
    }

    const payload = {
      request_id: requestId,
      sent_by: sentBy,
      sent_at: reminderSentAt,
      event_type: eventType,
      delivery_channel: deliveryChannel,
      scheduled_for: scheduledFor,
      metadata,
    };
    const { data, error } = await supabase.from("request_reminders")
      .insert(payload).select("*").single();
    if (error && eventType === "sent" && /event_type|delivery_channel|scheduled_for|metadata|schema cache/i.test(error.message || "")) {
      const { data: legacyData, error: legacyError } = await supabase.from("request_reminders")
        .insert({ request_id: requestId, sent_by: sentBy, sent_at: reminderSentAt }).select("*").single();
      if (legacyError) throw legacyError;
      return legacyData;
    }
    if (error) throw error;
    return data;
  }
}

async function listReminderEventsForRequest(requestId) {
  try {
    return await pgQuery(
      "SELECT * FROM request_reminders WHERE request_id=$1 ORDER BY sent_at DESC",
      [requestId],
    );
  } catch {
    const { data, error } = await supabase
      .from("request_reminders")
      .select("*")
      .eq("request_id", requestId)
      .order("sent_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
}

/**
 * Bulk creates requests
 */
async function createRequestsBulk(companyId, items, createdBy) {
  const normalizedItems = items.map((item) => {
    const normalized = validateAndNormalizeRequest(item, createdBy, {
      submissionSource: "broker",
      approvalStatus: "approved",
      approvedBy: createdBy,
      forceStatus: "pending",
      allowPastDates: true,
    });
    return normalized;
  });

  const validationErrors = normalizedItems
    .map((item, index) => ({ index, ...item }))
    .filter((item) => item.errors.length > 0)
    .map((item) => ({
      row: item.index + 2,
      errors: item.errors,
    }));

  if (validationErrors.length > 0) {
    return { validationErrors };
  }

  const assigneeResolutions = [];
  const assignmentErrors = [];
  for (let index = 0; index < normalizedItems.length; index += 1) {
    try {
      assigneeResolutions[index] = await resolveAssigneesForCompany(companyId, normalizedItems[index].value.assignee_input);
    } catch (err) {
      assignmentErrors.push({
        row: index + 2,
        errors: [err.message || "Assigned user is invalid."],
      });
    }
  }

  if (assignmentErrors.length > 0) {
    return { validationErrors: assignmentErrors };
  }

  const createdRows = [];
  for (let index = 0; index < normalizedItems.length; index += 1) {
    const created = await createRequest(companyId, normalizedItems[index].value, {
      assigneeIds: assigneeResolutions[index]?.ids || [],
    });
    if (created?.id) createdRows.push(created);
  }

  const ids = createdRows.map((row) => row.id);
  for (const id of ids) {
    await createReminderEvent(id, createdBy, null, {
      eventType: "sent",
      metadata: { trigger: "initial_bulk" },
    });
  }
  return { count: ids.length, ids };
}

/**
 * Approves a request
 */
async function approveRequest(requestId, approvedBy, assigneeIds = undefined) {
  const now = new Date().toISOString();
  let raw;
  const shouldUpdateAssignees = Array.isArray(assigneeIds) || typeof assigneeIds === "string";
  const normalizedAssigneeIds = Array.isArray(assigneeIds)
    ? assigneeIds
    : typeof assigneeIds === "string" && assigneeIds
    ? [assigneeIds]
    : [];
  const assignedTo = shouldUpdateAssignees ? (normalizedAssigneeIds[0] || null) : null;
  try {
    const query = shouldUpdateAssignees
      ? "UPDATE requests SET approval_status='approved', approved_by=$1, approved_at=$2, updated_at=$3, assigned_to=$5 WHERE id=$4 RETURNING *"
      : "UPDATE requests SET approval_status='approved', approved_by=$1, approved_at=$2, updated_at=$3 WHERE id=$4 RETURNING *";
    const params = shouldUpdateAssignees
      ? [approvedBy, now, now, requestId, assignedTo]
      : [approvedBy, now, now, requestId];
    const rows = await pgQuery(query, params);
    await createReminderEvent(requestId, approvedBy, now, {
      eventType: "sent",
      metadata: { trigger: "approval" },
    });
    raw = rows[0];
  } catch {
    const updatePayload = { approval_status: "approved", approved_by: approvedBy, approved_at: now, updated_at: now };
    if (shouldUpdateAssignees) updatePayload.assigned_to = assignedTo;
    const { data, error } = await supabase.from("requests")
      .update(updatePayload)
      .eq("id", requestId).select("*").single();
    if (error) throw error;
    await createReminderEvent(requestId, approvedBy, now, {
      eventType: "sent",
      metadata: { trigger: "approval" },
    });
    raw = data;
  }
  if (shouldUpdateAssignees) {
    await syncRequestAssignees(requestId, normalizedAssigneeIds);
  }
  return attachRequestAssignees(await enrichRequestRow(raw));
}

async function deleteRequest(requestId) {
  try {
    await pgQuery("DELETE FROM request_assignees WHERE request_id=$1", [requestId]);
    await pgQuery("DELETE FROM request_reminders WHERE request_id=$1", [requestId]);
    await pgQuery("DELETE FROM requests WHERE id=$1", [requestId]);
  } catch {
    try {
      await supabase
        .from("request_assignees")
        .delete()
        .eq("request_id", requestId);
    } catch {
      // Ignore missing join table during rolling deploys; requests cascade once the table exists.
    }
    const { error: reminderError } = await supabase
      .from("request_reminders")
      .delete()
      .eq("request_id", requestId);
    if (reminderError) throw reminderError;
    const { error } = await supabase.from("requests").delete().eq("id", requestId);
    if (error) throw error;
  }
}

async function listRequestDocuments(requestId) {
  const { data: links, error: linksError } = await supabase
    .from("request_documents")
    .select("id, request_id, document_id, visible, created_at")
    .eq("request_id", requestId)
    .order("created_at", { ascending: false });

  if (linksError) throw linksError;
  if (!links || links.length === 0) return [];

  const documentIds = links.map((l) => l.document_id).filter(Boolean);
  const { data: documents, error: docsError } = await supabase
    .from("documents")
    .select("id, name, file_url, status, upload_id, ext, size, uploaded_by")
    .in("id", documentIds);

  if (docsError) throw docsError;

  const docMap = {};
  (documents || []).forEach((doc) => { docMap[doc.id] = doc; });

  const uploaderIds = [...new Set((documents || []).map((d) => d.uploaded_by).filter(Boolean))];
  let displayById = new Map();
  if (uploaderIds.length) {
    const { data: users } = await supabase
      .from("users")
      .select("id, name, email, role")
      .in("id", uploaderIds);
    displayById = new Map((users || []).map((u) => [u.id, formatUploaderDisplay(u)]));
  }

  return links.map((rd) => {
    const doc = docMap[rd.document_id] || {};
    return {
      ...rd,
      name: doc.name,
      file_url: doc.file_url,
      status: doc.status,
      upload_id: doc.upload_id,
      ext: doc.ext || '',
      size: doc.size || '',
      uploaded_by_name: displayById.get(doc.uploaded_by) || null,
    };
  });
}

async function addRequestDocument(requestId, documentId, visible = true) {
  try {
    const rows = await pgQuery(
      "INSERT INTO request_documents (request_id, document_id, visible) VALUES ($1, $2, $3) RETURNING *",
      [requestId, documentId, normalizeBoolean(visible, true)],
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("request_documents")
      .insert({ request_id: requestId, document_id: documentId, visible: normalizeBoolean(visible, true) }).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function updateNarrative(requestId, content, updatedBy) {
  const now = new Date().toISOString();
  try {
    const rows = await pgQuery(
      `INSERT INTO request_narratives (request_id, content, updated_by, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id) DO UPDATE SET content=$2, updated_by=$3, updated_at=$4
       RETURNING *`,
      [requestId, content, updatedBy, now],
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("request_narratives")
      .upsert({ request_id: requestId, content, updated_by: updatedBy, updated_at: now }, { onConflict: "request_id" }).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function getNarrative(requestId) {
  // Returns { content, updated_by, updated_at, author_name, author_role } or null.
  try {
    const rows = await pgQuery(
      `SELECT rn.content, rn.updated_by, rn.updated_at,
              u.name  AS author_name,
              u.role  AS author_role
       FROM request_narratives rn
       LEFT JOIN users u ON u.id = rn.updated_by
       WHERE rn.request_id = $1 LIMIT 1`,
      [requestId],
    );
    return rows[0] || null;
  } catch {
    const { data, error } = await supabase
      .from("request_narratives")
      .select("content, updated_by, updated_at")
      .eq("request_id", requestId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    // Resolve author name via a second query.
    let author_name = null;
    let author_role = null;
    if (data.updated_by) {
      const { data: user } = await supabase
        .from("users")
        .select("name, role")
        .eq("id", data.updated_by)
        .maybeSingle();
      author_name = user?.name || null;
      author_role = user?.role || null;
    }
    return { ...data, author_name, author_role };
  }
}

module.exports = {
  validateAndNormalizeRequest,
  hasAssigneeInput,
  extractAssigneeInput,
  resolveAssigneesForCompany,
  attachRequestAssignees,
  getRequestById,
  listRequestsByCompany,
  createRequest,
  createRequestsBulk,
  updateRequest,
  approveRequest,
  deleteRequest,
  createReminderEvent,
  listReminderEventsForRequest,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrative,
  REQUEST_CATEGORIES,
  RESPONSE_TYPES,
  REQUEST_STATUSES,
  APPROVAL_STATUSES
};
