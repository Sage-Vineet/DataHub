import { z } from "zod";

export const requestCategory = z.enum(["Finance", "Legal", "Compliance", "HR", "Tax", "M&A", "Other"]);
export const responseType = z.enum(["Upload", "Narrative", "Both"]);
export const requestPriority = z.enum(["critical", "high", "medium", "low"]);
export const requestStatus = z.enum(["pending", "in-review", "completed", "blocked"]);
export const approvalStatus = z.enum(["pending", "approved"]);
export const submissionSource = z.enum(["broker", "user", "client"]);
export type RequestPriority = z.infer<typeof requestPriority>;

/** Priority → default reminder frequency in days (parity with `requestReminders.js`). */
const REMINDER_DAYS: Record<RequestPriority, number> = { critical: 1, high: 1, medium: 2, low: 7 };

/**
 * Resolve reminder frequency from priority, honoring a positive explicit override
 * (but treating the legacy schema default of 2 for a non-medium priority as "unset").
 */
export function resolveReminderFrequencyDays(priority: RequestPriority, explicitDays?: number | null): number {
  const priorityFreq = REMINDER_DAYS[priority] ?? 7;
  const n = typeof explicitDays === "number" ? Math.trunc(explicitDays) : Number.NaN;
  if (Number.isFinite(n) && n > 0) {
    const isLegacyDefault = n === 2 && priority !== "medium";
    return isLegacyDefault ? priorityFreq : n;
  }
  return priorityFreq;
}

/**
 * How a reminder cadence reads to a person.
 *
 * Only the priority defaults get a friendly name; an explicit override says the
 * number, because "Weekly" would hide that someone chose 7 deliberately.
 */
export function buildReminderFrequencyLabel(
  priority: RequestPriority,
  explicitDays?: number | null,
): string {
  const days = resolveReminderFrequencyDays(priority, explicitDays);
  if (REMINDER_DAYS[priority] === days) {
    if (days === 1) return "Daily";
    if (days === 2) return "Every 2 days";
    if (days === 7) return "Weekly";
  }
  return days === 1 ? "Daily" : `Every ${days} days`;
}

/** `base` plus N days, in UTC. Null when the base is unparseable. */
export function addDays(base: string | Date | null | undefined, days: number): string | null {
  const date = base ? new Date(base) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

/** End of the due day — chasing past the deadline is not a reminder, it is noise. */
export function getReminderDeadline(due?: string | null): string | null {
  if (!due) return null;
  const date = new Date(`${String(due).slice(0, 10)}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** When the next chase falls due, ignoring the deadline. */
export function resolveScheduledReminderAt(
  base: string | Date | null | undefined,
  priority: RequestPriority,
  explicitDays?: number | null,
): string | null {
  return addDays(base, resolveReminderFrequencyDays(priority, explicitDays));
}

/**
 * The next chase, or null if it would land after the request was due.
 *
 * A schedule that keeps firing past the deadline tells a broker nothing they do
 * not already know — the request is overdue, which the request itself says.
 */
export function resolveNextReminderAt(
  base: string | Date | null | undefined,
  priority: RequestPriority,
  explicitDays: number | null | undefined,
  due: string | null | undefined,
): string | null {
  const next = resolveScheduledReminderAt(base, priority, explicitDays);
  if (!next) return null;
  const deadline = getReminderDeadline(due);
  if (deadline && new Date(next) > new Date(deadline)) return null;
  return next;
}

/** A request nobody needs chasing about any more. */
export function isRequestResolved(status?: string | null): boolean {
  return ["completed", "rejected"].includes(String(status ?? "").trim().toLowerCase());
}

const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be in YYYY-MM-DD format");
const uuid = z.string().uuid();

export const requestCreate = z.object({
  title: z.string().trim().min(1, "title is required"),
  sub_label: z.string().trim().optional(),
  description: z.string().trim().min(1, "description is required"),
  category: requestCategory,
  response_type: responseType,
  priority: requestPriority,
  status: requestStatus.optional(),
  due_date: dueDate,
  assigned_to: uuid.optional(),
  visible: z.boolean().optional(),
  reminder_frequency_days: z.number().int().positive().optional(),
  submission_source: submissionSource.optional(),
});
export type RequestCreate = z.infer<typeof requestCreate>;

export const requestUpdate = requestCreate.partial();
export type RequestUpdate = z.infer<typeof requestUpdate>;

export const requestBulkCreate = z.object({
  items: z.array(requestCreate).min(1, "at least one request is required"),
  allow_past: z.boolean().optional(),
});
export type RequestBulkCreate = z.infer<typeof requestBulkCreate>;

export const requestApprove = z.object({ assigned_to: uuid.optional() });
export type RequestApprove = z.infer<typeof requestApprove>;

export const narrativeUpdate = z.object({ content: z.string().min(1, "content is required") });
export type NarrativeUpdate = z.infer<typeof narrativeUpdate>;

export const requestDocumentLink = z.object({
  document_id: uuid,
  visible: z.boolean().optional(),
});
export type RequestDocumentLink = z.infer<typeof requestDocumentLink>;

export const requestListQuery = z.object({});
export type RequestListQuery = z.infer<typeof requestListQuery>;

export const requestResponse = z.object({
  id: uuid,
  company_id: uuid,
  title: z.string(),
  sub_label: z.string().nullable(),
  description: z.string(),
  category: requestCategory,
  response_type: responseType,
  priority: requestPriority,
  status: requestStatus,
  due_date: z.string(),
  assigned_to: uuid.nullable(),
  visible: z.boolean(),
  reminder_frequency_days: z.number().int(),
  submission_source: submissionSource,
  approval_status: approvalStatus,
  approved_by: uuid.nullable(),
  created_by: uuid,
});
export type RequestResponse = z.infer<typeof requestResponse>;

export const reminderResponse = z.object({
  id: uuid,
  request_id: uuid,
  sent_by: uuid,
  sent_at: z.string(),
});
export type ReminderResponse = z.infer<typeof reminderResponse>;
