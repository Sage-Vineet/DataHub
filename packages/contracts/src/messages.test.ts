import { describe, expect, it } from "vitest";
import { groupCreate, messageSend } from "./messages.js";

describe("messageSend", () => {
  it("requires a non-empty body", () => {
    expect(messageSend.safeParse({ body: "hi" }).success).toBe(true);
    expect(messageSend.safeParse({ body: "  " }).success).toBe(false);
    expect(messageSend.safeParse({}).success).toBe(false);
  });
});

describe("groupCreate", () => {
  it("requires a name and a valid group_type", () => {
    expect(groupCreate.safeParse({ name: "Deal Team", group_type: "deal_team" }).success).toBe(true);
    expect(groupCreate.safeParse({ name: "x", group_type: "nope" }).success).toBe(false);
    expect(groupCreate.safeParse({ group_type: "deal_team" }).success).toBe(false);
  });
});
