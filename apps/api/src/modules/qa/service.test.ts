import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { QaStore, memoryQa, unavailableDataRoom } from "./repository.memory.js";
import { QaService } from "./service.js";
import type { QaActivityPort } from "./ports.js";

const CO = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_CO = "aaaaaaaa-0000-4000-8000-000000000002";

const broker: SessionUser = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  name: "Blake Broker",
  email: "broker@x.test",
  role: "broker",
  company_id: CO,
  status: "active",
  company_ids: [CO],
};
const seller: SessionUser = {
  ...broker,
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  name: "Dana Seller",
  role: "buyer",
};
const cfo: SessionUser = {
  ...broker,
  id: "bbbbbbbb-0000-4000-8000-000000000003",
  name: "Casey CFO",
  role: "buyer",
};
const outsider: SessionUser = {
  ...broker,
  id: "bbbbbbbb-0000-4000-8000-000000000009",
  company_id: OTHER_CO,
  company_ids: [OTHER_CO],
};

let store: QaStore;
let service: QaService;
let emitted: string[];

beforeEach(() => {
  const ports = memoryQa();
  store = ports.store;
  emitted = [];
  const activity: QaActivityPort = { emit: (e) => emitted.push(e.type) };
  service = new QaService({ ...ports, activity });
  store.addMember(CO, broker.id, "Blake Broker");
  store.addMember(CO, seller.id, "Dana Seller");
  store.addMember(CO, cfo.id, "Casey CFO");
});

async function categoryId(key: string): Promise<string> {
  const categories = await service.listCategories(broker, CO);
  return categories.find((c) => c.key === key)!.id;
}

async function ask(overrides: Partial<Parameters<QaService["createItem"]>[2]> = {}) {
  return service.createItem(broker, CO, {
    title: "Explain the Q3 swing",
    body: "Revenue moved 18% — why?",
    priority: "medium",
    ...overrides,
  });
}

describe("categories", () => {
  it("provisions a company's categories on first use", async () => {
    // The migration could only backfill companies that existed when it ran, so
    // anything created afterwards has to get them here.
    const categories = await service.listCategories(broker, CO);

    expect(categories.map((c) => c.key)).toEqual([
      "finance",
      "legal",
      "compliance",
      "hr",
      "tax",
      "ma",
      "other",
    ]);
  });

  it("does not duplicate them on a second read", async () => {
    await service.listCategories(broker, CO);

    const second = await service.listCategories(broker, CO);

    expect(second).toHaveLength(7);
  });

  it("refuses categories for a deal the caller cannot reach", async () => {
    await expect(service.listCategories(outsider, CO)).rejects.toThrow(/do not have access/i);
  });
});

describe("seller nomination", () => {
  it("assigns a category's nominee without the asker naming anyone", async () => {
    const finance = await categoryId("finance");
    await service.replaceNominees(seller, CO, finance, { user_ids: [cfo.id] });

    const item = await ask({ category_id: finance });

    expect(item.assignees.map((a) => a.user_id)).toEqual([cfo.id]);
  });

  it("lets an explicit assignment override the nomination", async () => {
    const finance = await categoryId("finance");
    await service.replaceNominees(seller, CO, finance, { user_ids: [cfo.id] });

    const item = await ask({ category_id: finance, requestee_ids: [seller.id] });

    expect(item.assignees.map((a) => a.user_id)).toEqual([seller.id]);
  });

  it("treats the nomination as a default, not a lock", async () => {
    const finance = await categoryId("finance");
    await service.replaceNominees(seller, CO, finance, { user_ids: [cfo.id] });
    const item = await ask({ category_id: finance });

    const reassigned = await service.replaceAssignees(seller, item.id, {
      user_ids: [seller.id],
      kind: "delegate",
    });

    expect(reassigned.assignees.map((a) => a.user_id)).toEqual([seller.id]);
  });

  it("replaces the nominee set wholesale rather than accumulating", async () => {
    const finance = await categoryId("finance");
    await service.replaceNominees(seller, CO, finance, { user_ids: [cfo.id] });

    const after = await service.replaceNominees(seller, CO, finance, { user_ids: [seller.id] });

    const category = after.find((c) => c.key === "finance")!;
    expect(category.nominees.map((n) => n.user_id)).toEqual([seller.id]);
  });

  it("refuses to nominate someone who is not on the deal", async () => {
    const finance = await categoryId("finance");

    await expect(
      service.replaceNominees(seller, CO, finance, { user_ids: [outsider.id] }),
    ).rejects.toThrow(/on this deal/i);
  });
});

describe("assignment", () => {
  it("refuses to assign someone off the deal", async () => {
    const item = await ask();

    await expect(
      service.replaceAssignees(broker, item.id, { user_ids: [outsider.id], kind: "requestee" }),
    ).rejects.toThrow(/on this deal/i);
  });

  it("lets any deal member reassign, not just the asker", async () => {
    // QA-0001 is explicit about this: items stall when the wrong person holds
    // them and only the wrong person can hand them on.
    const item = await ask({ requestee_ids: [seller.id] });

    const moved = await service.replaceAssignees(cfo, item.id, {
      user_ids: [cfo.id],
      kind: "requestee",
    });

    expect(moved.assignees.map((a) => a.user_id)).toEqual([cfo.id]);
  });

  it("records who moved it, when, and from what to what", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    await service.replaceAssignees(cfo, item.id, { user_ids: [cfo.id], kind: "delegate" });

    const detail = await service.getItem(broker, item.id);

    const last = detail.history.at(-1)!;
    expect(last.action).toBe("delegated");
    expect(last.prior_user_ids).toEqual([seller.id]);
    expect(last.new_user_ids).toEqual([cfo.id]);
    expect(last.actor_id).toBe(cfo.id);
  });

  it("records an assignment change on the audit trail", async () => {
    const item = await ask();
    emitted.length = 0;

    await service.replaceAssignees(broker, item.id, { user_ids: [seller.id], kind: "requestee" });

    expect(emitted).toContain("qa.assignment.changed");
  });
});

describe("filtering by relationship", () => {
  it("separates items I raised from items assigned to me", async () => {
    const mine = await ask({ requestee_ids: [seller.id] });
    void mine;

    const raisedByBroker = await service.listItems(broker, CO, { mine: "requestor" });
    const assignedToSeller = await service.listItems(seller, CO, { mine: "requestee" });
    const assignedToBroker = await service.listItems(broker, CO, { mine: "requestee" });

    expect(raisedByBroker).toHaveLength(1);
    expect(assignedToSeller).toHaveLength(1);
    expect(assignedToBroker).toHaveLength(0);
  });

  it("filters by category and status", async () => {
    const finance = await categoryId("finance");
    const legal = await categoryId("legal");
    await ask({ category_id: finance });
    await ask({ category_id: legal });

    expect(await service.listItems(broker, CO, { category_id: finance })).toHaveLength(1);
    expect(await service.listItems(broker, CO, { status: "open" })).toHaveLength(2);
    expect(await service.listItems(broker, CO, { status: "closed" })).toHaveLength(0);
  });
});

describe("answers are immutable, and versioned by superseding", () => {
  it("records the date answered on the first answer only", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    await service.postResponse(seller, item.id, { body: "Because of X.", kind: "answer" });
    const afterFirst = await service.getItem(broker, item.id);

    await service.postResponse(seller, item.id, { body: "Also Y.", kind: "answer" });

    const afterSecond = await service.getItem(broker, item.id);
    expect(afterSecond.item.answered_at).toBe(afterFirst.item.answered_at);
  });

  it("keeps both versions readable when an answer is corrected", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const v1 = await service.postResponse(seller, item.id, {
      body: "About 4 million.",
      kind: "answer",
    });

    const v2 = await service.postResponse(seller, item.id, {
      body: "Actually 4.2 million.",
      kind: "answer",
      supersedes_id: v1.id,
    });

    const detail = await service.getItem(broker, item.id);
    expect(detail.responses.map((r) => r.body)).toEqual([
      "About 4 million.",
      "Actually 4.2 million.",
    ]);
    expect(v2.answer_version).toBe(2);
  });

  it("marks exactly one version of an answer current", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const v1 = await service.postResponse(seller, item.id, { body: "first", kind: "answer" });
    await service.postResponse(seller, item.id, {
      body: "second",
      kind: "answer",
      supersedes_id: v1.id,
    });

    const detail = await service.getItem(broker, item.id);

    const lineage = detail.responses.filter((r) => r.answer_root_id === v1.id);
    expect(lineage.filter((r) => r.is_current)).toHaveLength(1);
    expect(lineage.find((r) => r.is_current)!.body).toBe("second");
  });

  it("gives every version its own permanent citation reference", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const v1 = await service.postResponse(seller, item.id, { body: "first", kind: "answer" });

    const v2 = await service.postResponse(seller, item.id, {
      body: "second",
      kind: "answer",
      supersedes_id: v1.id,
    });

    // A narrative citing v1 must keep resolving to what it originally meant.
    expect(v2.citation_ref).not.toBe(v1.citation_ref);
    const detail = await service.getItem(broker, item.id);
    expect(detail.responses.find((r) => r.citation_ref === v1.citation_ref)!.body).toBe("first");
  });

  it("cites a question that predates references by its id", async () => {
    // `qa_items.reference` is nullable, and rows raised before references
    // existed carry none. A citation of "undefined-1" resolves to nothing, and
    // a narrative citing it says nothing a reader can follow.
    const item = await ask({ requestee_ids: [seller.id] });
    const stored = store.items.find((i) => i.id === item.id)!;
    stored.reference = null;

    const posted = await service.postResponse(seller, item.id, { body: "first", kind: "answer" });

    expect(posted.citation_ref).toContain(item.id.slice(0, 8));
    expect(posted.citation_ref).not.toContain("undefined");
  });

  it("refuses to correct an answer on a different question", async () => {
    const a = await ask({ requestee_ids: [seller.id] });
    const b = await ask({ requestee_ids: [seller.id] });
    const onA = await service.postResponse(seller, a.id, { body: "x", kind: "answer" });

    await expect(
      service.postResponse(seller, b.id, { body: "y", kind: "answer", supersedes_id: onA.id }),
    ).rejects.toThrow(/not on this question/i);
  });

  it("stops one party rewriting another's answer through a supersede", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const sellersAnswer = await service.postResponse(seller, item.id, {
      body: "our number",
      kind: "answer",
    });

    await expect(
      service.postResponse(cfo, item.id, {
        body: "no, mine",
        kind: "answer",
        supersedes_id: sellersAnswer.id,
      }),
    ).rejects.toThrow(/only correct your own/i);
  });

  it("records a posted response on the audit trail", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    emitted.length = 0;

    await service.postResponse(seller, item.id, { body: "answer", kind: "answer" });

    expect(emitted).toContain("qa.response.posted");
  });
});

describe("the broker's presentable version", () => {
  it("never touches the seller's words", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, {
      body: "we lost the Henderson account, it was messy",
      kind: "answer",
    });

    await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "A single customer transitioned out during the period.",
    });

    const detail = await service.getItem(broker, item.id);
    expect(detail.responses[0]!.body).toBe("we lost the Henderson account, it was messy");
  });

  it("keeps both visible side by side to the deal team", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });

    await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "polished",
    });

    const detail = await service.getItem(broker, item.id);
    expect(detail.responses[0]!.body).toBe("raw");
    expect(detail.presentations[0]!.body).toBe("polished");
  });

  it("versions rewordings on their own counter", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });
    await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "first pass",
    });

    const second = await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "second pass",
    });

    expect(second.version).toBe(2);
  });

  it("stops a counterparty writing one", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });

    await expect(
      service.writePresentation(seller, item.id, {
        source_response_id: answer.id,
        body: "self-serving",
      }),
    ).rejects.toThrow(/only the deal team/i);
  });

  it("keeps a draft rewording away from the other side until published", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });
    await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "still thinking",
    });

    const asSeller = await service.getItem(seller, item.id);

    // A draft is the broker thinking aloud; only a published one is settled.
    expect(asSeller.presentations).toHaveLength(0);
  });

  it("shows a published rewording to the other side", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });
    const draft = await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "settled wording",
    });

    await service.publishPresentation(broker, item.id, draft.id);

    const asSeller = await service.getItem(seller, item.id);
    expect(asSeller.presentations.map((p) => p.body)).toEqual(["settled wording"]);
  });

  it("records publication on the audit trail", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });
    const draft = await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "final",
    });
    emitted.length = 0;

    await service.publishPresentation(broker, item.id, draft.id);

    expect(emitted).toContain("qa.presentation.published");
  });
});

describe("per-item visibility", () => {
  it("hides an item from a named user without disturbing anything else", async () => {
    const hidden = await ask();
    const visible = await ask();
    await service.setVisibility(broker, hidden.id, { user_id: cfo.id, effect: "hide" });

    const asCfo = await service.listItems(cfo, CO, {});

    expect(asCfo.map((i) => i.id)).toEqual([visible.id]);
  });

  it("makes a hidden item unreachable by id, not merely absent from a list", async () => {
    const hidden = await ask();
    await service.setVisibility(broker, hidden.id, { user_id: cfo.id, effect: "hide" });

    // Reported as missing rather than forbidden: confirming it exists is a leak.
    await expect(service.getItem(cfo, hidden.id)).rejects.toThrow(/not found/i);
  });

  it("hides from a whole role when asked", async () => {
    const hidden = await ask();
    await service.setVisibility(broker, hidden.id, { role_key: "buyer", effect: "hide" });

    expect(await service.listItems(seller, CO, {})).toHaveLength(0);
    expect(await service.listItems(broker, CO, {})).toHaveLength(1);
  });

  it("lets an explicit allow carve one person out of a role-wide hide", async () => {
    const item = await ask();
    await service.setVisibility(broker, item.id, { role_key: "buyer", effect: "hide" });

    await service.setVisibility(broker, item.id, { user_id: seller.id, effect: "allow" });

    expect(await service.listItems(seller, CO, {})).toHaveLength(1);
    expect(await service.listItems(cfo, CO, {})).toHaveLength(0);
  });

  it("stops a counterparty hiding someone else's question", async () => {
    const item = await ask();

    await expect(
      service.setVisibility(seller, item.id, { user_id: cfo.id, effect: "hide" }),
    ).rejects.toThrow(/deal team or the asker/i);
  });
});

describe("attachments", () => {
  it("files an answer's evidence against the item", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "see attached", kind: "answer" });
    store.addDocument({
      id: "dddddddd-0000-4000-8000-000000000001",
      companyId: CO,
      folderId: "eeeeeeee-0000-4000-8000-000000000001",
      name: "aging.xlsx",
    });

    await service.attach(seller, item.id, {
      document_id: "dddddddd-0000-4000-8000-000000000001",
      folder_id: "eeeeeeee-0000-4000-8000-000000000001",
      response_id: answer.id,
    });

    const detail = await service.getItem(broker, item.id);
    expect(detail.responses[0]!.attachments[0]!.name).toBe("aging.xlsx");
  });

  it("names an attachment whose document has gone as nameless, not as broken", async () => {
    // A document deleted from the data room after being cited. The attachment
    // row survives — that is the point of keeping evidence — and the answer
    // still has to render, with the citation showing no name rather than the
    // whole thread failing to load.
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, {
      body: "see attached",
      kind: "answer",
    });
    store.addDocument({
      id: "dddddddd-0000-4000-8000-000000000099",
      companyId: CO,
      folderId: "eeeeeeee-0000-4000-8000-000000000001",
      name: "aging.xlsx",
    });
    await service.attach(seller, item.id, {
      document_id: "dddddddd-0000-4000-8000-000000000099",
      folder_id: "eeeeeeee-0000-4000-8000-000000000001",
      response_id: answer.id,
    });

    // Removed from the data room afterwards, which the attachment row outlives.
    store.documents.delete("dddddddd-0000-4000-8000-000000000099");

    const detail = await service.getItem(broker, item.id);
    expect(detail.responses[0]!.attachments[0]).toMatchObject({
      document_id: "dddddddd-0000-4000-8000-000000000099",
      name: null,
    });
  });

  it("attaches to the current answer when no response is named", async () => {
    // The contract makes response_id optional; the read path does not — an
    // attachment with no response is stored and then never returned. Resolving it
    // here is what stops a caller silently losing evidence.
    const item = await ask({ requestee_ids: [seller.id] });
    await service.postResponse(seller, item.id, { body: "see attached", kind: "answer" });
    store.addDocument({
      id: "dddddddd-0000-4000-8000-000000000011",
      companyId: CO,
      folderId: "eeeeeeee-0000-4000-8000-000000000001",
      name: "lease.pdf",
    });

    await service.attach(seller, item.id, {
      document_id: "dddddddd-0000-4000-8000-000000000011",
      folder_id: "eeeeeeee-0000-4000-8000-000000000001",
    });

    const detail = await service.getItem(broker, item.id);
    expect(detail.responses[0]!.attachments.map((a) => a.name)).toEqual(["lease.pdf"]);
  });

  it("attaches to the newest answer after a correction, not the superseded one", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    const v1 = await service.postResponse(seller, item.id, { body: "first", kind: "answer" });
    const v2 = await service.postResponse(seller, item.id, {
      body: "corrected",
      kind: "answer",
      supersedes_id: v1.id,
    });
    store.addDocument({
      id: "dddddddd-0000-4000-8000-000000000012",
      companyId: CO,
      folderId: "eeeeeeee-0000-4000-8000-000000000001",
      name: "revised.pdf",
    });

    await service.attach(seller, item.id, {
      document_id: "dddddddd-0000-4000-8000-000000000012",
      folder_id: "eeeeeeee-0000-4000-8000-000000000001",
    });

    const detail = await service.getItem(broker, item.id);
    const withFile = detail.responses.find((r) => r.attachments.length > 0)!;
    expect(withFile.id).toBe(v2.id);
  });

  it("still records evidence attached before anyone has answered", async () => {
    // Not lost — it becomes visible once the first answer lands and is linked.
    const item = await ask({ requestee_ids: [seller.id] });
    store.addDocument({
      id: "dddddddd-0000-4000-8000-000000000013",
      companyId: CO,
      folderId: "eeeeeeee-0000-4000-8000-000000000001",
      name: "early.pdf",
    });

    await expect(
      service.attach(seller, item.id, {
        document_id: "dddddddd-0000-4000-8000-000000000013",
        folder_id: "eeeeeeee-0000-4000-8000-000000000001",
      }),
    ).resolves.toBeUndefined();
    expect(store.attachments).toHaveLength(1);
  });

  it("refuses a document belonging to a different deal", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    store.addDocument({
      id: "dddddddd-0000-4000-8000-000000000002",
      companyId: OTHER_CO,
      folderId: "eeeeeeee-0000-4000-8000-000000000002",
      name: "someone-elses.xlsx",
    });

    await expect(
      service.attach(seller, item.id, {
        document_id: "dddddddd-0000-4000-8000-000000000002",
        folder_id: "eeeeeeee-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow(/different deal/i);
  });

  it("reports the data room as unavailable rather than failing everything else", async () => {
    // The kill switch has to subtract one capability, not take a neighbour with it.
    const ports = memoryQa(store);
    const withoutDataRoom = new QaService({ ...ports, dataRoom: unavailableDataRoom });
    const item = await withoutDataRoom.createItem(broker, CO, {
      title: "t",
      body: "b",
      priority: "medium",
    });

    await expect(
      withoutDataRoom.attach(broker, item.id, {
        document_id: "dddddddd-0000-4000-8000-000000000003",
        folder_id: "eeeeeeee-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow(/data room is not available/i);
    // Everything else still works.
    await expect(
      withoutDataRoom.postResponse(broker, item.id, { body: "text answer", kind: "answer" }),
    ).resolves.toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("refuses to list another deal's questions", async () => {
    await expect(service.listItems(outsider, CO, {})).rejects.toThrow(/do not have access/i);
  });

  it("refuses to read another deal's question by id", async () => {
    const item = await ask();

    await expect(service.getItem(outsider, item.id)).rejects.toThrow(/do not have access/i);
  });

  it("records item creation on the audit trail", async () => {
    await ask();

    expect(emitted).toContain("qa.item.created");
  });
});

describe("who may be put on a question", () => {
  it("refuses a nominee who is not on the deal", async () => {
    // The nominee list decides who gets chased for an answer; naming an
    // outsider would make them accountable for a deal they cannot see.
    const cat = await categoryId("finance");
    await expect(
      service.replaceNominees(broker, CO, cat, { user_ids: [outsider.id] }),
    ).rejects.toThrow(/on this deal/i);
  });

  it("refuses a nomination aimed at a deal the caller is not on", async () => {
    // Access is checked before the category is even resolved, so a category id
    // borrowed from another tenant is refused at the door rather than 404ing —
    // which also means the response says nothing about whether it exists.
    const cat = await categoryId("finance");
    await expect(
      service.replaceNominees(broker, OTHER_CO, cat, { user_ids: [broker.id] }),
    ).rejects.toThrow(/access to this deal/i);
  });

  it("refuses a requestee who is not on the deal", async () => {
    await expect(ask({ requestee_ids: [outsider.id] })).rejects.toThrow(/on this deal/i);
  });

  it("rejects a category from another deal when asking", async () => {
    const cat = await categoryId("finance");
    const service2 = service;
    await expect(
      service2.createItem(broker, OTHER_CO, {
        title: "Cross-tenant",
        body: "x",
        priority: "medium",
        category_id: cat,
      }),
    ).rejects.toThrow();
  });

  it("falls back to the category's nominees when no requestee is named", async () => {
    // The point of nominating: a question filed under a category lands on
    // whoever owns it, without the asker choosing each time.
    const cat = await categoryId("finance");
    await service.replaceNominees(broker, CO, cat, { user_ids: [cfo.id] });

    const item = await ask({ category_id: cat });
    expect(item.assignees.map((a) => a.user_id)).toContain(cfo.id);
  });
});

describe("editing a question", () => {
  it("applies only the fields present in the patch", async () => {
    const item = await ask();
    const updated = await service.updateItem(broker, item.id, { title: "Reworded" });

    expect(updated.title).toBe("Reworded");
    // Everything unnamed is untouched, rather than reset to a default.
    expect(updated.body).toBe("Revenue moved 18% — why?");
    expect(updated.priority).toBe("medium");
  });

  it("can change priority, status and due date", async () => {
    const item = await ask();
    const updated = await service.updateItem(broker, item.id, {
      priority: "high",
      status: "answered",
      due_date: "2099-01-01",
    });
    expect(updated).toMatchObject({ priority: "high", status: "answered" });
  });

  it("404s a question that does not exist", async () => {
    await expect(
      service.updateItem(broker, "11111111-0000-4000-8000-000000000000", { title: "x" }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses an edit from someone outside the deal", async () => {
    const item = await ask();
    await expect(service.updateItem(outsider, item.id, { title: "x" })).rejects.toThrow();
  });
});

describe("editing a question — the fields nothing else reaches", () => {
  it("rewrites the body without touching the title", async () => {
    const item = await ask();
    const updated = await service.updateItem(broker, item.id, { body: "Rewritten." });
    expect(updated.body).toBe("Rewritten.");
    expect(updated.title).toBe("Explain the Q3 swing");
  });

  it("moves a question to another category, and relabels it", async () => {
    // The label travels with the row so the list does not need a join. Left
    // behind, the question would show under its old heading with a new
    // category id — visibly wrong to a reader and invisible to a query.
    const item = await ask();
    const finance = await categoryId("finance");
    const updated = await service.updateItem(broker, item.id, { category_id: finance });
    expect(updated.category_id).toBe(finance);
    expect(updated.category_label).toBeTruthy();
  });

  it("takes a question out of every category", async () => {
    const finance = await categoryId("finance");
    const item = await ask({ category_id: finance });
    const updated = await service.updateItem(broker, item.id, { category_id: null });
    expect(updated.category_id).toBeNull();
    expect(updated.category_label).toBeNull();
  });

  it("stamps the closing time when a question is closed", async () => {
    const item = await ask();
    const closed = await service.updateItem(broker, item.id, { status: "closed" });
    expect(closed.closed_at).toBeTruthy();
  });

  it("clears the closing time when a closed question is reopened", async () => {
    // Left behind, the question reads as open and closed at once, and any
    // report counting closed items by `closed_at` double counts it.
    const item = await ask();
    await service.updateItem(broker, item.id, { status: "closed" });
    const reopened = await service.updateItem(broker, item.id, { status: "open" });
    expect(reopened.closed_at).toBeNull();
  });

  it("clears a due date", async () => {
    const item = await ask({ due_date: "2099-01-01" });
    const updated = await service.updateItem(broker, item.id, { due_date: null });
    expect(updated.due_date).toBeNull();
  });

  it("refuses a category belonging to another company", async () => {
    // Categories are per company. Accepting one from elsewhere files a
    // question under a heading its own deal cannot see.
    const item = await ask();
    await expect(
      service.updateItem(broker, item.id, {
        category_id: "99999999-0000-4000-8000-000000000999",
      }),
    ).rejects.toThrow();
  });
});

describe("listing what is mine", () => {
  it("answers only the questions this user asked", async () => {
    const mine = await ask();
    store.addMember(CO, cfo.id, "Casey CFO");
    await service.createItem(cfo, CO, { title: "Theirs", body: "b", priority: "low" });

    const asRequestor = await service.listItems(broker, CO, { mine: "requestor" });
    expect(asRequestor.map((i) => i.id)).toEqual([mine.id]);
  });

  it("keeps another company's questions out of the list entirely", async () => {
    await ask();
    expect(await service.listItems(outsider, OTHER_CO, {})).toEqual([]);
  });
});

describe("a presentable version that names the wrong thing", () => {
  const MISSING = "99999999-0000-4000-8000-000000000999";

  it("refuses an answer that is not on this question", async () => {
    // The presentable version cites the answer it was written from. Citing one
    // from a different question puts a seller's words on a page they never
    // answered.
    const item = await ask({ requestee_ids: [seller.id] });
    const other = await ask({ requestee_ids: [seller.id] });
    const elsewhere = await service.postResponse(seller, other.id, {
      body: "About something else.",
      kind: "answer",
    });

    await expect(
      service.writePresentation(broker, item.id, {
        source_response_id: elsewhere.id,
        body: "Tidied.",
      }),
    ).rejects.toThrow(/not on this question/i);
  });

  it("refuses an answer nobody has", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    await expect(
      service.writePresentation(broker, item.id, { source_response_id: MISSING, body: "x" }),
    ).rejects.toThrow(/not on this question/i);
  });

  it("refuses to publish one that is not on this question", async () => {
    const item = await ask({ requestee_ids: [seller.id] });
    await expect(service.publishPresentation(broker, item.id, MISSING)).rejects.toThrow(
      /not found/i,
    );
  });

  it("refuses to publish from the seller's side", async () => {
    // Publishing is what a buyer sees. Only the deal team decides that.
    const item = await ask({ requestee_ids: [seller.id] });
    const answer = await service.postResponse(seller, item.id, { body: "raw", kind: "answer" });
    const draft = await service.writePresentation(broker, item.id, {
      source_response_id: answer.id,
      body: "Tidied.",
    });

    await expect(service.publishPresentation(seller, item.id, draft.id)).rejects.toThrow(
      /deal team/i,
    );
  });
});

describe("the audit trail", () => {
  it("tells a correction apart from a first answer and from a comment", async () => {
    // Three different things happened, and a reader scanning the history has
    // only the label to tell them apart.
    const item = await ask({ requestee_ids: [seller.id] });
    const first = await service.postResponse(seller, item.id, { body: "One", kind: "answer" });
    await service.postResponse(seller, item.id, {
      body: "Two",
      kind: "answer",
      supersedes_id: first.id,
    });
    await service.postResponse(broker, item.id, { body: "Noted.", kind: "comment" });

    const kinds = (await service.audit(broker, item.id)).entries.map((e) => e.kind);
    expect(kinds).toContain("asked");
    expect(kinds).toContain("answered");
    expect(kinds).toContain("corrected");
    expect(kinds).toContain("commented");
  });
});

describe("attaching a file", () => {
  it("404s a document nobody has", async () => {
    const item = await ask();
    await expect(
      service.attach(broker, item.id, {
        document_id: "11111111-0000-4000-8000-000000000000",
        folder_id: "22222222-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("a category from somewhere else", () => {
  const MISSING = "88888888-0000-4000-8000-000000000888";

  it("cannot be used when asking a question", async () => {
    // Categories are per deal. A question filed under another deal's category
    // sits under a heading its own deal cannot see.
    await expect(
      service.createItem(broker, CO, {
        title: "Explain the swing",
        body: "Why?",
        priority: "medium",
        category_id: MISSING,
      }),
    ).rejects.toThrow(/does not belong to this deal/i);
  });

  it("cannot have its nominees replaced", async () => {
    await expect(
      service.replaceNominees(seller, CO, MISSING, { user_ids: [cfo.id] }),
    ).rejects.toThrow(/not found on this deal/i);
  });
});

describe("asking with a category that has no nominee", () => {
  it("assigns nobody rather than failing", async () => {
    // A category nobody has been nominated for is a normal state — the deal
    // team fills those in as they go — and a question raised against one must
    // still be raised.
    const finance = await categoryId("finance");
    const item = await service.createItem(broker, CO, {
      title: "Explain the swing",
      body: "Why?",
      priority: "medium",
      category_id: finance,
    });
    expect(item.assignees).toEqual([]);
  });
});
