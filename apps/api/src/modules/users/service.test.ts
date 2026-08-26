import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { users as contracts, type SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { NoopAuthCachePort } from "./adapters.js";
import { InMemoryUsersRepository } from "./repository.memory.js";
import { isBcryptHash, UsersService } from "./service.js";
import type { EmailerPort, NotificationPort } from "./ports.js";

class SpyEmailer implements EmailerPort {
  sent: string[] = [];
  async sendWelcome(u: { email: string }) {
    this.sent.push(u.email);
  }
}
class SpyNotifications implements NotificationPort {
  calls = 0;
  async notifyUserCreated() {
    this.calls += 1;
  }
}

function makeService() {
  const repo = new InMemoryUsersRepository();
  const emailer = new SpyEmailer();
  const notifications = new SpyNotifications();
  const authCache = new NoopAuthCachePort();
  const service = new UsersService({ repo, emailer, notifications, authCache });
  return { repo, emailer, notifications, service };
}

const COMPANY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const session = (over: Partial<SessionUser>): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
  ...over,
});

describe("UsersService — visibility", () => {
  it("admin sees all; broker sees self + shared-company + invited; others see only self", async () => {
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "broker@x.com", role: "broker", companyId: COMPANY_A });
    const inA = repo.seedUser({ id: randomUUID(), email: "clientA@x.com", role: "buyer", companyId: COMPANY_A });
    const inB = repo.seedUser({ id: randomUUID(), email: "clientB@x.com", role: "buyer", companyId: COMPANY_B });
    const otherAdmin = repo.seedUser({ id: randomUUID(), email: "admin2@x.com", role: "admin" });
    const invitedBroker = repo.seedUser({ id: randomUUID(), email: "friend@x.com", role: "broker", companyId: COMPANY_B });
    await repo.inviteBrokerToTeam(brokerId, invitedBroker.id);

    const broker = session({ id: brokerId, role: "broker", company_ids: [COMPANY_A] });
    const seen = (await service.list(broker)).map((u) => u.id);
    expect(seen).toContain(brokerId); // self
    expect(seen).toContain(inA.id); // shares company A
    expect(seen).toContain(invitedBroker.id); // invited to team
    expect(seen).not.toContain(inB.id); // other tenant
    expect(seen).not.toContain(otherAdmin.id); // admins hidden from brokers

    const admin = session({ role: "admin" });
    expect((await service.list(admin)).length).toBe(5);

    const client = session({ id: inA.id, role: "buyer", company_ids: [COMPANY_A] });
    expect((await service.list(client)).map((u) => u.id)).toEqual([inA.id]);
  });
});

describe("UsersService — create gating", () => {
  it("blocks a client from creating; a broker from admin/primary-broker; allows team sub-roles", async () => {
    const { service, emailer, notifications } = makeService();
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });

    await expect(
      service.create(session({ role: "buyer" }), contracts.userCreate.parse({ name: "N", email: "n@x.com", password: "passw0rd1", role: "buyer" })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      service.create(broker, contracts.userCreate.parse({ name: "A", email: "a@x.com", password: "passw0rd1", role: "admin" })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      service.create(broker, contracts.userCreate.parse({ name: "B", email: "b@x.com", password: "passw0rd1", role: "broker" })),
    ).rejects.toBeInstanceOf(ForbiddenError); // primary broker not allowed

    const created = await service.create(
      broker,
      contracts.userCreate.parse({ name: "T", email: "team@x.com", password: "passw0rd1", role: "broker", sub_role: "banker", company_ids: [COMPANY_A] }),
    );
    expect(created.role).toBe("broker");
    expect(emailer.sent).toContain("team@x.com"); // best-effort side effects fired
    expect(notifications.calls).toBe(1);
  });

  it("blocks assigning a company outside the broker's scope", async () => {
    const { service } = makeService();
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });
    await expect(
      service.create(broker, contracts.userCreate.parse({ name: "X", email: "x@x.com", password: "passw0rd1", role: "buyer", company_ids: [COMPANY_B] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("UsersService — update", () => {
  it("blocks a broker changing role to non-buyer; allows profile changes; invalidates cache", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_A });
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });

    await expect(
      service.update(broker, target.id, contracts.userUpdate.parse({ role: "admin" })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const updated = await service.update(broker, target.id, contracts.userUpdate.parse({ name: "Renamed" }));
    expect(updated.name).toBe("Renamed");
  });

  it("requires and verifies the current password on a self password change", async () => {
    const { repo, service } = makeService();
    const id = randomUUID();
    repo.seedUser({ id, email: "self@x.com", role: "buyer", passwordHash: await bcrypt.hash("oldpassw0rd", 10) });
    const self = session({ id, role: "buyer" });

    await expect(
      service.update(self, id, contracts.userUpdate.parse({ password: "newpassw0rd" })),
    ).rejects.toBeInstanceOf(BadRequestError); // missing current_password

    await expect(
      service.update(self, id, contracts.userUpdate.parse({ password: "newpassw0rd", current_password: "wrong" })),
    ).rejects.toBeInstanceOf(BadRequestError); // wrong current_password

    const ok = await service.update(self, id, contracts.userUpdate.parse({ password: "newpassw0rd", current_password: "oldpassw0rd" }));
    expect(ok.id).toBe(id);
  });

  it("forbids supplying current_password when updating someone else", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t2@x.com", role: "buyer", companyId: COMPANY_A });
    const admin = session({ role: "admin" });
    await expect(
      service.update(admin, target.id, contracts.userUpdate.parse({ current_password: "x", password: "newpassw0rd" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("UsersService — what an update writes", () => {
  it("writes every field the caller sent, and only those", async () => {
    // Each field is its own branch: one left out of the patch is a change the
    // caller made, the request accepted, and the record does not carry.
    const { repo, service } = makeService();
    const target = repo.seedUser({
      id: randomUUID(),
      email: "before@x.com",
      role: "buyer",
      companyId: COMPANY_A,
    });
    const parentId = randomUUID();
    repo.seedUser({ id: parentId, email: "parent@x.com", role: "broker", companyId: COMPANY_A });
    const admin = session({ role: "admin" });

    const updated = await service.update(
      admin,
      target.id,
      contracts.userUpdate.parse({
        name: "After",
        email: "after@x.com",
        phone: "+1 555 0100",
        role: "broker",
        status: "inactive",
        sub_role: "broker_team_member",
        designation: "Senior Analyst",
        buyer_company_name: "Beta Holdings",
        parent_user_id: parentId,
        company_id: COMPANY_B,
      }),
    );

    expect(updated).toMatchObject({
      name: "After",
      email: "after@x.com",
      phone: "+1 555 0100",
      role: "broker",
      status: "inactive",
      sub_role: "broker_team_member",
      designation: "Senior Analyst",
      company_id: COMPANY_B,
    });

    // Two of the ten are stored but not part of the response shape, so they
    // are checked where they land rather than not at all.
    const stored = await repo.getById(target.id);
    expect(stored).toMatchObject({
      buyerCompanyName: "Beta Holdings",
      parentUserId: parentId,
    });
  });

  it("clears a field sent empty rather than storing an empty string", async () => {
    // The contract has no way to say "remove it" except an empty string. Stored
    // as `""` the column holds an empty string for some users and NULL for
    // others, and every reader has to handle both.
    const { repo, service } = makeService();
    const target = repo.seedUser({
      id: randomUUID(),
      email: "clear@x.com",
      role: "buyer",
      companyId: COMPANY_A,
      phone: "+1 555 0100",
      designation: "Analyst",
    });
    const admin = session({ role: "admin" });

    const updated = await service.update(
      admin,
      target.id,
      contracts.userUpdate.parse({ phone: "", designation: "" }),
    );

    expect(updated.phone).toBeNull();
    expect(updated.designation).toBeNull();
  });

  it("404s an update to a user that is not there", async () => {
    const { service } = makeService();
    await expect(
      service.update(session({ role: "admin" }), randomUUID(), contracts.userUpdate.parse({ name: "X" })),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses a broker updating somebody outside their companies", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({
      id: randomUUID(),
      email: "elsewhere@x.com",
      role: "buyer",
      companyId: COMPANY_B,
    });
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });
    await expect(
      service.update(broker, target.id, contracts.userUpdate.parse({ name: "X" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a broker assigning somebody to a company they do not hold", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({
      id: randomUUID(),
      email: "assign@x.com",
      role: "buyer",
      companyId: COMPANY_A,
    });
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });
    await expect(
      service.update(
        broker,
        target.id,
        contracts.userUpdate.parse({ company_ids: [COMPANY_B] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets a broker set a role to buyer, which is the one they may set", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({
      id: randomUUID(),
      email: "tobuyer@x.com",
      role: "buyer",
      companyId: COMPANY_A,
    });
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });
    const updated = await service.update(
      broker,
      target.id,
      contracts.userUpdate.parse({ role: "buyer" }),
    );
    expect(updated.role).toBe("buyer");
  });

  it("refuses a buyer updating anybody but themselves, company or no company", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({
      id: randomUUID(),
      email: "other@x.com",
      role: "buyer",
      companyId: COMPANY_A,
    });
    const buyer = session({ role: "buyer", company_id: COMPANY_A });
    await expect(
      service.update(buyer, target.id, contracts.userUpdate.parse({ name: "X" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("UsersService — delete with reassignment invariant (D4)", () => {
  it("rejects (400) when no replacement owner exists and changes nothing", async () => {
    const { repo, service } = makeService();
    const soloAdminId = randomUUID();
    repo.seedUser({ id: soloAdminId, email: "solo@x.com", role: "admin" });
    const self = session({ id: soloAdminId, role: "admin" });
    // Deleting self with no other broker/admin available → no replacement.
    await expect(service.delete(self, soloAdminId)).rejects.toBeInstanceOf(BadRequestError);
    expect(await repo.getById(soloAdminId)).not.toBeNull();
    expect(repo.reassigned).toEqual([]);
  });

  it("reassigns to the actor then deletes when a replacement exists", async () => {
    const { repo, service } = makeService();
    const adminId = randomUUID();
    repo.seedUser({ id: adminId, email: "admin@x.com", role: "admin" });
    const target = repo.seedUser({ id: randomUUID(), email: "gone@x.com", role: "buyer", companyId: COMPANY_A });

    await service.delete(session({ id: adminId, role: "admin" }), target.id);
    expect(await repo.getById(target.id)).toBeNull();
    expect(repo.reassigned).toEqual([{ userId: target.id, replacementId: adminId }]);
  });

  it("blocks a broker who shares no company (403)", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "z@x.com", role: "buyer", companyId: COMPANY_B });
    await expect(
      service.delete(session({ role: "broker", company_ids: [COMPANY_A] }), target.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("UsersService — reading one person", () => {
  /**
   * `get` answers the profile page, and it is the one read that names a single
   * user by id rather than filtering a list. Getting it wrong shows one
   * broker's client to another, which no list-level check would catch.
   */
  it("lets anybody read themselves, whatever their role", async () => {
    const { repo, service } = makeService();
    const buyerId = randomUUID();
    repo.seedUser({ id: buyerId, email: "self@x.com", role: "buyer", companyId: COMPANY_A });

    const seen = await service.get(session({ id: buyerId, role: "buyer" }), buyerId);
    expect(seen.id).toBe(buyerId);
  });

  it("lets an admin read anybody", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_B });
    expect((await service.get(session({ role: "admin" }), target.id)).id).toBe(target.id);
  });

  it("lets a broker read somebody in a company they share", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_A });
    const seen = await service.get(session({ role: "broker", company_ids: [COMPANY_A] }), target.id);
    expect(seen.id).toBe(target.id);
  });

  it("refuses a broker reading somebody in a company they do not", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_B });
    await expect(
      service.get(session({ role: "broker", company_ids: [COMPANY_A] }), target.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a buyer reading anybody but themselves", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_A });
    await expect(
      service.get(session({ role: "buyer", company_ids: [COMPANY_A] }), target.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reports a user who is not there as not found, not as forbidden", async () => {
    // The distinction matters: 403 on a missing id tells a caller the id is
    // real and they merely cannot see it.
    const { service } = makeService();
    await expect(service.get(session({ role: "admin" }), randomUUID())).rejects.toThrow(
      /not found/i,
    );
  });

  it("reads somebody with a company through no company at all", async () => {
    // A session carrying neither `company_ids` nor `company_id` — which is what
    // an admin's session looks like.
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer" });
    const admin = { ...session({ role: "admin" }), company_ids: undefined } as unknown as SessionUser;
    expect((await service.get(admin, target.id)).id).toBe(target.id);
  });
});

describe("UsersService — a row that goes between the write and the read back", () => {
  it("answers an update from what it knew when the row is no longer there", async () => {
    // The write already happened as far as the caller is concerned. Failing
    // here would say it did not, and the next page load would show the change.
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_A });
    repo.update = () => Promise.resolve(null);

    const updated = await service.update(
      session({ role: "admin" }),
      target.id,
      contracts.userUpdate.parse({ name: "Renamed" }),
    );
    expect(updated.id).toBe(target.id);
  });
});

describe("UsersService — somebody whose only company is their primary one", () => {
  it("counts it for visibility, not only their memberships", async () => {
    // `company_id` and `company_ids` are separate columns, and a client
    // invited to a single deal frequently has only the first.
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "t@x.com", role: "buyer", companyId: COMPANY_A });
    const broker = session({ role: "broker", company_id: COMPANY_A, company_ids: [] });

    expect((await service.get(broker, target.id)).id).toBe(target.id);
  });
});

describe("UsersService — deleting somebody who is not there", () => {
  it("says so rather than reporting a permission problem", async () => {
    const { service } = makeService();
    await expect(service.delete(session({ role: "admin" }), randomUUID())).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("UsersService — who inherits a deleted person's work", () => {
  /**
   * The D4 invariant: nothing may be left owned by a user who no longer
   * exists, so a deletion always names a replacement. The order of preference
   * is the actor, then somebody who shares a company with the person being
   * removed, then anybody who could take it on at all.
   *
   * The last step is the one worth stating: a replacement outside the deal is
   * a worse answer than one inside it, and a BETTER answer than leaving the
   * rows orphaned.
   */
  it("prefers somebody who shares a company with the person removed", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "gone@x.com", role: "buyer", companyId: COMPANY_A });
    const nearby = repo.seedUser({ id: randomUUID(), email: "near@x.com", role: "broker", companyId: COMPANY_A });
    repo.seedUser({ id: randomUUID(), email: "far@x.com", role: "broker", companyId: COMPANY_B });

    // Self-deletion, so the actor cannot be the replacement.
    await service.delete(session({ id: target.id, role: "admin" }), target.id);

    expect(repo.reassigned).toEqual([{ userId: target.id, replacementId: nearby.id }]);
  });

  it("falls back to anybody at all rather than leaving the work orphaned", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "gone@x.com", role: "buyer", companyId: COMPANY_A });
    const far = repo.seedUser({ id: randomUUID(), email: "far@x.com", role: "broker", companyId: COMPANY_B });

    await service.delete(session({ id: target.id, role: "admin" }), target.id);

    expect(repo.reassigned).toEqual([{ userId: target.id, replacementId: far.id }]);
  });

  it("takes the company memberships with the person", async () => {
    // A membership row for a user who is gone grants access on behalf of
    // nobody, and nothing in the UI can reach it to revoke it.
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "gone@x.com", role: "buyer", companyId: COMPANY_A });
    repo.seedUser({ id: randomUUID(), email: "near@x.com", role: "broker", companyId: COMPANY_A });
    await repo.addCompanies(target.id, [COMPANY_A, COMPANY_B]);

    await service.delete(session({ id: target.id, role: "admin" }), target.id);

    expect((await repo.assignedCompaniesFor([target.id])).get(target.id) ?? []).toEqual([]);
  });
});

describe("UsersService — membership + broker-team", () => {
  it("adds within scope, blocks out of scope, and manages team invites", async () => {
    const { repo, service } = makeService();
    const target = repo.seedUser({ id: randomUUID(), email: "m@x.com", role: "buyer", companyId: COMPANY_A });
    const broker = session({ role: "broker", company_ids: [COMPANY_A] });

    await service.addCompanies(broker, target.id, [COMPANY_A]);
    await expect(service.addCompanies(broker, target.id, [COMPANY_B])).rejects.toBeInstanceOf(ForbiddenError);

    const invited = repo.seedUser({ id: randomUUID(), email: "peer@x.com", role: "broker" });
    await service.inviteBrokerToTeam(broker, invited.id);
    expect(await repo.invitedBrokerIds(broker.id)).toContain(invited.id);
    await service.removeBrokerFromTeam(broker, invited.id);
    expect(await repo.invitedBrokerIds(broker.id)).not.toContain(invited.id);

    const buyer = repo.seedUser({ id: randomUUID(), email: "nb@x.com", role: "buyer" });
    await expect(service.inviteBrokerToTeam(broker, buyer.id)).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("UsersService — finding by email", () => {
  it("finds a user the viewer may see", async () => {
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "broker@x.com", role: "broker", companyId: COMPANY_A });
    repo.seedUser({ id: randomUUID(), email: "client@x.com", role: "buyer", companyId: COMPANY_A });

    const found = await service.findByEmail(
      session({ id: brokerId, role: "broker", company_ids: [COMPANY_A] }),
      "client@x.com",
    );
    expect(found?.email).toBe("client@x.com");
  });

  it("matches regardless of case or surrounding space", async () => {
    // The address is typed by a person, into a search box.
    const { repo, service } = makeService();
    repo.seedUser({ id: randomUUID(), email: "client@x.com", role: "buyer", companyId: COMPANY_A });
    const admin = session({ role: "admin" });

    expect((await service.findByEmail(admin, "  CLIENT@X.COM "))?.email).toBe("client@x.com");
  });

  it("returns null for an address nobody has, rather than throwing", async () => {
    // A miss is an answer; the caller renders "no match".
    const { service } = makeService();
    expect(await service.findByEmail(session({ role: "admin" }), "nobody@x.com")).toBeNull();
  });

  it("refuses to confirm a user the viewer may not see", async () => {
    // Otherwise the endpoint is a directory of every account in the system.
    const { repo, service } = makeService();
    repo.seedUser({ id: randomUUID(), email: "elsewhere@x.com", role: "buyer", companyId: COMPANY_B });
    const outsider = session({ role: "buyer", company_ids: [COMPANY_A] });

    await expect(service.findByEmail(outsider, "elsewhere@x.com")).rejects.toThrow(ForbiddenError);
  });
});

describe("UsersService — the broker team", () => {
  it("invites another broker", async () => {
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "broker@x.com", role: "broker" });
    const friend = repo.seedUser({ id: randomUUID(), email: "friend@x.com", role: "broker" });

    await service.inviteBrokerToTeam(session({ id: brokerId, role: "broker" }), friend.id);

    // The invitation is what makes them mutually visible.
    const seen = (await service.list(session({ id: brokerId, role: "broker" }))).map((u) => u.id);
    expect(seen).toContain(friend.id);
  });

  it("refuses to invite somebody who is not a broker account", async () => {
    // A client on a broker's team would see every deal the broker sees.
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "broker@x.com", role: "broker" });
    const client = repo.seedUser({ id: randomUUID(), email: "client@x.com", role: "buyer" });

    await expect(
      service.inviteBrokerToTeam(session({ id: brokerId, role: "broker" }), client.id),
    ).rejects.toThrow(BadRequestError);
  });

  it("404s an invitation to somebody who does not exist", async () => {
    const { service } = makeService();
    await expect(
      service.inviteBrokerToTeam(session({ role: "broker" }), randomUUID()),
    ).rejects.toThrow(/not found/i);
  });

  it("lets only a broker or admin manage the team", async () => {
    const { repo, service } = makeService();
    const friend = repo.seedUser({ id: randomUUID(), email: "friend@x.com", role: "broker" });
    const client = session({ role: "buyer" });

    await expect(service.inviteBrokerToTeam(client, friend.id)).rejects.toThrow(ForbiddenError);
    await expect(service.removeBrokerFromTeam(client, friend.id)).rejects.toThrow(ForbiddenError);
  });

  it("removes a broker from the team, and they stop being visible", async () => {
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "broker@x.com", role: "broker" });
    const friend = repo.seedUser({ id: randomUUID(), email: "friend@x.com", role: "broker" });
    const actor = session({ id: brokerId, role: "broker" });

    await service.inviteBrokerToTeam(actor, friend.id);
    await service.removeBrokerFromTeam(actor, friend.id);

    expect((await service.list(actor)).map((u) => u.id)).not.toContain(friend.id);
  });
});

describe("UsersService — company assignment", () => {
  it("revokes a granted company, leaving the primary one alone", async () => {
    // `users.company_id` is an assignment in its own right and survives a link
    // being revoked — so the grant under test is the `user_companies` one.
    const { repo, service } = makeService();
    const client = repo.seedUser({ id: randomUUID(), email: "c@x.com", role: "buyer", companyId: COMPANY_A });
    const admin = session({ role: "admin" });

    const granted = await service.addCompanies(admin, client.id, [COMPANY_B]);
    expect(granted.assigned_companies?.map((c) => c.id) ?? []).toContain(COMPANY_B);

    const after = await service.removeCompanies(admin, client.id, [COMPANY_B]);
    const ids = after.assigned_companies?.map((c) => c.id) ?? [];
    expect(ids).not.toContain(COMPANY_B);
    expect(ids).toContain(COMPANY_A);
  });

  it("lets a broker revoke only companies they are on themselves", async () => {
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "broker@x.com", role: "broker", companyId: COMPANY_A });
    const client = repo.seedUser({ id: randomUUID(), email: "c@x.com", role: "buyer", companyId: COMPANY_A });
    const broker = session({ id: brokerId, role: "broker", company_ids: [COMPANY_A] });

    await expect(service.removeCompanies(broker, client.id, [COMPANY_B])).rejects.toThrow(
      ForbiddenError,
    );
    await expect(service.removeCompanies(broker, client.id, [COMPANY_A])).resolves.toBeTruthy();
  });
});

describe("UsersService — the repository's own guarantee", () => {
  it("answers an entry for a user with no companies, not no entry", () => {
    // Eight read sites in the service depend on this. Without it each needs
    // its own `?? []`, which is eight separate decisions no test can reach —
    // and a store that started omitting the key would break all eight at once
    // with nothing to catch it.
    const { repo } = makeService();
    const id = randomUUID();
    repo.seedUser({ id, email: "lonely@x.com", role: "buyer" });

    return repo.assignedCompaniesFor([id, randomUUID()]).then((map) => {
      expect(map.size).toBe(2);
      expect([...map.values()].every(Array.isArray)).toBe(true);
    });
  });

  it("answers an empty map when asked about nobody", async () => {
    const { repo } = makeService();
    expect((await repo.assignedCompaniesFor([])).size).toBe(0);
  });
});

describe("UsersService — visibility, the rest of it", () => {
  it("lets a broker see somebody they invited to their team", async () => {
    // An invited broker has no company in common yet — the invite IS the
    // relationship, and without it the invitee is invisible to the person who
    // invited them.
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    const invitedId = randomUUID();
    repo.seedUser({ id: brokerId, email: "host@x.com", role: "broker", companyId: COMPANY_A });
    repo.seedUser({ id: invitedId, email: "guest@x.com", role: "broker", companyId: COMPANY_B });
    await repo.inviteBrokerToTeam(brokerId, invitedId);

    const seen = await service.list(
      session({ id: brokerId, role: "broker", company_ids: [COMPANY_A] }),
    );
    expect(seen.map((u) => u.id)).toContain(invitedId);
    expect(seen.find((u) => u.id === invitedId)?.is_team_invite).toBe(true);
  });

  it("keeps admins out of a broker's list", async () => {
    // A broker sharing a company with an admin should not see the admin in
    // their people list; the admin is not part of the deal team.
    const { repo, service } = makeService();
    const brokerId = randomUUID();
    repo.seedUser({ id: brokerId, email: "b@x.com", role: "broker", companyId: COMPANY_A });
    repo.seedUser({ id: randomUUID(), email: "admin@x.com", role: "admin", companyId: COMPANY_A });

    const seen = await service.list(session({ id: brokerId, role: "broker", company_ids: [COMPANY_A] }));
    expect(seen.some((u) => u.role === "admin")).toBe(false);
  });

  it("shows a buyer only themselves", async () => {
    const { repo, service } = makeService();
    const buyerId = randomUUID();
    repo.seedUser({ id: buyerId, email: "buyer@x.com", role: "buyer", companyId: COMPANY_A });
    repo.seedUser({ id: randomUUID(), email: "other@x.com", role: "buyer", companyId: COMPANY_A });

    const seen = await service.list(session({ id: buyerId, role: "buyer", company_ids: [COMPANY_A] }));
    expect(seen.map((u) => u.id)).toEqual([buyerId]);
  });

  it("shows an admin everybody", async () => {
    const { repo, service } = makeService();
    repo.seedUser({ id: randomUUID(), email: "a@x.com", role: "buyer", companyId: COMPANY_A });
    repo.seedUser({ id: randomUUID(), email: "b@x.com", role: "broker", companyId: COMPANY_B });

    expect((await service.list(session({ role: "admin" }))).length).toBe(2);
  });
});

describe("isBcryptHash", () => {
  it("recognises a real bcrypt hash and rejects anything else", async () => {
    // The guard that stops a plaintext or differently-hashed password being
    // treated as a valid credential.
    const real = await bcrypt.hash("correct1horse", 10);
    expect(isBcryptHash(real)).toBe(true);
    for (const bad of ["", "plaintext", "!", "$2z$10$notreal", "md5:abc"]) {
      expect(isBcryptHash(bad)).toBe(false);
    }
  });
});
