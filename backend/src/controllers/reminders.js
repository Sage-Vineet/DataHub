const { supabase } = require("../db");
const asyncHandler = require("../utils");
const permissionService = require("../services/permissionService");
const requestService = require("../services/requestService");
const {
  buildReminderFrequencyLabel,
  resolveReminderFrequencyDays,
  resolveReminderFrequencyHours,
  getReminderDeadline,
  resolveNextReminderAt,
  isRequestOverdue,
  isRequestResolved,
} = require("../utils/requestReminders");

function canAccessReminder(user, request) {
  return permissionService.canAccessRequest(user, request);
}

function reminderEventType(event) {
  return String(event?.event_type || "sent").trim().toLowerCase() || "sent";
}

function getReminderBaseTime(event) {
  if (!event) return null;
  return event.scheduled_for || event.sent_at;
}

function buildReminderStatus(request, nextReminderAt) {
  if (isRequestResolved(request.status)) return "resolved";
  if (isRequestOverdue(request)) return "overdue";
  if (String(request.status || "").toLowerCase() === "blocked") return "blocked";
  if (nextReminderAt && new Date(nextReminderAt) <= new Date()) return "due";
  return "active";
}

const listReminders = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's reminders." });
  }

  const { data: requests, error: requestsError } = await supabase
    .from("requests")
    .select(`
      *,
      company:companies(name, contact_name, contact_email, contact_phone)
    `)
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: false });

  if (requestsError) return res.status(500).json({ error: requestsError.message });

  const enrichedRequests = await requestService.attachRequestAssignees((requests || [])
    .map(r => ({
      ...r,
      company_name: r.company?.name,
      company_contact_name: r.company?.contact_name,
      company_contact_email: r.company?.contact_email,
      company_contact_phone: r.company?.contact_phone
    })));

  const filteredRequests = (enrichedRequests || [])
    .filter((request) => canAccessReminder(req.user, request));

  if (!filteredRequests.length) {
    return res.json([]);
  }

  const requestIds = filteredRequests.map((request) => request.id);
  const { data: history, error: historyError } = await supabase
    .from("request_reminders")
    .select(`
      *,
      user:users!request_reminders_sent_by_fkey(name, email)
    `)
    .in("request_id", requestIds)
    .order("sent_at", { ascending: false });

  if (historyError) return res.status(500).json({ error: historyError.message });

  const historyMapped = (history || []).map(h => ({
    ...h,
    event_type: reminderEventType(h),
    sent_by_name: h.user?.name,
    sent_by_email: h.user?.email
  }));

  const reminderHistoryByRequestId = historyMapped.reduce((acc, item) => {
    if (!acc[item.request_id]) acc[item.request_id] = [];
    acc[item.request_id].push(item);
    return acc;
  }, {});

  const reminders = filteredRequests.map((request) => {
    const reminderHistory = reminderHistoryByRequestId[request.id] || [];
    const sentHistory = reminderHistory.filter((item) => reminderEventType(item) === "sent");
    const cadenceHistory = reminderHistory.filter((item) => {
      const eventType = reminderEventType(item);
      return eventType === "sent" || eventType === "skipped";
    });
    const overdueNotice = reminderHistory.find((item) => reminderEventType(item) === "overdue") || null;
    const lastReminder = sentHistory[0] || null;
    const firstReminder = sentHistory[sentHistory.length - 1] || null;
    const lastCadenceEvent = cadenceHistory[0] || null;
    const frequencyDays = resolveReminderFrequencyDays(request.priority, request.reminder_frequency_days);
    const frequencyHours = resolveReminderFrequencyHours(request.priority, request.reminder_frequency_days);
    const reminderFrequencyLabel = buildReminderFrequencyLabel(request.priority, request.reminder_frequency_days);
    const reminderBaseTime = getReminderBaseTime(lastCadenceEvent) || request.approved_at || request.created_at || new Date().toISOString();
    const nextReminderAt = resolveNextReminderAt(
      reminderBaseTime,
      request.priority,
      request.reminder_frequency_days,
      request.due_date,
    );
    const status = buildReminderStatus(request, nextReminderAt);
    const visibleNextReminderAt = ["resolved", "overdue", "blocked"].includes(status) ? null : nextReminderAt;
    const sentCount = sentHistory.length;
    const automaticUntil = getReminderDeadline(request.due_date);

    return {
      id: `request-reminder-${request.id}`,
      request_id: request.id,
      company_id: request.company_id,
      company_name: request.company_name,
      title: request.title,
      message: request.description || null,
      due_date: request.due_date,
      priority: request.priority,
      frequency_days: frequencyDays,
      frequency_hours: frequencyHours,
      frequency_label: reminderFrequencyLabel,
      sent_count: sentCount,
      first_sent_at: firstReminder?.sent_at || null,
      last_sent_at: lastReminder?.sent_at || null,
      next_due_at: visibleNextReminderAt,
      next_reminder_at: visibleNextReminderAt,
      automatic_until: automaticUntil,
      overdue_notice_sent_at: overdueNotice?.sent_at || null,
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
    const priorityOrder = { due: 0, overdue: 1, active: 2, blocked: 3, resolved: 4 };
    const statusDiff = (priorityOrder[a.status] ?? 9) - (priorityOrder[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    return String(a.next_reminder_at || a.next_due_at || a.last_sent_at || "").localeCompare(String(b.next_reminder_at || b.next_due_at || b.last_sent_at || ""));
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
