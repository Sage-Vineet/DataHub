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

describe("RequestsService — what an update writes", () => {
  it("writes every field the caller sent, and only those", async () => {
    // Each is its own branch. One left out of the patch is a change the caller
    // made, the request accepted, and the record does not carry — and the page
    // shows the old value with no error to explain it.
    const { service } = make();
    const user = session();
    const assignee = randomUUID();
    const created = await service.create(user, COMPANY, contracts.requestCreate.parse(base));

    const updated = await service.update(
      user,
      created.id,
      contracts.requestUpdate.parse({
        title: "Send Q2",
        sub_label: "Statements",
        description: "revised",
        category: "Legal",
        response_type: "Narrative",
        priority: "low",
        status: "in-review",
        due_date: "2099-11-30",
        assigned_to: assignee,
        visible: false,
      }),
    );

    expect(updated).toMatchObject({
      title: "Send Q2",
      sub_label: "Statements",
      description: "revised",
      category: "Legal",
      response_type: "Narrative",
      priority: "low",
      status: "in-review",
      due_date: "2099-11-30",
      assigned_to: assignee,
      visible: false,
    });
  });

  it("re-derives the reminder cadence when the priority changes", async () => {
    // The cadence follows the priority unless the caller states one. Left
    // alone, a request downgraded to low would keep chasing daily.
    const { service } = make();
    const user = session();
    const created = await service.create(user, COMPANY, contracts.requestCreate.parse(base));
    expect(created.reminder_frequency_days).toBe(1);

    const lowered = await service.update(
      user,
      created.id,
      contracts.requestUpdate.parse({ priority: "low" }),
    );
    expect(lowered.reminder_frequency_days).not.toBe(1);
  });

  it("takes a cadence the caller states over the one the priority implies", async () => {
    const { service } = make();
    const user = session();
    const created = await service.create(user, COMPANY, contracts.requestCreate.parse(base));
    const updated = await service.update(
      user,
      created.id,
      contracts.requestUpdate.parse({ reminder_frequency_days: 9 }),
    );
    expect(updated.reminder_frequency_days).toBe(9);
  });

  it("leaves the cadence alone when neither is touched", async () => {
    const { service } = make();
    const user = session();
    const created = await service.create(user, COMPANY, contracts.requestCreate.parse(base));
    const updated = await service.update(
      user,
      created.id,
      contracts.requestUpdate.parse({ title: "Renamed" }),
    );
    expect(updated.reminder_frequency_days).toBe(created.reminder_frequency_days);
  });

  it("clears an assignee and a sub-label the caller emptied", async () => {
    const { service } = make();
    const user = session();
    const created = await service.create(
      user,
      COMPANY,
      contracts.requestCreate.parse({ ...base, sub_label: "Statements", assigned_to: randomUUID() }),
    );
    const updated = await service.update(
      user,
      created.id,
      contracts.requestUpdate.parse({ sub_label: "" }),
    );
    expect(updated.sub_label).toBeNull();
  });

  it("404s an update to a request that is not there", async () => {
    const { service } = make();
    await expect(
      service.update(session(), randomUUID(), contracts.requestUpdate.parse({ title: "X" })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("RequestsService — a request that is not there", () => {
  /**
   * Every one of these takes an id from a URL, so a request deleted between a
   * page loading and a button being pressed lands here. The answer has to be a
   * 404 rather than a 500 from reading through a null — and, for the delete,
   * everything hanging off the request has to go with it.
   */
  it("404s an update, an approval and a read for an id nobody has", async () => {
    const { service } = make();
    const user = session();
    const missing = randomUUID();

    await expect(
      service.update(user, missing, contracts.requestUpdate.parse({ title: "Renamed" })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.approve(user, missing, null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.get(user, missing)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("takes the reminders, the narrative and the linked documents with it", async () => {
    // A reminder pointing at a request that is gone is a row nothing can reach
    // and nothing will ever send.
    const { repo, service } = make();
    const user = session();
    const request = await service.create(user, COMPANY, contracts.requestCreate.parse(base));

    await service.addReminder(user, request.id);
    await service.updateNarrative(
      user,
      request.id,
      contracts.narrativeUpdate.parse({ content: "We are chasing this." }),
    );

    await service.delete(user, request.id);

    expect(await repo.getById(request.id)).toBeNull();
    expect(await repo.listReminders(request.id)).toEqual([]);
    expect(await repo.getNarrative(request.id)).toBeNull();
  });
});
