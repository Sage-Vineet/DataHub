import {
  buildReminderFrequencyLabel,
  getReminderDeadline,
  isRequestResolved,
  resolveNextReminderAt,
  resolveReminderFrequencyDays,
  resolveScheduledReminderAt,
  type SessionUser,
} from "@datahub/contracts";
import type { ReminderHistoryRow, ReminderSourceRow } from "./ports.js";

/**
 * Reminders, derived from requests and their send history.
 *
 * There IS a `reminders` table, and it is not what this reads — legacy's list
 * endpoint derives every reminder from the request it chases, and the SPA's
 * Reminders page is built against that derivation. Reading the table instead
 * would show a broker 49 rows that no Remind button ever touches, so this keeps
 * the derivation and moves it off the legacy Supabase path that was 500ing.
 *
 * Pure over its inputs: no clock beyond the `now` passed in, no I/O. Everything
 * that decides what a broker sees on that page is testable from here.
 */

export type ReminderStatus = "due" | "active" | "blocked" | "resolved";

export interface ReminderHistoryEntry {
  request_id: string;
  sent_at: string;
  sent_by: string;
  sent_by_name: string | null;
  sent_by_email: string | null;
}

export interface ReminderView {
  id: string;
  request_id: string;
  company_id: string;
  company_name: string | null;
  title: string;
  message: string | null;
  due_date: string;
  priority: string;
  frequency_days: number;
  frequency_label: string;
  sent_count: number;
  first_sent_at: string | null;
  last_sent_at: string | null;
  next_due_at: string | null;
  next_reminder_at: string | null;
  automatic_until: string | null;
  status: ReminderStatus;
  workflow_status: string;
  submission_source: string;
  approval_status: string;
  visible: boolean;
  created_at: string;
  company_contact_name: string | null;
  company_contact_email: string | null;
  company_contact_phone: string | null;
  history: ReminderHistoryEntry[];
}

/**
 * Whether this user should see the reminder for this request at all.
 *
 * Brokers and admins see the whole board — chasing is their job. Everyone else
 * sees a request only once it is approved and visible, plus anything they raised
 * themselves: a buyer who submitted a request and then could not see it being
 * chased would have no way to know it was live.
 */
export function canSeeReminder(user: SessionUser, source: ReminderSourceRow): boolean {
  if (user.role === "admin" || user.role === "broker") return true;
  const { request } = source;
  if (request.createdBy === user.id) return true;
  return request.approvalStatus === "approved" && request.visible;
}

/**
 * Where a reminder sits right now.
 *
 * "due" is the only state that asks a broker to act, so it is deliberately
 * narrow: the next chase has come round, or the request ran past its deadline
 * with no chase left scheduled. A resolved or blocked request is never due —
 * chasing a completed request is noise, and a blocked one needs unblocking, not
 * another nudge.
 */
export function reminderStatus(
  source: ReminderSourceRow,
  nextReminderAt: string | null,
  now: Date,
): ReminderStatus {
  const { request } = source;
  if (isRequestResolved(request.status)) return "resolved";
  if (request.status === "blocked") return "blocked";
  if (nextReminderAt && new Date(nextReminderAt) <= now) return "due";
  const deadline = getReminderDeadline(request.dueDate);
  if (!nextReminderAt && deadline && new Date(deadline) < now) return "due";
  return "active";
}

/** Board order: what needs chasing first, then by when the next chase lands. */
const STATUS_ORDER: Record<ReminderStatus, number> = { due: 0, active: 1, blocked: 2, resolved: 3 };

/** One request's reminder, given its own send history newest-first. */
function toReminder(source: ReminderSourceRow, history: ReminderHistoryEntry[], now: Date): ReminderView {
  const { request } = source;
  const last = history[0] ?? null;
  const first = history[history.length - 1] ?? null;

  // The cadence counts from the last chase; failing that, from when the request
  // became actionable (approval), and failing that, from when it was raised.
  const base = last?.sent_at ?? source.approvedAt ?? source.createdAt;

  const nextDueAt = resolveNextReminderAt(base, request.priority, request.reminderFrequencyDays, request.dueDate);

  return {
    id: `request-reminder-${request.id}`,
    request_id: request.id,
    company_id: request.companyId,
    company_name: source.companyName,
    title: request.title,
    message: null,
    due_date: request.dueDate,
    priority: request.priority,
    frequency_days: resolveReminderFrequencyDays(request.priority, request.reminderFrequencyDays),
    frequency_label: buildReminderFrequencyLabel(request.priority, request.reminderFrequencyDays),
    sent_count: history.length,
    // Null when nothing has been sent. Legacy fell back to the approval or
    // creation timestamp here, so the board told a broker "Last Reminder 14 Aug"
    // next to "Sent Count 0" — a claim they had chased a client when they had
    // not. The cadence still dates from those timestamps (see `base` above);
    // only the reported send history is held to what was actually sent.
    first_sent_at: first?.sent_at ?? null,
    last_sent_at: last?.sent_at ?? null,
    next_due_at: nextDueAt,
    // The schedule ignores the deadline; `next_due_at` is the one that stops at
    // it. Both are shown, because "every 2 days, but not after Friday" is the
    // whole of what a broker needs to know about an overdue chase.
    next_reminder_at: resolveScheduledReminderAt(base, request.priority, request.reminderFrequencyDays),
    automatic_until: getReminderDeadline(request.dueDate),
    status: reminderStatus(source, nextDueAt, now),
    workflow_status: request.status,
    submission_source: request.submissionSource,
    approval_status: request.approvalStatus,
    visible: request.visible,
    created_at: source.createdAt,
    company_contact_name: source.companyContactName,
    company_contact_email: source.companyContactEmail,
    company_contact_phone: source.companyContactPhone,
    history,
  };
}

/** The reminders board for one company, filtered to what this user may see. */
export function buildReminders(
  user: SessionUser,
  sources: ReminderSourceRow[],
  history: ReminderHistoryRow[],
  now: Date = new Date(),
): ReminderView[] {
  const visible = sources.filter((s) => canSeeReminder(user, s));
  if (visible.length === 0) return [];

  const byRequest = new Map<string, ReminderHistoryEntry[]>();
  for (const h of history) {
    const entry: ReminderHistoryEntry = {
      request_id: h.requestId,
      sent_at: h.sentAt,
      sent_by: h.sentBy,
      sent_by_name: h.sentByName,
      sent_by_email: h.sentByEmail,
    };
    const list = byRequest.get(h.requestId);
    if (list) list.push(entry);
    else byRequest.set(h.requestId, [entry]);
  }
  // The repository orders newest-first, but sorting here keeps the derivation
  // correct on its own terms rather than on a promise made elsewhere.
  for (const list of byRequest.values()) list.sort((a, b) => b.sent_at.localeCompare(a.sent_at));

  const reminders = visible.map((s) => toReminder(s, byRequest.get(s.request.id) ?? [], now));

  reminders.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return String(a.next_reminder_at ?? a.next_due_at ?? "").localeCompare(
      String(b.next_reminder_at ?? b.next_due_at ?? ""),
    );
  });

  return reminders;
}
