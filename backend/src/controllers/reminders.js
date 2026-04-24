const db = require("../db");
const asyncHandler = require("../utils");
const {
  buildReminderFrequencyLabel,
  resolveReminderFrequencyDays,
  getReminderDeadline,
  resolveNextReminderAt,
  isRequestResolved,
} = require("../utils/requestReminders");

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
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

function canAccessReminder(user, request) {
  if (!user || !request) return false;
  if (!canAccessCompany(user, request.company_id)) return false;
  if (isBroker(user)) return true;
  if (user?.effective_role === "client") {
    return request.approval_status === "approved" && request.visible !== false && request.visible !== 0;
  }
  return request.approval_status === "approved" || String(request.created_by) === String(user?.id);
}

function buildReminderMessage(request, reminderFrequencyLabel, nextReminderAt) {
  const dueDate = request.due_date ? String(request.due_date).slice(0, 10) : "Not set";
  const followUpText = nextReminderAt
    ? `Next automatic reminder: ${String(nextReminderAt).slice(0, 10)}.`
    : "Automatic reminders stop at the due date; send manually from the broker portal if needed.";
  return `The first reminder was sent when this request was generated. Follow-ups run ${reminderFrequencyLabel.toLowerCase()} until ${dueDate}. ${followUpText}`;
}

function buildReminderStatus(request, nextReminderAt) {
  if (isRequestResolved(request.status)) return "resolved";
  if (String(request.status || "").toLowerCase() === "blocked") return "blocked";
  if (nextReminderAt && new Date(nextReminderAt) <= new Date()) return "due";
  const reminderDeadline = getReminderDeadline(request.due_date);
  if (!nextReminderAt && reminderDeadline && new Date(reminderDeadline) < new Date()) return "due";
  return "active";
}

const listReminders = asyncHandler(async (req, res) => {
  if (!canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const requests = rowsOf(await db.query(
    `SELECT
       r.*,
       c.name AS company_name,
       c.contact_name AS company_contact_name,
       c.contact_email AS company_contact_email,
       c.contact_phone AS company_contact_phone
     FROM requests r
     JOIN companies c ON c.id = r.company_id
     WHERE r.company_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.id],
  )).filter((request) => canAccessReminder(req.user, request));

  if (!requests.length) {
    return res.json([]);
  }

  const requestIds = requests.map((request) => request.id);
  const placeholders = requestIds.map((_, index) => `$${index + 1}`).join(", ");
  const history = rowsOf(await db.query(
    `SELECT rr.request_id, rr.sent_by, rr.sent_at, u.name AS sent_by_name, u.email AS sent_by_email
     FROM request_reminders rr
     LEFT JOIN users u ON u.id = rr.sent_by
     WHERE rr.request_id IN (${placeholders})
     ORDER BY rr.sent_at DESC`,
    requestIds,
  ));

  const reminderHistoryByRequestId = history.reduce((acc, item) => {
    if (!acc[item.request_id]) acc[item.request_id] = [];
    acc[item.request_id].push(item);
    return acc;
  }, {});

  const reminders = requests.map((request) => {
    const reminderHistory = reminderHistoryByRequestId[request.id] || [];
    const lastReminder = reminderHistory[0] || null;
    const firstReminder = reminderHistory[reminderHistory.length - 1] || null;
    const frequencyDays = resolveReminderFrequencyDays(request.priority, request.reminder_frequency_days);
    const reminderFrequencyLabel = buildReminderFrequencyLabel(request.priority, request.reminder_frequency_days);
    const reminderBaseTime = lastReminder?.sent_at || request.approved_at || request.created_at || new Date().toISOString();
    const nextReminderAt = resolveNextReminderAt(
      reminderBaseTime,
      request.priority,
      request.reminder_frequency_days,
      request.due_date,
    );
    const status = buildReminderStatus(request, nextReminderAt);
    const sentCount = reminderHistory.length;
    const automaticUntil = getReminderDeadline(request.due_date);

    return {
      id: `request-reminder-${request.id}`,
      request_id: request.id,
      company_id: request.company_id,
      company_name: request.company_name,
      title: request.title,
      message: buildReminderMessage(request, reminderFrequencyLabel, nextReminderAt),
      due_date: request.due_date,
      priority: request.priority,
      frequency_days: frequencyDays,
      frequency_label: reminderFrequencyLabel,
      sent_count: sentCount,
      first_sent_at: firstReminder?.sent_at || request.approved_at || request.created_at || null,
      last_sent_at: lastReminder?.sent_at || request.approved_at || request.created_at || null,
      next_due_at: nextReminderAt,
      automatic_until: automaticUntil,
      status,
      workflow_status: request.status,
      submission_source: request.submission_source,
      approval_status: request.approval_status,
      visible: request.visible !== false && request.visible !== 0,
      created_at: request.created_at,
      company_contact_name: request.company_contact_name,
      company_contact_email: request.company_contact_email,
      company_contact_phone: request.company_contact_phone,
      history: reminderHistory,
    };
  });

  reminders.sort((a, b) => {
    const priorityOrder = { due: 0, active: 1, blocked: 2, resolved: 3 };
    const statusDiff = (priorityOrder[a.status] ?? 9) - (priorityOrder[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    return String(a.next_due_at || "").localeCompare(String(b.next_due_at || ""));
  });

  res.json(reminders);
});

const createReminder = asyncHandler(async (_req, res) => {
  res.status(405).json({ error: "Manual reminder creation is not supported. Reminders are generated from requests." });
});

const updateReminder = asyncHandler(async (_req, res) => {
  res.status(405).json({ error: "Reminder updates are not supported. Update the linked request instead." });
});

const deleteReminder = asyncHandler(async (_req, res) => {
  res.status(405).json({ error: "Reminder deletion is not supported. Resolve the linked request instead." });
});

module.exports = { listReminders, createReminder, updateReminder, deleteReminder };
