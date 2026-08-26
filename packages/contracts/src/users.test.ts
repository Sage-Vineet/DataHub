import { describe, expect, it } from "vitest";
import { brokerTeamInvite, companyMembership, userCreate, userUpdate } from "./users.js";

describe("userCreate", () => {
  it("requires name/email/password/role and normalizes email", () => {
    const parsed = userCreate.parse({
      name: "Jo",
      email: "  Jo@Example.COM ",
      password: "sup3rsecret",
      role: "buyer",
      sub_role: "client_team_member",
    });
    expect(parsed.email).toBe("jo@example.com");
    expect(parsed.role).toBe("buyer");
    expect(parsed.sub_role).toBe("client_team_member");
  });

  it("rejects missing fields, a weak password, and an unknown sub_role", () => {
    expect(userCreate.safeParse({ name: "Jo", email: "a@b.com", role: "buyer" }).success).toBe(false);
    expect(
      userCreate.safeParse({ name: "Jo", email: "a@b.com", password: "short", role: "buyer" }).success,
    ).toBe(false);
    expect(
      userCreate.safeParse({ name: "Jo", email: "a@b.com", password: "sup3rsecret", role: "buyer", sub_role: "wizard" }).success,
    ).toBe(false);
  });
});

describe("userUpdate", () => {
  it("is all-optional and keeps current_password alongside password", () => {
    expect(userUpdate.safeParse({}).success).toBe(true);
    const parsed = userUpdate.parse({ password: "newpassw0rd", current_password: "old" });
    expect(parsed.password).toBe("newpassw0rd");
    expect(parsed.current_password).toBe("old");
  });
});

describe("membership + team invite", () => {
  it("requires at least one company id and a valid invited broker id", () => {
    expect(companyMembership.safeParse({ company_ids: [] }).success).toBe(false);
    expect(companyMembership.safeParse({ company_ids: ["11111111-1111-1111-1111-111111111111"] }).success).toBe(true);
    expect(brokerTeamInvite.safeParse({ invited_broker_id: "not-a-uuid" }).success).toBe(false);
  });
});
