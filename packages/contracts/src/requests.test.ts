import { describe, expect, it } from "vitest";
import {
  addDays,
  getReminderDeadline,
  requestCreate,
  resolveNextReminderAt,
  resolveReminderFrequencyDays,
} from "./requests.js";

describe("resolveReminderFrequencyDays", () => {
  it("defaults by priority", () => {
    expect(resolveReminderFrequencyDays("critical")).toBe(1);
    expect(resolveReminderFrequencyDays("high")).toBe(1);
    expect(resolveReminderFrequencyDays("medium")).toBe(2);
    expect(resolveReminderFrequencyDays("low")).toBe(7);
  });
  it("honors a positive explicit override, but treats 2-for-non-medium as the legacy default", () => {
    expect(resolveReminderFrequencyDays("low", 3)).toBe(3);
    expect(resolveReminderFrequencyDays("high", 2)).toBe(1); // legacy schema default → priority
    expect(resolveReminderFrequencyDays("medium", 2)).toBe(2);
    expect(resolveReminderFrequencyDays("low", 0)).toBe(7);
  });
});

describe("requestCreate", () => {
  const base = {
    title: "Send Q1",
    description: "please upload",
    category: "Finance",
    response_type: "Upload",
    priority: "high",
    due_date: "2027-01-15",
  };
  it("accepts a valid request", () => {
    expect(requestCreate.safeParse(base).success).toBe(true);
  });
  it("rejects bad enums and a malformed due date", () => {
    expect(requestCreate.safeParse({ ...base, category: "Nope" }).success).toBe(false);
    expect(requestCreate.safeParse({ ...base, priority: "urgent" }).success).toBe(false);
    expect(requestCreate.safeParse({ ...base, due_date: "01/15/2027" }).success).toBe(false);
    expect(requestCreate.safeParse({ ...base, title: "" }).success).toBe(false);
  });
});

describe("when the next chase falls", () => {
  /**
   * The chase loop's arithmetic. It runs unattended, so every branch of it is
   * a decision nobody watches being made.
   */
  it("adds days in UTC, so a chase does not drift a day either way", () => {
    // Local-time arithmetic across a DST boundary moves the hour, and a
    // schedule compared against a date-only deadline then slips a day.
    expect(addDays("2026-03-28T12:00:00.000Z", 3)).toBe("2026-03-31T12:00:00.000Z");
    expect(addDays(new Date("2026-10-24T12:00:00.000Z"), 3)).toBe("2026-10-27T12:00:00.000Z");
  });

  it("counts from now when nothing says when to count from", () => {
    // A request that has never been chased has no last-chase date.
    const from = addDays(null, 1);
    expect(from).not.toBeNull();
    expect(new Date(from!).getTime()).toBeGreaterThan(Date.now());
  });

  it("answers null for a base nothing can read, rather than an Invalid Date", () => {
    // Stored, an Invalid Date becomes the string "Invalid Date" and every
    // comparison against it is false — so the chase silently never fires.
    expect(addDays("not a date", 1)).toBeNull();
  });

  it("puts the deadline at the end of the due day, not the start", () => {
    // A request due today is not overdue until today is over.
    expect(getReminderDeadline("2026-08-31")).toBe("2026-08-31T23:59:59.999Z");
    expect(getReminderDeadline("2026-08-31T09:00:00.000Z")).toBe("2026-08-31T23:59:59.999Z");
  });

  it("has no deadline for a request with no due date, or an unreadable one", () => {
    expect(getReminderDeadline(null)).toBeNull();
    expect(getReminderDeadline(undefined)).toBeNull();
    expect(getReminderDeadline("")).toBeNull();
    expect(getReminderDeadline("the end of the month")).toBeNull();
  });

  it("stops chasing once the next one would land after the deadline", () => {
    // A schedule that keeps firing past the due date tells a broker nothing
    // they do not already know — the request is overdue, which it says itself.
    const nextDay = resolveNextReminderAt("2026-08-30T09:00:00.000Z", "high", null, "2026-08-31");
    expect(nextDay).toBe("2026-08-31T09:00:00.000Z");

    const past = resolveNextReminderAt("2026-08-31T09:00:00.000Z", "high", null, "2026-08-31");
    expect(past).toBeNull();
  });

  it("keeps chasing a request with no due date at all", () => {
    // No deadline is not the same as a deadline that has passed.
    expect(
      resolveNextReminderAt("2026-08-30T09:00:00.000Z", "high", null, null),
    ).toBe("2026-08-31T09:00:00.000Z");
  });

  it("answers null when there is no base to schedule from", () => {
    expect(resolveNextReminderAt("nonsense", "high", null, "2026-12-31")).toBeNull();
  });
});
