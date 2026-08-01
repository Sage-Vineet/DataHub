const DEFAULT_REMINDER_FREQUENCY_HOURS = {
  critical: 1,
  high: 24,
  medium: 48,
  low: 72,
};

const LEGACY_REMINDER_FREQUENCY_DAYS = {
  critical: 1,
  high: 1,
  medium: 2,
  low: 7,
};

const DEFAULT_REMINDER_FREQUENCIES = {
  critical: 1,
  high: 1,
  medium: 2,
  low: 3,
};

function normalizePriorityValue(priority) {
  return String(priority || "").trim();
}

function resolveReminderFrequencyDays(priority, explicitDays) {
  const hours = resolveReminderFrequencyHours(priority, explicitDays);
  return Math.max(1, Math.ceil(hours / 24));
}

function resolveReminderFrequencyHours(priority, explicitDays) {
  const parsedExplicit = Number.parseInt(explicitDays, 10);
  const normalizedPriority = normalizePriorityValue(priority).toLowerCase();
  const priorityFrequency = DEFAULT_REMINDER_FREQUENCY_HOURS[normalizedPriority] || DEFAULT_REMINDER_FREQUENCY_HOURS.low;

  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) {
    const isLegacySchemaDefault = parsedExplicit === 2 && normalizedPriority !== "medium";
    const isLegacyPriorityDefault = LEGACY_REMINDER_FREQUENCY_DAYS[normalizedPriority] === parsedExplicit;
    return isLegacySchemaDefault || isLegacyPriorityDefault ? priorityFrequency : parsedExplicit * 24;
  }

  return priorityFrequency;
}

function buildReminderFrequencyLabel(priority, explicitDays) {
  const normalizedPriority = normalizePriorityValue(priority).toLowerCase();
  const hours = resolveReminderFrequencyHours(priority, explicitDays);

  if (
    normalizedPriority
    && Object.prototype.hasOwnProperty.call(DEFAULT_REMINDER_FREQUENCY_HOURS, normalizedPriority)
    && DEFAULT_REMINDER_FREQUENCY_HOURS[normalizedPriority] === hours
  ) {
    if (hours === 1) return "Every hour";
    if (hours === 24) return "Every 24 hours";
    return `Every ${hours} hours`;
  }

  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "Every 24 hours" : `Every ${hours} hours`;
  }
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

function addDays(dateLike, days) {
  const date = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function addHours(dateLike, hours) {
  const date = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const next = new Date(date);
  next.setTime(next.getTime() + Number(hours) * 60 * 60 * 1000);
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
  const frequencyHours = resolveReminderFrequencyHours(priority, explicitDays);
  return addHours(baseTime, frequencyHours);
}

function isRequestResolved(status) {
  return ["completed", "rejected"].includes(String(status || "").trim().toLowerCase());
}

function isRequestOverdue(request, now = new Date()) {
  if (!request || isRequestResolved(request.status)) return false;
  const deadline = getReminderDeadline(request.due_date);
  if (!deadline) return false;
  return new Date(deadline) < new Date(now);
}

module.exports = {
  DEFAULT_REMINDER_FREQUENCIES,
  DEFAULT_REMINDER_FREQUENCY_HOURS,
  normalizePriorityValue,
  resolveReminderFrequencyDays,
  resolveReminderFrequencyHours,
  buildReminderFrequencyLabel,
  addDays,
  addHours,
  getReminderDeadline,
  resolveNextReminderAt,
  resolveScheduledReminderAt,
  isRequestResolved,
  isRequestOverdue,
};
