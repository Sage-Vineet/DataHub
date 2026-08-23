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

describe("RequestsService — the narrative as the detail pane reads it", () => {
  /**
   * `/narrative/file` is the SPA's read path. It differs from `/narrative` in
   * two ways that both matter: it carries the author's name and role for the
   * byline, and it answers 200 with empty content when there is no narrative
   * yet, because the pane renders an empty editor either way.
   */
  it("returns empty content rather than 404 when nothing has been written", async () => {
    const { service } = make();
    const user = session();
    const r = await service.create(user, COMPANY, contracts.requestCreate.parse(base));

    expect(await service.getNarrativeFile(user, r.id)).toEqual({
      content: "",
      author_name: null,
      author_role: null,
      updated_at: null,
    });
    // The sibling endpoint keeps its 404 — asking for the resource is a
    // different question from asking what to render.
    expect(await service.getNarrative(user, r.id)).toBeNull();
  });

  it("carries the author's name and role for the byline", async () => {
    const { repo, service } = make();
    const user = session();
    repo.seedUser(user.id, "Dana Reed", "broker");
    const r = await service.create(user, COMPANY, contracts.requestCreate.parse(base));
    await service.updateNarrative(user, r.id, contracts.narrativeUpdate.parse({ content: "hi" }));

    expect(await service.getNarrativeFile(user, r.id)).toMatchObject({
      content: "hi",
      author_name: "Dana Reed",
      author_role: "broker",
    });
  });

  it("still reads when the author's row has gone", async () => {
    // The query is a LEFT JOIN for exactly this: an unknown author is an
    // anonymous byline, not a missing narrative.
    const { service } = make();
    const user = session();
    const r = await service.create(user, COMPANY, contracts.requestCreate.parse(base));
    await service.updateNarrative(user, r.id, contracts.narrativeUpdate.parse({ content: "orphan" }));

    expect(await service.getNarrativeFile(user, r.id)).toMatchObject({
      content: "orphan",
      author_name: null,
      author_role: null,
    });
  });

  it("refuses a request the caller cannot reach", async () => {
    const { service } = make();
    const r = await service.create(session(), COMPANY, contracts.requestCreate.parse(base));
    await expect(
      service.getNarrativeFile(session({ role: "buyer", company_ids: [OTHER] }), r.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
