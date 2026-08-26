import { describe, expect, it } from "vitest";
import type { EffectiveRole, SubRole, UserRole } from "@datahub/contracts";
import { computeEffectiveRole, isBrokerTeamSubRole, isRequestRestricted, type RoleUser } from "./roles.js";

const SELLER_CO = [{ contact_email: "owner@acme.com" }];
const OTHER_CO = [{ contact_email: "someone@else.com" }];

type Case = {
  role: UserRole | "client";
  sub: SubRole | null;
  email: string;
  companies: ReadonlyArray<{ contact_email: string | null }>;
  expected: EffectiveRole;
};

const cases: Case[] = [
  // Admin / broker pass through regardless of sub-role.
  { role: "admin", sub: null, email: "a@x.com", companies: [], expected: "admin" },
  { role: "broker", sub: "broker_team_member", email: "b@x.com", companies: [], expected: "broker" },
  // Buyers with a client-side sub-role → client.
  { role: "buyer", sub: "company_owner", email: "c@x.com", companies: OTHER_CO, expected: "client" },
  { role: "buyer", sub: "client_team_member", email: "c@x.com", companies: [], expected: "client" },
  { role: "buyer", sub: "client_accountant", email: "c@x.com", companies: [], expected: "client" },
  // Buyer whose email matches a company contact ("seller") → client, even with no client sub-role.
  { role: "buyer", sub: null, email: "owner@acme.com", companies: SELLER_CO, expected: "client" },
  { role: "buyer", sub: "buyer_primary", email: "owner@acme.com", companies: SELLER_CO, expected: "client" },
  // Plain buyer (no client sub-role, not a seller) → user.
  { role: "buyer", sub: null, email: "b@x.com", companies: OTHER_CO, expected: "user" },
  { role: "buyer", sub: "buyer_team_member", email: "b@x.com", companies: [], expected: "user" },
  // Defensive legacy `client` role → client.
  { role: "client", sub: null, email: "c@x.com", companies: [], expected: "client" },
  // Empty email must not accidentally match an empty company contact.
  { role: "buyer", sub: null, email: "", companies: [{ contact_email: "" }], expected: "user" },
];

describe("computeEffectiveRole (table-driven parity)", () => {
  for (const c of cases) {
    it(`${c.role}/${c.sub ?? "—"}${c.email ? ` <${c.email}>` : ""} → ${c.expected}`, () => {
      const user: RoleUser = { role: c.role, subRole: c.sub, email: c.email };
      expect(computeEffectiveRole(user, c.companies)).toBe(c.expected);
    });
  }
});

describe("role helpers", () => {
  it("flags client-team sub-roles as request-restricted", () => {
    expect(isRequestRestricted("client_team_member")).toBe(true);
    expect(isRequestRestricted("client_accountant")).toBe(true);
    expect(isRequestRestricted("company_owner")).toBe(false);
    expect(isRequestRestricted(null)).toBe(false);
  });

  it("recognizes broker-team sub-roles a broker may create", () => {
    expect(isBrokerTeamSubRole("broker_team_member")).toBe(true);
    expect(isBrokerTeamSubRole("banker")).toBe(true);
    expect(isBrokerTeamSubRole("loan_broker")).toBe(true);
    expect(isBrokerTeamSubRole("broker_primary")).toBe(false);
    expect(isBrokerTeamSubRole(null)).toBe(false);
  });
});
