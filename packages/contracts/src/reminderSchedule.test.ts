import { describe, expect, it } from "vitest";
import {
  addDays,
  buildReminderFrequencyLabel,
  getReminderDeadline,
  isRequestResolved,
  resolveNextReminderAt,
  resolveScheduledReminderAt,
} from "./requests.js";

/**
 * The chase cadence, ported from `backend/src/utils/requestReminders.js`.
 *
 * These are pinned rather than assumed because the reminders board reads
 * entirely off them: a wrong cadence does not fail loudly, it just shows a
 * broker the wrong set of requests to chase today.
 */

describe("buildReminderFrequencyLabel", () => {
  it("names the priority defaults", () => {
    expect(buildReminderFrequencyLabel("critical")).toBe("Daily");
    expect(buildReminderFrequencyLabel("high")).toBe("Daily");
    expect(buildReminderFrequencyLabel("medium")).toBe("Every 2 days");
    expect(buildReminderFrequencyLabel("low")).toBe("Weekly");
  });

  it("says the number when someone chose one, rather than hiding it behind a word", () => {
    expect(buildReminderFrequencyLabel("low", 3)).toBe("Every 3 days");
    expect(buildReminderFrequencyLabel("critical", 5)).toBe("Every 5 days");
    expect(buildReminderFrequencyLabel("low", 1)).toBe("Daily");
  });

  it("ignores the legacy schema default of 2 on a non-medium priority", () => {
    // Every legacy row carries reminder_frequency_days = 2 whether or not anyone
    // set it, so treating it as explicit would put a critical request on a
    // two-day chase.
    expect(buildReminderFrequencyLabel("critical", 2)).toBe("Daily");
    expect(buildReminderFrequencyLabel("medium", 2)).toBe("Every 2 days");
  });
});

describe("addDays", () => {
  it("advances in UTC", () => {
    expect(addDays("2026-08-21T10:00:00.000Z", 2)).toBe("2026-08-23T10:00:00.000Z");
  });

  it("crosses a month and a year boundary", () => {
    expect(addDays("2026-12-30T00:00:00.000Z", 7)).toBe("2027-01-06T00:00:00.000Z");
  });

  it("returns null rather than an Invalid Date string", () => {
    expect(addDays("not a date", 1)).toBeNull();
  });
});

describe("getReminderDeadline", () => {
  it("runs the deadline to the end of the due day", () => {
    expect(getReminderDeadline("2026-08-24")).toBe("2026-08-24T23:59:59.999Z");
  });

  it("tolerates a full timestamp by taking its date", () => {
    expect(getReminderDeadline("2026-08-24T09:30:00Z")).toBe("2026-08-24T23:59:59.999Z");
  });

  it("has no deadline without a due date", () => {
    expect(getReminderDeadline(null)).toBeNull();
    expect(getReminderDeadline("")).toBeNull();
  });
});

describe("resolveScheduledReminderAt", () => {
  it("schedules from the base at the priority cadence", () => {
    expect(resolveScheduledReminderAt("2026-08-21T00:00:00.000Z", "medium")).toBe("2026-08-23T00:00:00.000Z");
    expect(resolveScheduledReminderAt("2026-08-21T00:00:00.000Z", "low")).toBe("2026-08-28T00:00:00.000Z");
  });

  it("keeps scheduling past the deadline — that is what next_due_at is for", () => {
    expect(resolveScheduledReminderAt("2026-08-21T00:00:00.000Z", "high", null)).toBe("2026-08-22T00:00:00.000Z");
  });
});

describe("resolveNextReminderAt", () => {
  it("returns the next chase when it lands inside the deadline", () => {
    expect(resolveNextReminderAt("2026-08-21T00:00:00.000Z", "high", null, "2026-08-24")).toBe(
      "2026-08-22T00:00:00.000Z",
    );
  });

  it("stops at the deadline rather than chasing forever", () => {
    // A schedule that keeps firing after the due date tells a broker nothing
    // they don't already know from the request being overdue.
    expect(resolveNextReminderAt("2026-08-24T00:00:00.000Z", "low", null, "2026-08-24")).toBeNull();
  });

  it("keeps chasing when the request has no due date at all", () => {
    expect(resolveNextReminderAt("2026-08-21T00:00:00.000Z", "high", null, null)).toBe("2026-08-22T00:00:00.000Z");
  });

  it("allows a chase landing exactly on the last moment of the due day", () => {
    // The deadline is inclusive: landing on it is inside the window, one
    // millisecond past it is not.
    expect(resolveNextReminderAt("2026-08-23T23:59:59.999Z", "high", null, "2026-08-24")).toBe(
      "2026-08-24T23:59:59.999Z",
    );
    expect(resolveNextReminderAt("2026-08-24T00:00:00.000Z", "high", null, "2026-08-24")).toBeNull();
  });
});

describe("isRequestResolved", () => {
  it("treats completed and rejected as done", () => {
    expect(isRequestResolved("completed")).toBe(true);
    expect(isRequestResolved("REJECTED")).toBe(true);
    expect(isRequestResolved(" completed ")).toBe(true);
  });

  it("treats everything else as still open", () => {
    for (const s of ["pending", "in-review", "blocked", "", null, undefined]) {
      expect(isRequestResolved(s)).toBe(false);
    }
  });
});
