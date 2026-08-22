import type { SessionUser } from "@datahub/contracts";
import { describe, expect, it } from "vitest";
import type { ReminderHistoryRow, ReminderSourceRow, RequestRecord } from "./ports.js";
import { buildReminders, canSeeReminder, reminderStatus } from "./reminders.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

const BROKER: SessionUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Bea Broker",
  email: "broker@demo.test",
  role: "broker",
  company_id: "c0000000-0000-4000-8000-000000000001",
  status: "active",
};

const BUYER: SessionUser = { ...BROKER, id: "22222222-2222-4222-8222-222222222222", name: "Dana Buyer", role: "buyer" };

function request(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: "r1",
    companyId: BROKER.company_id!,
    title: "Q2 bank statements",
    subLabel: null,
    description: "",
    category: "Finance",
    responseType: "Upload",
    priority: "high",
    status: "pending",
    dueDate: "2026-08-24",
    assignedTo: null,
    visible: true,
    reminderFrequencyDays: 2,
    submissionSource: "broker",
    approvalStatus: "approved",
    approvedBy: null,
    createdBy: BROKER.id,
    ...over,
  };
}

function source(over: Partial<ReminderSourceRow> & { request?: Partial<RequestRecord> } = {}): ReminderSourceRow {
  const { request: reqOver, ...rest } = over;
  return {
    request: request(reqOver),
    createdAt: "2026-08-18T09:00:00.000Z",
    approvedAt: null,
    companyName: "Acme Manufacturing",
    companyContactName: "Cal Contact",
    companyContactEmail: "cal@acme.test",
    companyContactPhone: "+1 555 0100",
    ...rest,
  };
}

function sent(requestId: string, sentAt: string): ReminderHistoryRow {
  return { requestId, sentAt, sentBy: BROKER.id, sentByName: "Bea Broker", sentByEmail: "broker@demo.test" };
}

describe("canSeeReminder", () => {
  it("shows brokers and admins the whole board", () => {
    const hidden = source({ request: { visible: false, approvalStatus: "pending" } });
    expect(canSeeReminder(BROKER, hidden)).toBe(true);
    expect(canSeeReminder({ ...BROKER, role: "admin" }, hidden)).toBe(true);
  });

  it("hides unapproved and invisible requests from a buyer", () => {
    expect(canSeeReminder(BUYER, source({ request: { approvalStatus: "pending" } }))).toBe(false);
    expect(canSeeReminder(BUYER, source({ request: { visible: false } }))).toBe(false);
  });

  it("shows a buyer the request they raised themselves, approved or not", () => {
    // Otherwise someone submits a request and has no way to see it being chased.
    const own = source({ request: { createdBy: BUYER.id, approvalStatus: "pending", visible: false } });
    expect(canSeeReminder(BUYER, own)).toBe(true);
  });
});

describe("reminderStatus", () => {
  it("never chases a completed or rejected request", () => {
    for (const status of ["completed", "rejected"] as const) {
      expect(reminderStatus(source({ request: { status } }), "2026-01-01T00:00:00.000Z", NOW)).toBe("resolved");
    }
  });

  it("marks a blocked request blocked, not due", () => {
    expect(reminderStatus(source({ request: { status: "blocked" } }), "2026-01-01T00:00:00.000Z", NOW)).toBe("blocked");
  });

  it("is due when the next chase has come round", () => {
    expect(reminderStatus(source(), "2026-08-21T09:00:00.000Z", NOW)).toBe("due");
  });

  it("is active when the next chase is still ahead", () => {
    expect(reminderStatus(source(), "2026-08-23T09:00:00.000Z", NOW)).toBe("active");
  });

  it("is due when the deadline passed with no chase left scheduled", () => {
    // This is the overdue case: the cadence ran out, and the request is still open.
    expect(reminderStatus(source({ request: { dueDate: "2026-08-19" } }), null, NOW)).toBe("due");
  });

  it("is active when there is no chase scheduled but the deadline is still ahead", () => {
    expect(reminderStatus(source({ request: { dueDate: "2026-08-30" } }), null, NOW)).toBe("active");
  });
});

describe("buildReminders", () => {
  it("derives a reminder for every request a broker can see", () => {
    const out = buildReminders(BROKER, [source(), source({ request: { id: "r2" } })], [], NOW);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(expect.arrayContaining(["request-reminder-r1", "request-reminder-r2"]));
  });

  it("counts the sends and carries who sent them", () => {
    const history = [sent("r1", "2026-08-20T10:00:00.000Z"), sent("r1", "2026-08-18T10:00:00.000Z")];
    const [r] = buildReminders(BROKER, [source()], history, NOW);
    expect(r!.sent_count).toBe(2);
    expect(r!.last_sent_at).toBe("2026-08-20T10:00:00.000Z");
    expect(r!.first_sent_at).toBe("2026-08-18T10:00:00.000Z");
    expect(r!.history[0]!.sent_by_name).toBe("Bea Broker");
  });

  it("orders history newest-first regardless of how it arrives", () => {
    const history = [sent("r1", "2026-08-18T10:00:00.000Z"), sent("r1", "2026-08-20T10:00:00.000Z")];
    const [r] = buildReminders(BROKER, [source()], history, NOW);
    expect(r!.history.map((h) => h.sent_at)).toEqual([
      "2026-08-20T10:00:00.000Z",
      "2026-08-18T10:00:00.000Z",
    ]);
  });

  it("counts the cadence from the last send, not from when the request was raised", () => {
    // This is the whole point of the Remind button: chasing today should push
    // the next chase out, not leave the request sitting in "due" forever.
    const before = buildReminders(BROKER, [source()], [], NOW)[0]!;
    const after = buildReminders(BROKER, [source()], [sent("r1", "2026-08-21T11:00:00.000Z")], NOW)[0]!;
    expect(before.status).toBe("due");
    expect(after.status).toBe("active");
    expect(after.next_due_at).toBe("2026-08-22T11:00:00.000Z");
  });

  it("reports no send history rather than dressing up the creation timestamp", () => {
    // Legacy fell back to approved_at/created_at here, so the board read
    // "Last Reminder 14 Aug · Sent Count 0" — telling a broker they had chased
    // a client they had never chased.
    const [r] = buildReminders(BROKER, [source({ approvedAt: "2026-08-19T08:00:00.000Z" })], [], NOW);
    expect(r!.sent_count).toBe(0);
    expect(r!.first_sent_at).toBeNull();
    expect(r!.last_sent_at).toBeNull();
  });

  it("dates the cadence from approval when nothing has been sent yet", () => {
    const s = source({ approvedAt: "2026-08-21T08:00:00.000Z", request: { priority: "medium" } });
    const [r] = buildReminders(BROKER, [s], [], NOW);
    expect(r!.next_due_at).toBe("2026-08-23T08:00:00.000Z");
    expect(r!.status).toBe("active");
  });

  it("puts what needs chasing at the top", () => {
    const due = source({ request: { id: "due" } });
    const resolved = source({ request: { id: "done", status: "completed" } });
    const blocked = source({ request: { id: "stuck", status: "blocked" } });
    const active = source({ request: { id: "later" }, approvedAt: "2026-08-21T11:00:00.000Z" });

    const out = buildReminders(BROKER, [resolved, active, blocked, due], [], NOW);
    expect(out.map((r) => r.status)).toEqual(["due", "active", "blocked", "resolved"]);
  });

  it("carries the contact a broker would actually call", () => {
    const [r] = buildReminders(BROKER, [source()], [], NOW);
    expect(r!.company_contact_name).toBe("Cal Contact");
    expect(r!.company_contact_email).toBe("cal@acme.test");
    expect(r!.company_contact_phone).toBe("+1 555 0100");
    expect(r!.company_name).toBe("Acme Manufacturing");
  });

  it("labels the cadence and stops the automatic chase at the due date", () => {
    const [r] = buildReminders(BROKER, [source({ request: { priority: "low", reminderFrequencyDays: 2 } })], [], NOW);
    expect(r!.frequency_days).toBe(7);
    expect(r!.frequency_label).toBe("Weekly");
    expect(r!.automatic_until).toBe("2026-08-24T23:59:59.999Z");
  });

  it("keeps the schedule visible even once it runs past the deadline", () => {
    // next_due_at stops; next_reminder_at keeps going. A broker needs both to
    // understand why an overdue request has no chase queued.
    const [r] = buildReminders(BROKER, [source({ request: { priority: "low", dueDate: "2026-08-22" } })], [], NOW);
    expect(r!.next_due_at).toBeNull();
    expect(r!.next_reminder_at).toBe("2026-08-25T09:00:00.000Z");
  });

  it("filters to what the user may see rather than returning the broker's board", () => {
    const mine = source({ request: { id: "mine", createdBy: BUYER.id, approvalStatus: "pending" } });
    const theirs = source({ request: { id: "theirs", approvalStatus: "pending" } });
    expect(buildReminders(BUYER, [mine, theirs], [], NOW).map((r) => r.request_id)).toEqual(["mine"]);
  });

  it("returns an empty board rather than throwing when there is nothing to chase", () => {
    expect(buildReminders(BROKER, [], [], NOW)).toEqual([]);
  });

  it("ignores history belonging to another request", () => {
    const [r] = buildReminders(BROKER, [source()], [sent("other", "2026-08-20T10:00:00.000Z")], NOW);
    expect(r!.sent_count).toBe(0);
  });
});
