const DEFAULT_REMINDER_FREQUENCIES = {
  critical: 1,
  high: 1,
  medium: 2,
  low: 7,
};

function normalizePriorityValue(priority) {
  return String(priority || "").trim();
}

function resolveReminderFrequencyDays(priority, explicitDays) {
  const parsedExplicit = Number.parseInt(explicitDays, 10);
  const normalizedPriority = normalizePriorityValue(priority).toLowerCase();
  const priorityFrequency = DEFAULT_REMINDER_FREQUENCIES[normalizedPriority] || 7;

  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) {
    const isLegacySchemaDefault = parsedExplicit === 2 && normalizedPriority !== "medium";
    return isLegacySchemaDefault ? priorityFrequency : parsedExplicit;
  }

  return priorityFrequency;
}

function buildReminderFrequencyLabel(priority, explicitDays) {
  const normalizedPriority = normalizePriorityValue(priority).toLowerCase();
  const days = resolveReminderFrequencyDays(priority, explicitDays);

  if (
    normalizedPriority
    && Object.prototype.hasOwnProperty.call(DEFAULT_REMINDER_FREQUENCIES, normalizedPriority)
    && DEFAULT_REMINDER_FREQUENCIES[normalizedPriority] === days
  ) {
    if (days === 1) return "Daily";
    if (days === 2) return "Every 2 days";
    if (days === 7) return "Weekly";
  }

  return days === 1 ? "Daily" : `Every ${days} days`;
}

function addDays(dateLike, days) {
  const date = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function getReminderDeadline(dueDate) {
  if (!dueDate) return null;
  const date = new Date(`${String(dueDate).slice(0, 10)}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function resolveNextReminderAt(baseTime, priority, explicitDays, dueDate) {
  const nextReminderAt = resolveScheduledReminderAt(baseTime, priority, explicitDays);
  if (!nextReminderAt) return null;

  const deadline = getReminderDeadline(dueDate);
  if (deadline && new Date(nextReminderAt) > new Date(deadline)) {
    return null;
  }

  return nextReminderAt;
}

function resolveScheduledReminderAt(baseTime, priority, explicitDays) {
  const frequencyDays = resolveReminderFrequencyDays(priority, explicitDays);
  return addDays(baseTime, frequencyDays);
}

function isRequestResolved(status) {
  return ["completed", "rejected"].includes(String(status || "").trim().toLowerCase());
}

module.exports = {
  DEFAULT_REMINDER_FREQUENCIES,
  normalizePriorityValue,
  resolveReminderFrequencyDays,
  buildReminderFrequencyLabel,
  addDays,
  getReminderDeadline,
  resolveNextReminderAt,
  resolveScheduledReminderAt,
  isRequestResolved,
};
