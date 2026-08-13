import { describe, expect, it } from "vitest";
import { requestCreate, resolveReminderFrequencyDays } from "./requests.js";

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
