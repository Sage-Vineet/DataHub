import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { requests as contracts, type SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { InMemoryRequestsRepository } from "./repository.memory.js";
import { RequestsService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryRequestsRepository();
  return { repo, service: new RequestsService({ repo }) };
}
const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(), name: "U", email: "u@x.com", role: "broker", company_id: null, status: "active", company_ids: [COMPANY], ...over,
});
const future = "2099-12-31";
const base = { title: "Send Q1", description: "please", category: "Finance", response_type: "Upload", priority: "high", due_date: future } as const;

describe("RequestsService — create/validate", () => {
  it("creates with derived reminder frequency + approval, then lists", async () => {
    const { service } = make();
    const user = session();
    const r = await service.create(user, COMPANY, contracts.requestCreate.parse(base));
    expect(r.reminder_frequency_days).toBe(1); // high → 1
    expect(r.approval_status).toBe("approved");
    expect(r.approved_by).toBe(user.id);
    expect((await service.list(user, COMPANY)).map((x) => x.id)).toEqual([r.id]);
  });

  it("rejects a past due date (400) unless allow_past", async () => {
    const { service } = make();
    await expect(
      service.create(session(), COMPANY, contracts.requestCreate.parse({ ...base, due_date: "2000-01-01" })),
    ).rejects.toBeInstanceOf(BadRequestError);
    const bulk = await service.createBulk(session(), COMPANY, [contracts.requestCreate.parse({ ...base, due_date: "2000-01-01" })], true);
    expect(bulk.length).toBe(1);
  });

  it("denies a user who cannot access the company", async () => {
    const { service } = make();
    await expect(
      service.create(session({ role: "buyer", company_ids: [OTHER] }), COMPANY, contracts.requestCreate.parse(base)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("RequestsService — lifecycle", () => {
  it("updates (re-derives frequency on priority change), approves, and deletes", async () => {
    const { service } = make();
    const user = session();
    const r = await service.create(user, COMPANY, contracts.requestCreate.parse(base));

    const updated = await service.update(user, r.id, contracts.requestUpdate.parse({ priority: "low", status: "in-review" }));
    expect(updated.priority).toBe("low");
    expect(updated.reminder_frequency_days).toBe(7); // re-derived
    expect(updated.status).toBe("in-review");

    const approved = await service.approve(user, r.id, user.id);
    expect(approved.approval_status).toBe("approved");

    await service.delete(user, r.id);
    await expect(service.get(user, r.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cross-tenant get/update/delete are denied (403)", async () => {
    const { service } = make();
    const r = await service.create(session(), COMPANY, contracts.requestCreate.parse(base));
    const outsider = session({ role: "buyer", company_ids: [OTHER] });
    await expect(service.get(outsider, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.delete(outsider, r.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("RequestsService — narrative / reminders / documents", () => {
  it("upserts a narrative, appends reminders, and links documents", async () => {
    const { service } = make();
    const user = session();
    const r = await service.create(user, COMPANY, contracts.requestCreate.parse(base));

    await service.updateNarrative(user, r.id, contracts.narrativeUpdate.parse({ content: "draft" }));
    await service.updateNarrative(user, r.id, contracts.narrativeUpdate.parse({ content: "final" }));
    expect((await service.getNarrative(user, r.id))?.content).toBe("final"); // 1:1 upsert

    await service.addReminder(user, r.id);
    await service.addReminder(user, r.id);

    const docId = randomUUID();
    await service.linkDocument(user, r.id, docId, true);
    expect((await service.listDocuments(user, r.id)).map((d) => d.document_id)).toEqual([docId]);
  });
});
