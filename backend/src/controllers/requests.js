const { supabase } = require("../db");
const asyncHandler = require("../utils");
const { buildAppBaseUrl } = require("../utils/uploadStorage");
const {
  buildReminderFrequencyLabel,
  resolveReminderFrequencyDays,
  addDays,
  isRequestResolved,
} = require("../utils/requestReminders");

const REQUEST_CATEGORIES = ["Finance", "Legal", "Compliance", "HR", "Tax", "M&A", "Other"];
const RESPONSE_TYPES = ["Upload", "Narrative", "Both"];
const REQUEST_STATUSES = ["pending", "in-review", "completed", "blocked"];
const APPROVAL_STATUSES = ["pending", "approved"];

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
  if (!user || !companyId) return false;
  if (isBroker(user)) return true;
  return normalizeCompanyIds(user).includes(String(companyId));
}

function canAccessRequest(user, request) {
  if (!user || !request) return false;
  if (!canAccessCompany(user, request.company_id)) return false;
  if (isBroker(user)) return true;
  if (user?.effective_role === "client") {
    return request.approval_status === "approved" && request.visible !== false && request.visible !== 0;
  }
  return request.approval_status === "approved" || String(request.created_by) === String(user.id);
}

function isCompletedRequest(request) {
  return request?.status === "completed";
}

function isInReviewRequest(request) {
  return request?.status === "in-review";
}

function isPendingRequest(request) {
  return request?.status === "pending";
}

function filterRequestsForUser(user, requests) {
  if (isBroker(user)) return requests;

  if (user?.effective_role === "client") {
    return requests.filter(
      (request) => request.approval_status === "approved" && request.visible !== false && request.visible !== 0,
    );
  }

  return requests.filter(
    (request) => request.approval_status === "approved" || String(request.created_by) === String(user?.id),
  );
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

async function createRequestReminderEvent(requestId, sentBy, sentAt = null) {
  if (!requestId || !sentBy) return null;
  const reminderSentAt = sentAt || new Date().toISOString();
  const { data, error } = await supabase
    .from("request_reminders")
    .insert({ request_id: requestId, sent_by: sentBy, sent_at: reminderSentAt })
    .select("*")
    .single();
  return data || null;
}

function normalizeRequestInput(input = {}, fallbackCreatedBy, options = {}) {
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

async function insertRequest(companyId, payload) {
  const { data, error } = await supabase
    .from("requests")
    .insert({
      company_id: companyId,
      ...payload
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function getRequestById(requestId) {
  const { data, error } = await supabase
    .from("requests")
    .select(`
      *,
      created_by_user:users!requests_created_by_fkey(name, email),
      approved_by_user:users!requests_approved_by_fkey(name)
    `)
    .eq("id", requestId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    ...data,
    created_by_name: data.created_by_user?.name,
    created_by_email: data.created_by_user?.email,
    approved_by_name: data.approved_by_user?.name
  };
}

const listRequests = asyncHandler(async (req, res) => {
  if (!canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("requests")
    .select(`
      *,
      created_by_user:users!requests_created_by_fkey(name, email),
      approved_by_user:users!requests_approved_by_fkey(name)
    `)
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const mapped = (data || []).map(r => ({
    ...r,
    created_by_name: r.created_by_user?.name,
    created_by_email: r.created_by_user?.email,
    approved_by_name: r.approved_by_user?.name
  }));

  res.json(filterRequestsForUser(req.user, mapped));
});

const createRequest = asyncHandler(async (req, res) => {
  if (!canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const submissionSource = req.user?.effective_role === "user"
    ? "user"
    : req.user?.effective_role === "client"
    ? "client"
    : "broker";
  const approvalStatus = submissionSource === "user" ? "pending" : "approved";

  const normalized = normalizeRequestInput(req.body || {}, req.user?.id, {
    submissionSource,
    approvalStatus,
    approvedBy: approvalStatus === "approved" ? req.user?.id : null,
    forceStatus: "pending",
  });
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join("; ") });
  }

  const created = await insertRequest(req.params.id, normalized.value);
  if (normalized.value.approval_status === "approved") {
    await createRequestReminderEvent(created.id, req.user?.id || normalized.value.approved_by || normalized.value.created_by);
  }
  res.status(201).json(await getRequestById(created.id));
});

const createRequestsBulk = asyncHandler(async (req, res) => {
  if (!canAccessCompany(req.user, req.params.id) || !isBroker(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const items = Array.isArray(req.body?.requests) ? req.body.requests : [];
  if (items.length === 0) {
    return res.status(400).json({ error: "requests array is required" });
  }

  const normalizedItems = items.map((item, index) => {
    const normalized = normalizeRequestInput(item, req.user?.id, {
      submissionSource: "broker",
      approvalStatus: "approved",
      approvedBy: req.user?.id,
      forceStatus: "pending",
    });
    return {
      index,
      ...normalized,
    };
  });

  const validationErrors = normalizedItems
    .filter((item) => item.errors.length > 0)
    .map((item) => ({
      row: item.index + 2,
      errors: item.errors,
    }));

  if (validationErrors.length > 0) {
    const summary = validationErrors
      .map((item) => `Row ${item.row}: ${item.errors.join(", ")}`)
      .join("; ");

    return res.status(400).json({
      error: summary || "Bulk request validation failed",
      errors: validationErrors,
    });
  }

  const created = [];
  for (const item of normalizedItems) {
    const request = await insertRequest(req.params.id, item.value);
    await createRequestReminderEvent(request.id, req.user?.id || item.value.approved_by || item.value.created_by);
    created.push(await getRequestById(request.id));
  }

  res.status(201).json({
    count: created.length,
    created,
  });
});

const getRequest = asyncHandler(async (req, res) => {
  const request = await getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: "Not found" });
  if (!canAccessRequest(req.user, request)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(request);
});

const updateRequest = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (isCompletedRequest(current)) {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const body = req.body || {};

  if (!isBroker(req.user)) {
    const role = req.user?.effective_role;

    if (role === "user") {
      if (!isPendingRequest(current)) {
        return res.status(403).json({ error: "Users can only edit pending requests." });
      }

      const allowedKeys = ["title", "description", "priority", "due_date"];
      const invalidKey = Object.keys(body).find((key) => !allowedKeys.includes(key));
      if (invalidKey) {
        return res.status(403).json({ error: "Users can only edit request title, description, priority, and due date." });
      }
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  const updates = { ...body, updated_at: new Date().toISOString() };
  delete updates.reminder_frequency_days;

  if (Object.keys(updates).length <= 1) return res.status(400).json({ error: "No updates" });

  const { data, error } = await supabase
    .from("requests")
    .update(updates)
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(404).json({ error: error.message });
  res.json(await getRequestById(req.params.id));
});

const approveRequest = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!isBroker(req.user) || !canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("requests")
    .update({
      approval_status: "approved",
      approved_by: req.user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(404).json({ error: error.message });
  await createRequestReminderEvent(req.params.id, req.user.id);
  res.json(await getRequestById(req.params.id));
});

const deleteRequest = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!isBroker(req.user) || !canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { error } = await supabase.from("requests").delete().eq("id", req.params.id);
  if (error) return res.status(404).json({ error: error.message });
  res.status(204).send();
});

const addRequestReminder = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!isBroker(req.user) || !canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (isRequestResolved(current.status)) {
    return res.status(400).json({ error: "Resolved requests do not need reminders." });
  }

  const sentBy = req.body?.sent_by || req.user?.id;
  const sentAt = req.body?.sent_at || new Date().toISOString();
  if (!sentBy) return res.status(400).json({ error: "sent_by required" });

  const reminder = await createRequestReminderEvent(req.params.id, sentBy, sentAt);
  res.status(201).json(reminder);
});

const listRequestDocuments = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("request_documents")
    .select(`
      id, request_id, document_id, visible, created_at,
      document:documents!request_documents_document_id_fkey(name, file_url, status, upload_id)
    `)
    .eq("request_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const mapped = (data || []).map(rd => ({
    ...rd,
    name: rd.document?.name,
    file_url: rd.document?.file_url,
    status: rd.document?.status,
    upload_id: rd.document?.upload_id
  }));

  res.json(mapped);
});

const addRequestDocument = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (isCompletedRequest(current)) {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const { document_id, visible } = req.body || {};
  if (!document_id) return res.status(400).json({ error: "document_id required" });

  const { data, error } = await supabase
    .from("request_documents")
    .insert({
      request_id: req.params.id,
      document_id,
      visible: normalizeBoolean(visible, true)
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (current.status === "pending") {
    await supabase
      .from("requests")
      .update({ status: "in-review", updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
  }

  const updatedRequest = await getRequestById(req.params.id);
  res.status(201).json(updatedRequest || data);
});

const updateNarrative = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (isCompletedRequest(current)) {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const { content, updated_by } = req.body || {};
  const resolvedUpdatedBy = updated_by || req.user?.id;
  if (!content || !resolvedUpdatedBy) {
    return res.status(400).json({ error: "content and updated_by required" });
  }

  const { data, error } = await supabase
    .from("request_narratives")
    .upsert({
      request_id: req.params.id,
      content,
      updated_by: resolvedUpdatedBy,
      updated_at: new Date().toISOString()
    }, { onConflict: "request_id" })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (current.status === "pending") {
    await supabase
      .from("requests")
      .update({ status: "in-review", updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
  }

  const request = current;
  if (request?.company_id) {
    const folderName = request.category || request.sub_label || "Other";
    let { data: folderRow } = await supabase
      .from("folders")
      .select("id, name")
      .eq("company_id", request.company_id)
      .ilike("name", folderName)
      .maybeSingle();

    if (!folderRow) {
      const { data: createdFolder } = await supabase
        .from("folders")
        .insert({
          company_id: request.company_id,
          parent_id: null,
          name: folderName,
          color: null,
          created_by: resolvedUpdatedBy
        })
        .select("*")
        .single();
      folderRow = createdFolder;
    }

    if (folderRow?.id) {
      const docName = `request-${request.id}-narrative.txt`;
      const fileUrl = `${buildAppBaseUrl(req)}/requests/${request.id}/narrative/file`;
      const size = Buffer.byteLength(content || "", "utf8").toString();

      const { data: existingDoc } = await supabase
        .from("documents")
        .select("id")
        .eq("folder_id", folderRow.id)
        .eq("name", docName)
        .maybeSingle();

      let documentId = existingDoc?.id;
      if (existingDoc?.id) {
        await supabase
          .from("documents")
          .update({
            file_url: fileUrl,
            upload_id: null,
            size: size,
            status: "under-review",
            uploaded_by: resolvedUpdatedBy,
            uploaded_at: new Date().toISOString()
          })
          .eq("id", existingDoc.id);
      } else {
        const { data: createdDoc } = await supabase
          .from("documents")
          .insert({
            company_id: request.company_id,
            folder_id: folderRow.id,
            name: docName,
            file_url: fileUrl,
            upload_id: null,
            size: size,
            ext: "txt",
            status: "under-review",
            uploaded_by: resolvedUpdatedBy
          })
          .select("*")
          .single();
        documentId = createdDoc?.id;
      }

      if (documentId) {
        const { data: link } = await supabase
          .from("request_documents")
          .select("id")
          .eq("request_id", request.id)
          .eq("document_id", documentId)
          .maybeSingle();
        if (!link) {
          await supabase
            .from("request_documents")
            .insert({
              request_id: request.id,
              document_id: documentId,
              visible: true
            });
        }
      }
    }
  }
  const updatedRequest = await getRequestById(req.params.id);
  res.json(updatedRequest || data);
});

const getNarrativeFile = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).send("Not found");
  if (!canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("request_narratives")
    .select("content")
    .eq("request_id", req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(data.content || "");
});

module.exports = {
  listRequests,
  createRequest,
  createRequestsBulk,
  getRequest,
  updateRequest,
  approveRequest,
  deleteRequest,
  addRequestReminder,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrativeFile,
};

