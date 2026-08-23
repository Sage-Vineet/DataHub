import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { companies as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { InMemoryCompaniesRepository } from "./repository.memory.js";
import { CompaniesService } from "./service.js";
import type {
  CompanyRecord,
  CompanyStats,
  CompanyStatsPort,
  FolderProvisioningPort,
  UserProvisioningPort,
} from "./ports.js";

class FakeStats implements CompanyStatsPort {
  seed = new Map<string, CompanyStats>();
  async countsFor(ids: readonly string[]) {
    const m = new Map<string, CompanyStats>();
    for (const id of ids) m.set(id, this.seed.get(id) ?? { total: 0, pending: 0, completed: 0 });
    return m;
  }
}
class FakeFolders implements FolderProvisioningPort {
  calls: Array<{ companyId: string; createdBy: string }> = [];
  async ensureDefaultFolders(companyId: string, createdBy: string) {
    this.calls.push({ companyId, createdBy });
  }
}
class FakeUsers implements UserProvisioningPort {
  calls: Array<{ email: string | null; previous?: string | null }> = [];
  async syncClientRepresentative(
    company: { contactEmail: string | null },
    previous?: { contactEmail: string | null },
  ) {
    this.calls.push({ email: company.contactEmail, previous: previous?.contactEmail });
  }
}

function makeService() {
  const repo = new InMemoryCompaniesRepository();
  const stats = new FakeStats();
  const folders = new FakeFolders();
  const users = new FakeUsers();
  const service = new CompaniesService({ repo, stats, folders, users });
  return { repo, stats, folders, users, service };
}

function record(over: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    id: randomUUID(),
    name: "Acme",
    projectName: null,
    industry: null,
    status: "active",
    since: null,
    logo: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    profitMetric: "adjusted_ebitda",
    dataSourceType: null,
    quickbooksConnected: false,
    manualUploadActive: false,
    ...over,
  };
}

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
  ...over,
});

describe("CompaniesService — list scoping", () => {
  it("admin sees all; a scoped user sees only their companies", async () => {
    const { repo, service } = makeService();
    const a = repo.seed(record({ name: "A" }));
    const b = repo.seed(record({ name: "B" }));

    const asAdmin = await service.list(user({ role: "admin" }));
    expect(asAdmin.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

    const asClient = await service.list(user({ role: "buyer", company_ids: [a.id] }));
    expect(asClient.map((c) => c.id)).toEqual([a.id]);

    const noneClient = await service.list(user({ role: "buyer", company_ids: [] }));
    expect(noneClient).toEqual([]);
  });

  it("attaches request-count stats", async () => {
    const { repo, stats, service } = makeService();
    const a = repo.seed(record());
    stats.seed.set(a.id, { total: 3, pending: 1, completed: 2 });
    const [c] = await service.list(user({ role: "admin" }));
    expect(c!.request_count).toBe(3);
    expect(c!.pending_request_count).toBe(1);
    expect(c!.completed_request_count).toBe(2);
  });
});

describe("CompaniesService — create", () => {
  it("rejects a client/buyer with 403", async () => {
    const { service } = makeService();
    const input = contracts.companyCreate.parse({ name: "New" });
    await expect(service.create(user({ role: "buyer" }), input)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates, links the creator, provisions folders, syncs the rep, normalizes the metric", async () => {
    const { repo, folders, users, service } = makeService();
    const broker = user({ role: "broker" });
    const input = contracts.companyCreate.parse({
      name: "Acme",
      contact_email: "rep@example.com",
      contact_name: "Rep",
      profit_metric: "ebitda", // alias → adjusted_ebitda
    });
    const created = await service.create(broker, input);

    expect(created.profit_metric).toBe("adjusted_ebitda");
    expect(repo.links.has(`${broker.id}:${created.id}`)).toBe(true);
    expect(folders.calls).toEqual([{ companyId: created.id, createdBy: broker.id }]);
    expect(users.calls).toEqual([{ email: "rep@example.com", previous: undefined }]);
  });

  it("does not sync a rep when no contact email/name is given", async () => {
    const { users, service } = makeService();
    await service.create(user({ role: "broker" }), contracts.companyCreate.parse({ name: "NoRep" }));
    expect(users.calls).toEqual([]);
  });
});

describe("CompaniesService — update", () => {
  it("re-syncs the representative only when the contact email changes", async () => {
    const { repo, users, service } = makeService();
    const c = repo.seed(record({ contactEmail: "old@example.com", contactName: "Rep" }));
    const admin = user({ role: "admin" });

    await service.update(admin, c.id, contracts.companyUpdate.parse({ name: "Renamed" }));
    expect(users.calls).toEqual([]); // no email change → no re-sync

    await service.update(admin, c.id, contracts.companyUpdate.parse({ contact_email: "new@example.com" }));
    expect(users.calls).toEqual([{ email: "new@example.com", previous: "old@example.com" }]);
  });

  it("writes every field the caller sent, and only those", async () => {
    // Each is its own branch. One left out of the patch is a change the caller
    // made, the request accepted, and the record does not carry.
    const { repo, service } = makeService();
    const c = repo.seed(record());
    const updated = await service.update(
      user({ role: "admin" }),
      c.id,
      contracts.companyUpdate.parse({
        name: "Renamed Co",
        project_name: "Project Atlas",
        industry: "Manufacturing",
        status: "inactive",
        since: "2019",
        logo: "https://example.test/logo.png",
        contact_name: "Dana Rep",
        contact_email: "dana@example.com",
        contact_phone: "+1 555 0100",
        profit_metric: "sde",
      }),
    );

    expect(updated).toMatchObject({
      name: "Renamed Co",
      project_name: "Project Atlas",
      industry: "Manufacturing",
      status: "inactive",
      since: "2019",
      logo: "https://example.test/logo.png",
      contact_name: "Dana Rep",
      contact_email: "dana@example.com",
      contact_phone: "+1 555 0100",
      profit_metric: "sde",
    });
  });

  it("clears a field sent empty rather than storing an empty string", async () => {
    // Before this the column held `""` for some companies and NULL for others,
    // and a field could be set but never unset.
    const { repo, service } = makeService();
    const c = repo.seed(
      record({ projectName: "Atlas", industry: "Retail", contactPhone: "+1 555 0100" }),
    );

    await service.update(
      user({ role: "admin" }),
      c.id,
      contracts.companyUpdate.parse({ project_name: "", industry: "", contact_phone: "" }),
    );

    const after = await repo.getById(c.id);
    expect(after).toMatchObject({ projectName: null, industry: null, contactPhone: null });
  });

  it("does not re-sync the representative when the email is unchanged", async () => {
    const { repo, users, service } = makeService();
    const c = repo.seed(record({ contactEmail: "same@example.com", contactName: "Rep" }));
    await service.update(
      user({ role: "admin" }),
      c.id,
      contracts.companyUpdate.parse({ contact_email: "same@example.com" }),
    );
    expect(users.calls).toEqual([]);
  });

  it("never writes integration-managed fields (they are not in the contract)", async () => {
    const { repo, service } = makeService();
    const c = repo.seed(record({ quickbooksConnected: true, dataSourceType: "quickbooks" }));
    await service.update(
      user({ role: "admin" }),
      c.id,
      contracts.companyUpdate.parse({ quickbooks_connected: false, name: "X" } as Record<string, unknown>),
    );
    const after = await repo.getById(c.id);
    expect(after!.quickbooksConnected).toBe(true);
    expect(after!.dataSourceType).toBe("quickbooks");
    expect(after!.name).toBe("X");
  });
});

describe("CompaniesService — access enforcement (parity status codes)", () => {
  it("404 for a missing company, 403 for cross-tenant", async () => {
    const { repo, service } = makeService();
    const c = repo.seed(record());
    await expect(service.get(user({ role: "admin" }), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.get(user({ role: "buyer", company_ids: [] }), c.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("delete requires access and cascades on success", async () => {
    const { repo, service } = makeService();
    const c = repo.seed(record());
    await expect(
      service.delete(user({ role: "buyer", company_ids: [] }), c.id),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await service.delete(user({ role: "admin" }), c.id);
    expect(await repo.getById(c.id)).toBeNull();
  });
});
