import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { users as contracts, type SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { NoopAuthCachePort } from "./adapters.js";
import { InMemoryUsersRepository } from "./repository.memory.js";
import { UsersService } from "./service.js";
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
