const db = require("../db");
const asyncHandler = require("../utils");
const { buildAppBaseUrl } = require("../utils/uploadStorage");

const REQUEST_CATEGORIES = ["Finance", "Legal", "Compliance", "HR", "Tax", "M&A", "Other"];
const RESPONSE_TYPES = ["Upload", "Narrative", "Both"];
const REQUEST_PRIORITIES = ["critical", "high", "medium", "low"];
const REQUEST_STATUSES = ["pending", "in-review", "completed", "blocked"];

function isValidDate(value) {
  if (!value || typeof value !== "string") return false;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime());
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

function normalizeRequestInput(input = {}, fallbackCreatedBy) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const subLabelValue = typeof input.sub_label === "string" ? input.sub_label.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const responseType = typeof input.response_type === "string" ? input.response_type.trim() : "";
  const priority = typeof input.priority === "string" ? input.priority.trim().toLowerCase() : "";
  const status = typeof input.status === "string" ? input.status.trim().toLowerCase() : "";
  const dueDate = typeof input.due_date === "string" ? input.due_date.trim() : "";
  const assignedTo = typeof input.assigned_to === "string" && input.assigned_to.trim()
    ? input.assigned_to.trim()
    : null;
  const createdBy = typeof input.created_by === "string" && input.created_by.trim()
    ? input.created_by.trim()
    : fallbackCreatedBy;

  const errors = [];

  if (!title) errors.push("title is required");
  if (!description) errors.push("description is required");
  if (!REQUEST_CATEGORIES.includes(category)) {
    errors.push(`category must be one of: ${REQUEST_CATEGORIES.join(", ")}`);
  }
  if (!RESPONSE_TYPES.includes(responseType)) {
    errors.push(`response_type must be one of: ${RESPONSE_TYPES.join(", ")}`);
  }
  if (!REQUEST_PRIORITIES.includes(priority)) {
    errors.push(`priority must be one of: ${REQUEST_PRIORITIES.join(", ")}`);
  }
  if (!REQUEST_STATUSES.includes(status)) {
    errors.push(`status must be one of: ${REQUEST_STATUSES.join(", ")}`);
  }
  if (!isValidDate(dueDate)) {
    errors.push("due_date must be in YYYY-MM-DD format");
  }
  if (!createdBy) errors.push("created_by is required");

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
    },
  };
}

async function insertRequest(companyId, payload) {
  const { rows } = await db.query(
    `INSERT INTO requests (company_id, title, sub_label, description, category, response_type, priority, status, due_date, assigned_to, visible, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, true), $12)
     RETURNING *`,
    [
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
    ]
  );

  return rows[0];
}

const listRequests = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM requests WHERE company_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

const createRequest = asyncHandler(async (req, res) => {
  const normalized = normalizeRequestInput(req.body || {}, req.user?.id);
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join("; ") });
  }

  const created = await insertRequest(req.params.id, normalized.value);
  res.status(201).json(created);
});

const createRequestsBulk = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body?.requests) ? req.body.requests : [];
  if (items.length === 0) {
    return res.status(400).json({ error: "requests array is required" });
  }

  const normalizedItems = items.map((item, index) => {
    const normalized = normalizeRequestInput(item, req.user?.id);
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
    created.push(request);
  }

  res.status(201).json({
    count: created.length,
    created,
  });
});

const getRequest = asyncHandler(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM requests WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const updateRequest = asyncHandler(async (req, res) => {
  const fields = [];
  const values = [];
  let idx = 1;
  const body = req.body || {};

  Object.keys(body).forEach((key) => {
    fields.push(`${key} = $${idx++}`);
    values.push(body[key]);
  });

  if (fields.length === 0) return res.status(400).json({ error: "No updates" });

  values.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE requests SET ${fields.join(", ")}, updated_at = datetime('now') WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const deleteRequest = asyncHandler(async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM requests WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

const addRequestReminder = asyncHandler(async (req, res) => {
  const { sent_by } = req.body || {};
  if (!sent_by) return res.status(400).json({ error: "sent_by required" });

  const { rows } = await db.query(
    "INSERT INTO request_reminders (request_id, sent_by) VALUES ($1, $2) RETURNING *",
    [req.params.id, sent_by]
  );
  res.status(201).json(rows[0]);
});

const listRequestDocuments = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT rd.*, d.name, d.file_url, d.status, d.upload_id
     FROM request_documents rd
     JOIN documents d ON d.id = rd.document_id
     WHERE rd.request_id = $1
     ORDER BY rd.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

const addRequestDocument = asyncHandler(async (req, res) => {
  const { document_id, visible } = req.body || {};
  if (!document_id) return res.status(400).json({ error: "document_id required" });

  const { rows } = await db.query(
    "INSERT INTO request_documents (request_id, document_id, visible) VALUES ($1, $2, COALESCE($3, true)) RETURNING *",
    [req.params.id, document_id, visible]
  );

  // Persist status change so it doesn't revert after refresh.
  await db.query(
    "UPDATE requests SET status = $1, updated_at = datetime('now') WHERE id = $2 AND status = 'pending'",
    ["in-review", req.params.id]
  );

  res.status(201).json(rows[0]);
});

const updateNarrative = asyncHandler(async (req, res) => {
  const { content, updated_by } = req.body || {};
  const resolvedUpdatedBy = updated_by || req.user?.id;
  if (!content || !resolvedUpdatedBy) {
    return res.status(400).json({ error: "content and updated_by required" });
  }

  const { rows } = await db.query(
    `INSERT INTO request_narratives (request_id, content, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (request_id) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = datetime('now')
     RETURNING *`,
    [req.params.id, content, resolvedUpdatedBy]
  );

  // Move request into review once a narrative response is saved.
  await db.query(
    "UPDATE requests SET status = $1, updated_at = datetime('now') WHERE id = $2 AND status != $1",
    ["in-review", req.params.id]
  );
  
  // Ensure a narrative text document is visible in the request's folder.
  const reqRows = await db.query(
    "SELECT id, title, category, sub_label, company_id FROM requests WHERE id = $1",
    [req.params.id]
  );
  const request = reqRows.rows?.[0];
  if (request?.company_id) {
    const folderName = request.category || request.sub_label || "Other";
    let folderRow = (await db.query(
      "SELECT id, name FROM folders WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1",
      [request.company_id, folderName]
    )).rows?.[0];

    if (!folderRow) {
      const createdFolder = await db.query(
        "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [request.company_id, null, folderName, null, resolvedUpdatedBy]
      );
      folderRow = createdFolder.rows?.[0];
    }

    if (folderRow?.id) {
      const docName = `request-${request.id}-narrative.txt`;
      const fileUrl = `${buildAppBaseUrl(req)}/requests/${request.id}/narrative/file`;
      const size = Buffer.byteLength(content || "", "utf8").toString();

      const existingDoc = (await db.query(
        "SELECT id FROM documents WHERE folder_id = $1 AND name = $2 LIMIT 1",
        [folderRow.id, docName]
      )).rows?.[0];

      let documentId = existingDoc?.id;
      if (existingDoc?.id) {
        await db.query(
          "UPDATE documents SET file_url = $1, upload_id = $2, size = $3, status = $4, uploaded_by = $5, uploaded_at = datetime('now') WHERE id = $6",
          [fileUrl, null, size, "under-review", resolvedUpdatedBy, existingDoc.id]
        );
      } else {
        const createdDoc = await db.query(
          `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [request.company_id, folderRow.id, docName, fileUrl, null, size, "txt", "under-review", resolvedUpdatedBy]
        );
        documentId = createdDoc.rows?.[0]?.id;
      }

      if (documentId) {
        const link = (await db.query(
          "SELECT id FROM request_documents WHERE request_id = $1 AND document_id = $2 LIMIT 1",
          [request.id, documentId]
        )).rows?.[0];
        if (!link) {
          await db.query(
            "INSERT INTO request_documents (request_id, document_id, visible) VALUES ($1, $2, true)",
            [request.id, documentId]
          );
        }
      }
    }
  }
  res.json(rows[0]);
});

const getNarrativeFile = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT content FROM request_narratives WHERE request_id = $1",
    [req.params.id]
  );
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
  deleteRequest,
  addRequestReminder,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrativeFile,
};
