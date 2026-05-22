const { supabase } = require("../db");
const { Pool } = require("pg");
const { resolveReminderFrequencyDays } = require("../utils/requestReminders");

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000 });
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

const REQUEST_CATEGORIES = ["Finance", "Legal", "Compliance", "HR", "Tax", "M&A", "Other"];
const RESPONSE_TYPES = ["Upload", "Narrative", "Both"];
const REQUEST_STATUSES = ["pending", "in-review", "completed", "blocked"];
const APPROVAL_STATUSES = ["pending", "approved"];

/**
 * Normalizes and validates request input
 */
function validateAndNormalizeRequest(input = {}, fallbackCreatedBy, options = {}) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const subLabelValue = typeof input.sub_label === "string" ? input.sub_label.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const responseType = typeof input.response_type === "string" ? input.response_type.trim() : "";
  const priority = typeof input.priority === "string" ? input.priority.trim() : "";
  const status = options.forceStatus || (typeof input.status === "string" ? input.status.trim().toLowerCase() : "pending");
  const dueDate = typeof input.due_date === "string" ? input.due_date.trim() : "";
  const assignedTo = typeof input.assigned_to === "string" && input.assigned_to.trim()
    ? input.assigned_to.trim()
    : null;
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
  if (!priority) errors.push("priority is required");
  if (!REQUEST_STATUSES.includes(status)) {
    errors.push(`status must be one of: ${REQUEST_STATUSES.join(", ")}`);
  }
  
  if (!isValidDate(dueDate)) {
    errors.push("due_date must be in YYYY-MM-DD format");
  } else if (!isFutureDate(dueDate)) {
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
      assigned_to: assignedTo,
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

/**
 * Gets a request by ID with user info
 */
async function getRequestById(requestId) {
  try {
    const rows = await pgQuery(
      `SELECT r.*, u1.name AS created_by_name, u1.email AS created_by_email, u2.name AS approved_by_name
       FROM requests r
       LEFT JOIN users u1 ON r.created_by = u1.id
       LEFT JOIN users u2 ON r.approved_by = u2.id
       WHERE r.id = $1 LIMIT 1`,
      [requestId],
    );
    return rows[0] || null;
  } catch {
    const { data, error } = await supabase
      .from("requests")
      .select(`*, created_by_user:users!requests_created_by_fkey(name, email), approved_by_user:users!requests_approved_by_fkey(name)`)
      .eq("id", requestId).maybeSingle();
    if (error || !data) return null;
    return { ...data, created_by_name: data.created_by_user?.name, created_by_email: data.created_by_user?.email, approved_by_name: data.approved_by_user?.name };
  }
}

/**
 * Lists requests for a company
 */
async function listRequestsByCompany(companyId) {
  try {
    const rows = await pgQuery(
      `SELECT r.*, u1.name AS created_by_name, u1.email AS created_by_email, u2.name AS approved_by_name
       FROM requests r
       LEFT JOIN users u1 ON r.created_by = u1.id
       LEFT JOIN users u2 ON r.approved_by = u2.id
       WHERE r.company_id = $1
       ORDER BY r.created_at DESC`,
      [companyId],
    );
    return rows;
  } catch {
    const { data, error } = await supabase
      .from("requests")
      .select(`*, created_by_user:users!requests_created_by_fkey(name, email), approved_by_user:users!requests_approved_by_fkey(name)`)
      .eq("company_id", companyId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => ({ ...r, created_by_name: r.created_by_user?.name, created_by_email: r.created_by_user?.email, approved_by_name: r.approved_by_user?.name }));
  }
}

/**
 * Creates a new request
 */
async function createRequest(companyId, payload) {
  const fields = { company_id: companyId, ...payload };
  try {
    const keys = Object.keys(fields);
    const cols = keys.map((k) => `"${k}"`).join(", ");
    const vals = keys.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await pgQuery(
      `INSERT INTO requests (${cols}) VALUES (${vals}) RETURNING *`,
      keys.map((k) => fields[k]),
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("requests").insert(fields).select("*").single();
    if (error) throw error;
    return data;
  }
}

/**
 * Updates an existing request
 */
async function updateRequest(requestId, payload) {
  try {
    const keys = Object.keys(payload);
    if (!keys.length) throw new Error("Nothing to update");
    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(", ");
    const rows = await pgQuery(
      `UPDATE requests SET ${set} WHERE id=$${keys.length + 1} RETURNING *`,
      [...keys.map((k) => payload[k]), requestId],
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("requests").update(payload).eq("id", requestId).select("*").single();
    if (error) throw error;
    return data;
  }
}

/**
 * Creates a reminder event
 */
async function createReminderEvent(requestId, sentBy, sentAt = null) {
  const reminderSentAt = sentAt || new Date().toISOString();
  try {
    const rows = await pgQuery(
      "INSERT INTO request_reminders (request_id, sent_by, sent_at) VALUES ($1, $2, $3) RETURNING *",
      [requestId, sentBy, reminderSentAt],
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("request_reminders")
      .insert({ request_id: requestId, sent_by: sentBy, sent_at: reminderSentAt }).select("*").single();
    if (error) throw error;
    return data;
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

  const payloads = normalizedItems.map(item => ({
    company_id: companyId,
    ...item.value
  }));

  let ids = [];
  try {
    const results = await Promise.all(payloads.map(async (p) => {
      const keys = Object.keys(p);
      const cols = keys.map((k) => `"${k}"`).join(", ");
      const vals = keys.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await pgQuery(`INSERT INTO requests (${cols}) VALUES (${vals}) RETURNING id`, keys.map((k) => p[k]));
      return rows[0]?.id;
    }));
    ids = results.filter(Boolean);
  } catch {
    const { data, error } = await supabase.from("requests").insert(payloads).select("id");
    if (error) throw error;
    ids = (data || []).map((r) => r.id);
  }

  for (const id of ids) await createReminderEvent(id, createdBy);
  return { count: ids.length };
}

/**
 * Approves a request
 */
async function approveRequest(requestId, approvedBy) {
  const now = new Date().toISOString();
  try {
    const rows = await pgQuery(
      "UPDATE requests SET approval_status='approved', approved_by=$1, approved_at=$2, updated_at=$3 WHERE id=$4 RETURNING *",
      [approvedBy, now, now, requestId],
    );
    await createReminderEvent(requestId, approvedBy);
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("requests")
      .update({ approval_status: "approved", approved_by: approvedBy, approved_at: now, updated_at: now })
      .eq("id", requestId).select("*").single();
    if (error) throw error;
    await createReminderEvent(requestId, approvedBy);
    return data;
  }
}

async function deleteRequest(requestId) {
  try {
    await pgQuery("DELETE FROM request_reminders WHERE request_id=$1", [requestId]);
    await pgQuery("DELETE FROM requests WHERE id=$1", [requestId]);
  } catch {
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
    .select("id, name, file_url, status, upload_id")
    .in("id", documentIds);

  if (docsError) throw docsError;

  const docMap = {};
  (documents || []).forEach((doc) => { docMap[doc.id] = doc; });

  return links.map((rd) => {
    const doc = docMap[rd.document_id] || {};
    return {
      ...rd,
      name: doc.name,
      file_url: doc.file_url,
      status: doc.status,
      upload_id: doc.upload_id,
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
  try {
    const rows = await pgQuery("SELECT content FROM request_narratives WHERE request_id=$1 LIMIT 1", [requestId]);
    return rows[0] || null;
  } catch {
    const { data, error } = await supabase.from("request_narratives").select("content").eq("request_id", requestId).maybeSingle();
    if (error) throw error;
    return data;
  }
}

module.exports = {
  validateAndNormalizeRequest,
  getRequestById,
  listRequestsByCompany,
  createRequest,
  createRequestsBulk,
  updateRequest,
  approveRequest,
  deleteRequest,
  createReminderEvent,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrative,
  REQUEST_CATEGORIES,
  RESPONSE_TYPES,
  REQUEST_STATUSES,
  APPROVAL_STATUSES
};
