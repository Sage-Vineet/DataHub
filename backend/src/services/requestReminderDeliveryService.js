"use strict";

const userService = require("./userService");
const companyService = require("./companyService");
const permissionService = require("./permissionService");
const { sendReminderEmail } = require("./emailService");
const { createUserNotification } = require("./notificationService");
const {
  buildReminderFrequencyLabel,
  resolveNextReminderAt,
  resolveScheduledReminderAt,
} = require("../utils/requestReminders");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function uniqueRecipients(recipients) {
  const seen = new Set();
  return (recipients || []).filter((recipient) => {
    const key = recipient.id ? `id:${recipient.id}` : `email:${normalizeEmail(recipient.email)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return recipient.id || recipient.email;
  });
}

async function resolveReminderRecipients(request, company = null) {
  if (!request) return [];

  let recipients = [];
  const assigneeIds = permissionService.getRequestAssigneeIds(request);
  if (assigneeIds.length) {
    const preloaded = new Map((request.assignees || [])
      .filter((assignee) => assignee?.id)
      .map((assignee) => [String(assignee.id), assignee]));
    const assignedUsers = await Promise.all(assigneeIds.map(async (id) => (
      preloaded.get(String(id)) || userService.getUserById(id).catch(() => null)
    )));
    recipients = assignedUsers
      .filter(Boolean)
      .map((assignedUser) => ({
        id: assignedUser.id,
        name: assignedUser.name,
        email: assignedUser.email,
      }));
  } else {
    recipients = await userService.getClientTeamMembersForCompany(request.company_id);
  }

  if (!recipients.length && company?.contact_email) {
    recipients = [{
      id: null,
      name: company.contact_name || null,
      email: company.contact_email,
    }];
  }

  return uniqueRecipients(recipients);
}

function buildPortalUrl(portalUrl = null) {
  return (
    portalUrl ||
    process.env.FRONTEND_URL ||
    process.env.APP_BASE_URL ||
    ""
  ).replace(/\/$/, "");
}

function formatDueDate(dueDate) {
  if (!dueDate) return "No due date";
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return String(dueDate);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

async function deliverRequestReminder({
  request,
  sentBy,
  sentAt = new Date().toISOString(),
  noticeType = "reminder",
  trigger = "manual",
  portalUrl = null,
  nextReminderAt = null,
} = {}) {
  if (!request) return { recipients: 0, emails: 0, notifications: 0 };

  const [company, sender] = await Promise.all([
    companyService.getCompanyById(request.company_id).catch(() => null),
    sentBy ? userService.getUserById(sentBy).catch(() => null) : Promise.resolve(null),
  ]);
  const recipients = await resolveReminderRecipients(request, company);
  if (!recipients.length) return { recipients: 0, emails: 0, notifications: 0 };

  const isOverdue = noticeType === "overdue";
  const frequencyLabel = buildReminderFrequencyLabel(request.priority, request.reminder_frequency_days);
  // Overdue notices now repeat on the same cadence as pre-due-date reminders (see
  // requestReminderAutomationService), so this keeps computing a "next reminder"
  // time for them too instead of hardcoding null / implying they're a one-off.
  const resolvedNextReminderAt = isOverdue
    ? nextReminderAt || resolveScheduledReminderAt(sentAt, request.priority, request.reminder_frequency_days)
    : nextReminderAt || resolveNextReminderAt(sentAt, request.priority, request.reminder_frequency_days, request.due_date);
  const appUrl = buildPortalUrl(portalUrl);
  const title = isOverdue
    ? `Overdue request: ${request.title || "Document Request"}`
    : `Reminder: ${request.title || "Document Request"}`;
  const message = isOverdue
    ? `This request was due ${formatDueDate(request.due_date)} and is now overdue.`
    : `This ${request.priority || "medium"} priority request is due ${formatDueDate(request.due_date)}.`;

  let emailCount = 0;
  let notificationCount = 0;
  for (const recipient of recipients) {
    if (recipient.email) {
      const result = await sendReminderEmail({
        toName: recipient.name || null,
        toEmail: recipient.email,
        requestTitle: request.title,
        dueDate: request.due_date || null,
        senderName: sender?.name || null,
        companyName: company?.name || request.company_name || null,
        requestType: request.category || request.response_type || null,
        description: request.description || null,
        priority: request.priority || null,
        status: isOverdue ? "overdue" : request.status || null,
        reminderAt: sentAt,
        portalUrl: appUrl || null,
        frequencyLabel,
        nextReminderAt: resolvedNextReminderAt,
        noticeType,
      });
      if (result?.sent !== false) emailCount += 1;
    }

    if (recipient.id) {
      const result = await createUserNotification({
        userId: recipient.id,
        type: isOverdue ? "request_overdue" : "request_reminder",
        title,
        message,
        createdBy: sentBy || request.created_by || null,
        metadata: {
          request_id: request.id,
          company_id: request.company_id,
          priority: request.priority || null,
          due_date: request.due_date || null,
          notice_type: noticeType,
          trigger,
          reminder_at: sentAt,
          next_reminder_at: resolvedNextReminderAt,
        },
      });
      if (result.created) notificationCount += 1;
    }
  }

  return {
    recipients: recipients.length,
    emails: emailCount,
    notifications: notificationCount,
  };
}

module.exports = {
  deliverRequestReminder,
  resolveReminderRecipients,
};
