import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reports as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { LegacyReportSyncPort } from "./adapters.js";
import { InMemoryReportsRepository } from "./repository.memory.js";
import { ReportsService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryReportsRepository();
  return { repo, service: new ReportsService({ repo, sync: new LegacyReportSyncPort() }) };
}
const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(), name: "U", email: "u@x.com", role: "broker", company_id: null, status: "active", company_ids: [COMPANY], ...over,
});

describe("ReportsService — version lifecycle", () => {
  it("auto-numbers, updates, duplicates (new draft), and deletes", async () => {
    const { service } = make();
    const user = session();
    const v1 = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY, version_name: "First" }));
    const v2 = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    expect(v1.version_number).toBe(1);
    expect(v2.version_number).toBe(2);

    const updated = await service.update(user, v1.id, contracts.reportVersionUpdate.parse({ status: "synced" }));
    expect(updated.status).toBe("synced");

    const dup = await service.duplicate(user, v1.id);
    expect(dup.version_number).toBe(3);
    expect(dup.is_active).toBe(false);
    expect(dup.version_name).toBe("First");

    await service.delete(user, v2.id);
    await expect(service.get(user, v2.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps exactly one active version per company", async () => {
    const { service } = make();
    const user = session();
    const a = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    const b = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));

    await service.activate(user, a.id);
    let list = await service.list(user, COMPANY);
    expect(list.filter((v) => v.is_active).map((v) => v.id)).toEqual([a.id]);

    await service.activate(user, b.id);
    list = await service.list(user, COMPANY);
    expect(list.filter((v) => v.is_active).map((v) => v.id)).toEqual([b.id]); // a deactivated
  });

  it("denies cross-tenant and 501s the deferred sync", async () => {
    const { service } = make();
    const v = await service.create(session(), contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    await expect(service.get(session({ role: "buyer", company_ids: [OTHER] }), v.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.sync(session(), v.id)).rejects.toMatchObject({ status: 501 });
  });
});
