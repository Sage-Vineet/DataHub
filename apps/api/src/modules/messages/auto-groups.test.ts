import { describe, expect, it } from "vitest";
import {
  brokerCompanyNameOf,
  buyersByFirm,
  planCompanyGroups,
  sideOf,
  type GroupingMember,
} from "./auto-groups.js";

/**
 * Which groups a company should have.
 *
 * These rules decide who can read whose messages, so the cases that matter most
 * are the negative ones: a buyer must never land in the broker↔client room, and
 * a member nobody can classify must not be swept into a group by default.
 */

const member = (over: Partial<GroupingMember> & { id: string }): GroupingMember => ({
  role: "buyer",
  subRole: null,
  parentUserId: null,
  name: null,
  brokerCompany: null,
  buyerCompanyName: null,
  ...over,
});

const broker = (id: string, over: Partial<GroupingMember> = {}) =>
  member({ id, role: "broker", subRole: "broker_primary", ...over });
const client = (id: string, over: Partial<GroupingMember> = {}) =>
  member({ id, role: "buyer", subRole: "company_owner", ...over });
const buyer = (id: string, over: Partial<GroupingMember> = {}) =>
  member({ id, role: "buyer", subRole: "buyer_primary", ...over });

describe("classifying a member", () => {
  it("reads the sub-role first", () => {
    expect(sideOf(broker("b"))).toBe("broker");
    expect(sideOf(client("c"))).toBe("client");
    expect(sideOf(buyer("u"))).toBe("buyer");
  });

  it("falls back to the role when there is no sub-role", () => {
    // Accounts predating sub-roles still exist.
    expect(sideOf(member({ id: "a", role: "admin" }))).toBe("broker");
    expect(sideOf(member({ id: "b", role: "broker" }))).toBe("broker");
    expect(sideOf(member({ id: "c", role: "buyer" }))).toBe("client");
    // Not in the database's enum, but legacy wrote it and rows still carry it.
    expect(sideOf(member({ id: "d", role: "client" }))).toBe("client");
  });

  it("does not guess when nothing matches", () => {
    expect(sideOf(member({ id: "x", role: "wat" }))).toBe("unknown");
    expect(sideOf(member({ id: "y", role: "broker", subRole: "not_a_sub_role" }))).toBe("unknown");
  });

  it("lets an unrecognised sub-role override a known role, rather than the reverse", () => {
    // A sub-role is the more specific statement. Falling back to `role` here
    // would put someone the system does not understand onto the broker side.
    expect(sideOf(member({ id: "z", role: "admin", subRole: "mystery" }))).toBe("unknown");
  });
});

describe("naming the broker firm", () => {
  it("uses the first broker who has a firm name", () => {
    expect(brokerCompanyNameOf([broker("b1"), broker("b2", { brokerCompany: "Kestrel" })])).toBe(
      "Kestrel",
    );
  });

  it("falls back to a generic label rather than a person's name", () => {
    // The other side of the deal reads this string as a group title.
    expect(brokerCompanyNameOf([broker("b1", { name: "Dana" })])).toBe("Broker");
    expect(brokerCompanyNameOf([])).toBe("Broker");
  });

  it("ignores a firm name on someone who is not a broker", () => {
    expect(brokerCompanyNameOf([client("c", { brokerCompany: "Wrong" })])).toBe("Broker");
  });
});

describe("grouping buyers into firms", () => {
  it("puts a team member under its principal", () => {
    const firms = buyersByFirm([buyer("p"), buyer("t", { parentUserId: "p" })]);
    expect([...firms.keys()]).toEqual(["p"]);
    expect(firms.get("p")!.sort()).toEqual(["p", "t"]);
  });

  it("keeps separate firms separate", () => {
    const firms = buyersByFirm([buyer("p1"), buyer("p2")]);
    expect(firms.size).toBe(2);
  });

  it("ignores anyone who is not buyer-side", () => {
    expect(buyersByFirm([broker("b"), client("c")]).size).toBe(0);
  });
});

describe("planning a company's groups", () => {
  const COMPANY = "Acme";

  it("creates the broker↔client room and the deal team", () => {
    const plan = planCompanyGroups(COMPANY, [
      broker("b", { brokerCompany: "Kestrel" }),
      client("c"),
    ]);

    expect(plan.map((g) => g.groupType)).toEqual(["broker_client", "deal_team"]);
    expect(plan[0]).toMatchObject({
      name: "Kestrel - Acme",
      buyerUserId: null,
      memberIds: ["b", "c"],
    });
    expect(plan[1]!.name).toBe("DealTeam - Acme");
  });

  it("never creates broker_internal — an empty private room is noise", () => {
    const plan = planCompanyGroups(COMPANY, [broker("b1"), broker("b2")]);
    expect(plan.map((g) => g.groupType)).not.toContain("broker_internal");
  });

  it("skips the broker↔client room when one side is missing", () => {
    expect(planCompanyGroups(COMPANY, [broker("b")]).map((g) => g.groupType)).toEqual(["deal_team"]);
    expect(planCompanyGroups(COMPANY, [client("c")]).map((g) => g.groupType)).toEqual(["deal_team"]);
  });

  it("plans nothing at all for a company with nobody classifiable", () => {
    expect(planCompanyGroups(COMPANY, [])).toEqual([]);
    expect(planCompanyGroups(COMPANY, [member({ id: "x", role: "wat" })])).toEqual([]);
  });

  it("gives each buyer firm its own private channel with the brokers", () => {
    const plan = planCompanyGroups(COMPANY, [
      broker("b", { brokerCompany: "Kestrel" }),
      client("c"),
      buyer("p1", { buyerCompanyName: "Northwind" }),
      buyer("t1", { parentUserId: "p1" }),
      buyer("p2", { name: "Solo Buyer" }),
    ]);

    const channels = plan.filter((g) => g.groupType === "broker_buyer");
    expect(channels).toHaveLength(2);

    const northwind = channels.find((g) => g.buyerUserId === "p1")!;
    expect(northwind.name).toBe("Kestrel - Northwind");
    expect(northwind.memberIds.sort()).toEqual(["b", "p1", "t1"]);
    // The client is NOT in a buyer channel — that is the whole point of it.
    expect(northwind.memberIds).not.toContain("c");

    // No firm name, so the person's own name identifies the channel.
    expect(channels.find((g) => g.buyerUserId === "p2")!.name).toBe("Kestrel - Solo Buyer");
  });

  it("omits buyer channels when there is no broker to be on the other side", () => {
    const plan = planCompanyGroups(COMPANY, [client("c"), buyer("p")]);
    expect(plan.map((g) => g.groupType)).toEqual(["deal_team"]);
  });

  it("puts everyone in the deal team exactly once", () => {
    const plan = planCompanyGroups(COMPANY, [
      broker("b"),
      client("c"),
      buyer("p"),
      buyer("t", { parentUserId: "p" }),
    ]);

    const dealTeam = plan.find((g) => g.groupType === "deal_team")!;
    expect(dealTeam.memberIds.sort()).toEqual(["b", "c", "p", "t"]);
    expect(new Set(dealTeam.memberIds).size).toBe(dealTeam.memberIds.length);
  });

  it("leaves an unclassifiable member out of every group", () => {
    const plan = planCompanyGroups(COMPANY, [broker("b"), client("c"), member({ id: "?", role: "" })]);
    for (const group of plan) expect(group.memberIds).not.toContain("?");
  });

  it("marks company-wide groups with a null buyer, and channels with the firm", () => {
    // The database finds an existing group by (company, type, buyer_user_id), so
    // this distinction is what stops a re-run creating duplicates.
    const plan = planCompanyGroups(COMPANY, [broker("b"), client("c"), buyer("p")]);
    expect(plan.filter((g) => g.buyerUserId === null).map((g) => g.groupType)).toEqual([
      "broker_client",
      "deal_team",
    ]);
    expect(plan.find((g) => g.buyerUserId === "p")!.groupType).toBe("broker_buyer");
  });
});
