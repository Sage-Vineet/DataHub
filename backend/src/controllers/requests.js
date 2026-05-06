const requestService = require("../services/requestService");
const permissionService = require("../services/permissionService");
const folderService = require("../services/folderService");
const documentService = require("../services/documentService");
const asyncHandler = require("../utils");
const { buildAppBaseUrl } = require("../utils/uploadStorage");
const { isRequestResolved } = require("../utils/requestReminders");

const listRequests = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const requests = await requestService.listRequestsByCompany(req.params.id);
  res.json(permissionService.filterRequestsForUser(req.user, requests));
});

const createRequest = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const submissionSource = req.user?.effective_role === "user"
    ? "user"
    : req.user?.effective_role === "client"
    ? "client"
    : "broker";
  const approvalStatus = submissionSource === "user" ? "pending" : "approved";

  const normalized = requestService.validateAndNormalizeRequest(req.body || {}, req.user?.id, {
    submissionSource,
    approvalStatus,
    approvedBy: approvalStatus === "approved" ? req.user?.id : null,
    forceStatus: "pending",
  });

  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join("; ") });
  }

  const created = await requestService.createRequest(req.params.id, normalized.value);
  if (normalized.value.approval_status === "approved") {
    await requestService.createReminderEvent(created.id, req.user?.id || normalized.value.approved_by || normalized.value.created_by);
  }
  res.status(201).json(await requestService.getRequestById(created.id));
});

const createRequestsBulk = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id) || !permissionService.isBroker(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const items = Array.isArray(req.body?.requests) ? req.body.requests : [];
  if (items.length === 0) {
    return res.status(400).json({ error: "requests array is required" });
  }

  const result = await requestService.createRequestsBulk(req.params.id, items, req.user.id);
  if (result.validationErrors) {
    const summary = result.validationErrors.map(v => `Row ${v.row}: ${v.errors.join(", ")}`).join("; ");
    return res.status(400).json({ error: `Validation failed: ${summary}` });
  }

  res.status(201).json({ message: `Successfully created ${result.count} requests` });
});

const getRequest = asyncHandler(async (req, res) => {
  const request = await requestService.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, request)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(request);
});

const updateRequest = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (current.status === "completed") {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const body = req.body || {};

  if (!permissionService.isBroker(req.user)) {
    const role = req.user?.effective_role;

    if (role === "user") {
      if (current.status !== "pending") {
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

  await requestService.updateRequest(req.params.id, updates);
  res.json(await requestService.getRequestById(req.params.id));
});

const approveRequest = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await requestService.approveRequest(req.params.id, req.user.id);
  res.json(await requestService.getRequestById(req.params.id));
});

const deleteRequest = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await requestService.deleteRequest(req.params.id);
  res.status(204).send();
});

const addRequestReminder = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (isRequestResolved(current.status)) {
    return res.status(400).json({ error: "Resolved requests do not need reminders." });
  }

  const sentBy = req.body?.sent_by || req.user?.id;
  const sentAt = req.body?.sent_at || new Date().toISOString();
  if (!sentBy) return res.status(400).json({ error: "sent_by required" });

  const reminder = await requestService.createReminderEvent(req.params.id, sentBy, sentAt);
  res.status(201).json(reminder);
});

const listRequestDocuments = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const documents = await requestService.listRequestDocuments(req.params.id);
  res.json(documents);
});

const addRequestDocument = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (current.status === "completed") {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const { document_id, visible } = req.body || {};
  if (!document_id) return res.status(400).json({ error: "document_id required" });

  const link = await requestService.addRequestDocument(req.params.id, document_id, visible);

  if (current.status === "pending") {
    await requestService.updateRequest(req.params.id, { status: "in-review", updated_at: new Date().toISOString() });
  }

  const updatedRequest = await requestService.getRequestById(req.params.id);
  res.status(201).json(updatedRequest || link);
});

const updateNarrative = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (current.status === "completed") {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const { content, updated_by } = req.body || {};
  const resolvedUpdatedBy = updated_by || req.user?.id;
  if (!content || !resolvedUpdatedBy) {
    return res.status(400).json({ error: "content and updated_by required" });
  }

  const data = await requestService.updateNarrative(req.params.id, content, resolvedUpdatedBy);

  // Update request status if needed
  if (current.status === "pending") {
    await requestService.updateRequest(req.params.id, {
      status: "in-review",
      updated_at: new Date().toISOString()
    });
  }

  const updatedRequest = await requestService.getRequestById(req.params.id);
  res.json(updatedRequest || data);
});

const getNarrativeFile = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).send("Not found");
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const data = await requestService.getNarrative(req.params.id);
  if (!data) return res.status(404).send("Not found");
  
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

