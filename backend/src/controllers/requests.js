const db = require("../db");
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

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

function enumAssignment(column, placeholderIndex, typeName) {
  return db.isPostgres
    ? `${column} = $${placeholderIndex}::${typeName}`
    : `${column} = $${placeholderIndex}`;
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
  const rows = rowsOf(await db.query(
    "INSERT INTO request_reminders (request_id, sent_by, sent_at) VALUES ($1, $2, $3) RETURNING *",
    [requestId, sentBy, reminderSentAt],
  ));
  return rows[0] || null;
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
  const columns = [
    "company_id",
    "title",
    "sub_label",
    "description",
    "category",
    "response_type",
    "priority",
    "status",
    "due_date",
    "assigned_to",
    "visible",
    "created_by",
    "submission_source",
    "approval_status",
    "approved_by",
    "approved_at",
  ];
  const values = [
    companyId,
    payload.title,
    payload.sub_label,
    payload.description,
    payload.category,
    payload.response_type,
    payload.priority,
    payload.status,
    payload.due_date,
    payload.assigned_to,
    payload.visible,
    payload.created_by,
    payload.submission_source,
    payload.approval_status,
    payload.approved_by,
    payload.approved_at,
  ];

  const placeholders = columns.map((_, index) => {
    const position = index + 1;
    const column = columns[index];
    if (column === "category" && db.isPostgres) return `$${position}::request_category`;
    if (column === "response_type" && db.isPostgres) return `$${position}::response_type`;
    if (column === "priority" && db.isPostgres) return `$${position}::request_priority`;
    if (column === "status" && db.isPostgres) return `$${position}::request_status`;
    if (column === "visible") return `COALESCE($${position}, true)`;
    return `$${position}`;
  });

  const { rows } = await db.query(
    `INSERT INTO requests (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    values
  );

  return rows[0];
}

async function getRequestById(requestId) {
  const rows = rowsOf(await db.query(
    `SELECT
       r.*,
       u.name AS created_by_name,
       u.email AS created_by_email,
       approver.name AS approved_by_name
     FROM requests r
     LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN users approver ON approver.id = r.approved_by
     WHERE r.id = $1`,
    [requestId],
  ));
  return rows[0] || null;
}

const listRequests = asyncHandler(async (req, res) => {
  if (!canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const rows = rowsOf(await db.query(
    `SELECT
       r.*,
       u.name AS created_by_name,
       u.email AS created_by_email,
       approver.name AS approved_by_name
     FROM requests r
     LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN users approver ON approver.id = r.approved_by
     WHERE r.company_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.id]
  ));

  res.json(filterRequestsForUser(req.user, rows));
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

  const fields = [];
  const values = [];
  let idx = 1;
  const updateBody = { ...body };
  delete updateBody.reminder_frequency_days;

  Object.keys(updateBody).forEach((key) => {
    const placeholderIndex = idx++;
    if (key === "category") {
      fields.push(enumAssignment(key, placeholderIndex, "request_category"));
    } else if (key === "response_type") {
      fields.push(enumAssignment(key, placeholderIndex, "response_type"));
    } else if (key === "priority") {
      fields.push(enumAssignment(key, placeholderIndex, "request_priority"));
    } else if (key === "status") {
      fields.push(enumAssignment(key, placeholderIndex, "request_status"));
    } else {
      fields.push(`${key} = $${placeholderIndex}`);
    }
    values.push(updateBody[key]);
  });

  if (fields.length === 0) return res.status(400).json({ error: "No updates" });

  values.push(req.params.id);
  const rows = rowsOf(await db.query(
    `UPDATE requests SET ${fields.join(", ")}, updated_at = datetime('now') WHERE id = $${idx} RETURNING *`,
    values
  ));
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(await getRequestById(req.params.id));
});

const approveRequest = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!isBroker(req.user) || !canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const setClauses = [
    "approval_status = 'approved'",
    "approved_by = $1",
    "approved_at = datetime('now')",
    "updated_at = datetime('now')",
  ];

  const rows = rowsOf(await db.query(
    `UPDATE requests
     SET ${setClauses.join(", ")}
     WHERE id = $2
     RETURNING *`,
    [req.user.id, req.params.id],
  ));
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  await createRequestReminderEvent(req.params.id, req.user.id);
  res.json(await getRequestById(req.params.id));
});

const deleteRequest = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!isBroker(req.user) || !canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const result = await db.query("DELETE FROM requests WHERE id = $1", [req.params.id]);
  const rowCount = result?.rowCount ?? result?.changes ?? 0;
  if (!rowCount) return res.status(404).json({ error: "Not found" });
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

  const rows = rowsOf(await db.query(
    `SELECT rd.*, d.name, d.file_url, d.status, d.upload_id
     FROM request_documents rd
     JOIN documents d ON d.id = rd.document_id
     WHERE rd.request_id = $1
     ORDER BY rd.created_at DESC`,
    [req.params.id]
  ));
  res.json(rows);
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

  const rows = rowsOf(await db.query(
    "INSERT INTO request_documents (request_id, document_id, visible) VALUES ($1, $2, COALESCE($3, true)) RETURNING *",
    [req.params.id, document_id, visible]
  ));

  await db.query(
    `UPDATE requests
     SET status = ${db.isPostgres ? "$1::request_status" : "$1"}, updated_at = datetime('now')
     WHERE id = $2 AND status = 'pending'`,
    ["in-review", req.params.id]
  );

  const updatedRequest = await getRequestById(req.params.id);
  res.status(201).json(updatedRequest || rows[0]);
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

  const rows = rowsOf(await db.query(
    `INSERT INTO request_narratives (request_id, content, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (request_id) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = datetime('now')
     RETURNING *`,
    [req.params.id, content, resolvedUpdatedBy]
  ));

  await db.query(
    `UPDATE requests
     SET status = ${db.isPostgres ? "$1::request_status" : "$1"}, updated_at = datetime('now')
     WHERE id = $2 AND status = 'pending'`,
    ["in-review", req.params.id]
  );

  const request = current;
  if (request?.company_id) {
    const folderName = request.category || request.sub_label || "Other";
    let folderRow = rowsOf(await db.query(
      "SELECT id, name FROM folders WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1",
      [request.company_id, folderName]
    ))[0];

    if (!folderRow) {
      const createdFolder = rowsOf(await db.query(
        "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [request.company_id, null, folderName, null, resolvedUpdatedBy]
      ));
      folderRow = createdFolder[0];
    }

    if (folderRow?.id) {
      const docName = `request-${request.id}-narrative.txt`;
      const fileUrl = `${buildAppBaseUrl(req)}/requests/${request.id}/narrative/file`;
      const size = Buffer.byteLength(content || "", "utf8").toString();

      const existingDoc = rowsOf(await db.query(
        "SELECT id FROM documents WHERE folder_id = $1 AND name = $2 LIMIT 1",
        [folderRow.id, docName]
      ))[0];

      let documentId = existingDoc?.id;
      if (existingDoc?.id) {
        await db.query(
          `UPDATE documents
           SET file_url = $1,
               upload_id = $2,
               size = $3,
               status = ${db.isPostgres ? "$4::document_status" : "$4"},
               uploaded_by = $5,
               uploaded_at = datetime('now')
           WHERE id = $6`,
          [fileUrl, null, size, "under-review", resolvedUpdatedBy, existingDoc.id]
        );
      } else {
        const createdDoc = rowsOf(await db.query(
          `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ${db.isPostgres ? "$8::document_status" : "$8"}, $9)
           RETURNING *`,
          [request.company_id, folderRow.id, docName, fileUrl, null, size, "txt", "under-review", resolvedUpdatedBy]
        ));
        documentId = createdDoc[0]?.id;
      }

      if (documentId) {
        const link = rowsOf(await db.query(
          "SELECT id FROM request_documents WHERE request_id = $1 AND document_id = $2 LIMIT 1",
          [request.id, documentId]
        ))[0];
        if (!link) {
          await db.query(
            "INSERT INTO request_documents (request_id, document_id, visible) VALUES ($1, $2, true)",
            [request.id, documentId]
          );
        }
      }
    }
  }
  const updatedRequest = await getRequestById(req.params.id);
  res.json(updatedRequest || rows[0]);
});

const getNarrativeFile = asyncHandler(async (req, res) => {
  const current = await getRequestById(req.params.id);
  if (!current) return res.status(404).send("Not found");
  if (!canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const rows = rowsOf(await db.query(
    "SELECT content FROM request_narratives WHERE request_id = $1",
    [req.params.id]
  ));
  if (!rows[0]) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(rows[0].content || "");
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
