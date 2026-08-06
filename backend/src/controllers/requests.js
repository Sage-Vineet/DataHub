const requestService = require("../services/requestService");
const permissionService = require("../services/permissionService");
const documentService = require("../services/documentService");
const { deliverRequestReminder } = require("../services/requestReminderDeliveryService");
const asyncHandler = require("../utils");
const {
  isRequestOverdue,
  isRequestResolved,
  resolveReminderFrequencyDays,
  resolveNextReminderAt,
} = require("../utils/requestReminders");

async function resolveAssigneeInputForCompany(companyId, body = {}) {
  const rawInput = requestService.hasAssigneeInput(body)
    ? requestService.extractAssigneeInput(body)
    : undefined;
  return requestService.resolveAssigneesForCompany(companyId, rawInput);
}

// Delivers a reminder email/notification the same way sendWelcomeEmail is used in
// controllers/users.js: awaited before the response so delivery is confirmed (or
// its failure logged) as part of the same request, instead of a background
// setImmediate whose outcome nobody observes. Never throws — a delivery failure
// must never fail the request/reminder operation that triggered it.
async function deliverReminderSafely(params, context) {
  try {
    const result = await deliverRequestReminder(params);
    console.log(
      `[Audit] [Reminder Email] ${context} requestId=${params.request?.id} trigger=${params.trigger} ` +
      `recipients=${result?.recipients ?? 0} emailsSent=${result?.emails ?? 0} notifications=${result?.notifications ?? 0}`
    );
    return result;
  } catch (deliveryErr) {
    console.error(`[${context}] Reminder delivery failed:`, deliveryErr.message);
    return { recipients: 0, emails: 0, notifications: 0, error: deliveryErr.message };
  }
}

const listRequests = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Access denied." });
  }

  const requests = await requestService.listRequestsByCompany(req.params.id);
  res.json(permissionService.filterRequestsForUser(req.user, requests));
});

const createRequest = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Access denied." });
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

  const assigneeResolution = await resolveAssigneeInputForCompany(req.params.id, req.body || {});
  const created = await requestService.createRequest(req.params.id, normalized.value, {
    assigneeIds: assigneeResolution.ids,
  });
  let initialReminderAt = null;
  if (normalized.value.approval_status === "approved") {
    initialReminderAt = new Date().toISOString();
    await requestService.createReminderEvent(created.id, req.user?.id || normalized.value.approved_by || normalized.value.created_by, initialReminderAt, {
      eventType: "sent",
      metadata: { trigger: "initial" },
    });
  }
  const createdRequest = await requestService.getRequestById(created.id);

  let reminderDelivery = { recipients: 0, emails: 0, notifications: 0 };
  if (normalized.value.approval_status === "approved") {
    reminderDelivery = await deliverReminderSafely({
      request: createdRequest,
      sentBy: req.user?.id || normalized.value.approved_by || normalized.value.created_by,
      sentAt: initialReminderAt || createdRequest?.created_at || new Date().toISOString(),
      trigger: "initial",
    }, "createRequest");
  }

  res.status(201).json({
    ...createdRequest,
    reminderEmailSent: reminderDelivery.emails > 0,
    reminderRecipientCount: reminderDelivery.recipients,
  });
});

const createRequestsBulk = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id) || !permissionService.isBroker(req.user)) {
    return res.status(403).json({ error: "Access denied." });
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

  // Not awaited before responding — a large CSV import can create many
  // requests, and awaiting every email here risks the HTTP request timing out.
  // Each item's delivery is isolated via deliverReminderSafely (which never
  // throws) so a single failed delivery can no longer break out of the loop
  // and silently skip reminders for every request after it in the batch.
  setImmediate(async () => {
    for (const requestId of result.ids || []) {
      const createdRequest = await requestService.getRequestById(requestId).catch(() => null);
      if (!createdRequest) continue;
      const history = await requestService.listReminderEventsForRequest(requestId).catch(() => []);
      const initialEvent = (history || []).find((event) => String(event.event_type || "sent").toLowerCase() === "sent");
      await deliverReminderSafely({
        request: createdRequest,
        sentBy: req.user.id,
        sentAt: initialEvent?.sent_at || createdRequest.created_at || new Date().toISOString(),
        trigger: "initial_bulk",
      }, "createRequestsBulk");
    }
  });
});

const getRequest = asyncHandler(async (req, res) => {
  const request = await requestService.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, request)) {
    return res.status(403).json({ error: "Access denied." });
  }
  res.json(request);
});

const updateRequest = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Access denied." });
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
      return res.status(403).json({ error: "Access denied." });
    }
  }

  const updates = { ...body, updated_at: new Date().toISOString() };
  delete updates.reminder_frequency_days;
  delete updates.company_id;
  const hasAssigneeUpdate = requestService.hasAssigneeInput(body);
  let assigneeResolution = null;
  if (hasAssigneeUpdate) {
    assigneeResolution = await resolveAssigneeInputForCompany(current.company_id, body);
    updates.assigned_to = assigneeResolution.ids[0] || null;
  }
  if (updates.priority !== undefined) {
    updates.reminder_frequency_days = resolveReminderFrequencyDays(updates.priority, null);
  }

  if (Object.keys(updates).length <= 1) return res.status(400).json({ error: "No updates" });

  await requestService.updateRequest(req.params.id, updates, {
    assigneeIds: assigneeResolution?.ids,
  });
  res.json(await requestService.getRequestById(req.params.id));
});

const approveRequest = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Access denied." });
  }

  // Optional: broker can route the request to all or selected client team members on approval.
  const hasAssigneeUpdate = requestService.hasAssigneeInput(req.body || {});
  const assigneeResolution = hasAssigneeUpdate
    ? await resolveAssigneeInputForCompany(current.company_id, req.body || {})
    : null;

  await requestService.approveRequest(req.params.id, req.user.id, assigneeResolution?.ids);
  const approvedRequest = await requestService.getRequestById(req.params.id);

  const reminderDelivery = await deliverReminderSafely({
    request: approvedRequest,
    sentBy: req.user.id,
    sentAt: approvedRequest?.approved_at || new Date().toISOString(),
    trigger: "approval",
  }, "approveRequest");

  res.json({
    ...approvedRequest,
    reminderEmailSent: reminderDelivery.emails > 0,
    reminderRecipientCount: reminderDelivery.recipients,
  });
});

const deleteRequest = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Access denied." });
  }

  await requestService.deleteRequest(req.params.id);
  res.status(204).send();
});

const addRequestReminder = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Access denied." });
  }
  if (isRequestResolved(current.status)) {
    return res.status(400).json({ error: "Resolved requests do not need reminders." });
  }

  const sentBy = req.body?.sent_by || req.user?.id;
  const sentAt = req.body?.sent_at || new Date().toISOString();
  if (!sentBy) return res.status(400).json({ error: "sent_by required" });

  const reminder = await requestService.createReminderEvent(req.params.id, sentBy, sentAt, {
    eventType: "sent",
    metadata: { trigger: "manual" },
  });

  const reminderDelivery = await deliverReminderSafely({
    request: current,
    sentBy,
    sentAt,
    trigger: "manual",
  }, "addRequestReminder");

  res.status(201).json({
    ...reminder,
    reminderEmailSent: reminderDelivery.emails > 0,
    reminderRecipientCount: reminderDelivery.recipients,
  });
});

const skipNextRequestReminder = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.isBroker(req.user) || !permissionService.canAccessCompany(req.user, current.company_id)) {
    return res.status(403).json({ error: "Access denied." });
  }
  if (isRequestResolved(current.status)) {
    return res.status(400).json({ error: "Resolved requests do not need reminder changes." });
  }
  if (isRequestOverdue(current)) {
    return res.status(400).json({ error: "Overdue requests no longer have upcoming reminders." });
  }

  const history = await requestService.listReminderEventsForRequest(req.params.id);
  const lastCadenceEvent = (history || []).find((event) => {
    const eventType = String(event.event_type || "sent").toLowerCase();
    return eventType === "sent" || eventType === "skipped";
  });
  const baseTime = lastCadenceEvent
    ? lastCadenceEvent.scheduled_for || lastCadenceEvent.sent_at
    : current.approved_at || current.created_at || new Date().toISOString();
  const scheduledFor = resolveNextReminderAt(
    baseTime,
    current.priority,
    current.reminder_frequency_days,
    current.due_date,
  );

  if (!scheduledFor) {
    return res.status(400).json({ error: "No upcoming reminder is available to skip." });
  }

  const skipped = await requestService.createReminderEvent(req.params.id, req.user.id, new Date().toISOString(), {
    eventType: "skipped",
    deliveryChannel: "in_app",
    scheduledFor,
    metadata: { trigger: "manual_skip" },
  });

  res.status(201).json(skipped);
});

const listRequestDocuments = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Access denied." });
  }

  const documents = await requestService.listRequestDocuments(req.params.id);
  res.json(documents);
});

const addRequestDocument = asyncHandler(async (req, res) => {
  const current = await requestService.getRequestById(req.params.id);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Access denied." });
  }
  if (current.status === "completed") {
    return res.status(403).json({ error: "Completed requests cannot be edited." });
  }

  const { document_id, visible } = req.body || {};
  if (!document_id) return res.status(400).json({ error: "document_id required" });

  const document = await documentService.getDocumentById(document_id);
  if (!document) return res.status(404).json({ error: "Document not found" });
  if (String(document.company_id) !== String(current.company_id)) {
    return res.status(403).json({ error: "Document is not available for this request" });
  }

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
    return res.status(403).json({ error: "Access denied." });
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
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessRequest(req.user, current)) {
    return res.status(403).json({ error: "Access denied." });
  }

  const data = await requestService.getNarrative(req.params.id);
  // Return JSON so the frontend request() helper can parse it correctly.
  // Includes author metadata so the UI can show who wrote the narrative.
  res.json({
    content:     data?.content     || "",
    author_name: data?.author_name || null,
    author_role: data?.author_role || null,
    updated_at:  data?.updated_at  || null,
  });
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
  skipNextRequestReminder,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrativeFile,
};
