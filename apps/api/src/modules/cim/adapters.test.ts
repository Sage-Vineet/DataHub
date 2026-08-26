import { describe, expect, it } from "vitest";
import type { Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import type { QaService } from "../qa/index.js";
import { DrizzleCimDataRoomPort, QaServiceAdapter } from "./adapters.js";

/**
 * The seams between the CIM and the rest of the product.
 *
 * Both are thin on purpose, and both had gone untested — which is how the
 * defect named in `QaServiceAdapter`'s own comment got in: an actor built with
 * an empty id reaches Postgres as an empty uuid parameter and the query fails
 * outright.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu";

const actorFor = (companyId: string, userId: string): SessionUser => ({
  id: userId,
  name: "Acting",
  email: "acting@example.test",
  role: "broker",
  company_id: companyId,
  status: "active",
  company_ids: [companyId],
});

interface Item {
  id: string;
  body: string;
  external_ref: string | null;
  answered_at: string | null;
}

interface Response {
  id: string;
  kind: string;
  is_current: boolean;
  body: string;
  author_id: string;
  author_name: string;
  posted_at: string;
}

function qaStub(over: { items?: Item[]; responses?: Record<string, Response[]> } = {}) {
  const calls: Array<{ method: string; actor: SessionUser; args: unknown[] }> = [];
  const items = over.items ?? [];
  const qa = {
    createItem: (actor: SessionUser, companyId: string, body: unknown) => {
      calls.push({ method: "createItem", actor, args: [companyId, body] });
      return Promise.resolve({ id: `item-${calls.length}` });
    },
    listItems: (actor: SessionUser, companyId: string) => {
      calls.push({ method: "listItems", actor, args: [companyId] });
      return Promise.resolve(items);
    },
    getItem: (actor: SessionUser, id: string) => {
      calls.push({ method: "getItem", actor, args: [id] });
      return Promise.resolve({ responses: over.responses?.[id] ?? [] });
    },
  } as unknown as QaService;
  return { qa, calls, adapter: new QaServiceAdapter(qa, actorFor) };
}

const answer = (over: Partial<Response> = {}): Response => ({
  id: "r-1",
  kind: "answer",
  is_current: true,
  body: "the seller's own words",
  author_id: "seller-1",
  author_name: "Sam Seller",
  posted_at: "2026-08-20T10:00:00.000Z",
  ...over,
});

describe("raising CIM questions in the Q&A module", () => {
  it("acts as the person who clicked, not as a placeholder", async () => {
    // An empty id here reaches Postgres as an empty uuid parameter and the
    // query fails outright, which is how this was found.
    const { adapter, calls } = qaStub();
    await adapter.createItems({
      companyId: COMPANY,
      createdBy: USER,
      items: [{ title: "Revenue split", text: "By segment?", sectionKey: "financials", externalRef: "b-1" }],
    });
    expect(calls[0]!.actor.id).toBe(USER);
  });

  it("carries provenance the Q&A module records but never interprets", async () => {
    const { adapter, calls } = qaStub();
    await adapter.createItems({
      companyId: COMPANY,
      createdBy: USER,
      items: [{ title: "Revenue split", text: "By segment?", sectionKey: "financials", externalRef: "b-1" }],
    });
    expect(calls[0]!.args[1]).toMatchObject({
      origin: "cim_guided",
      module_tag: "CM",
      section_tag: "financials",
      external_ref: "b-1",
    });
  });

  it("assigns only when somebody was named", async () => {
    // An empty `requestee_ids` and an absent one are different things to the
    // Q&A module: one assigns to nobody, the other leaves assignment alone.
    const { adapter, calls } = qaStub();
    await adapter.createItems({
      companyId: COMPANY,
      createdBy: USER,
      items: [
        { title: "A", text: "?", sectionKey: "s", externalRef: "b-1", assigneeUserId: "seller-1" },
        { title: "B", text: "?", sectionKey: "s", externalRef: "b-2" },
      ],
    });
    expect(calls[0]!.args[1]).toMatchObject({ requestee_ids: ["seller-1"] });
    expect(calls[1]!.args[1]).not.toHaveProperty("requestee_ids");
  });

  it("returns one id per block, in the order asked", async () => {
    const { adapter } = qaStub();
    const made = await adapter.createItems({
      companyId: COMPANY,
      createdBy: USER,
      items: [
        { title: "A", text: "?", sectionKey: "s", externalRef: "b-1" },
        { title: "B", text: "?", sectionKey: "s", externalRef: "b-2" },
      ],
    });
    expect(made.map((m) => m.externalRef)).toEqual(["b-1", "b-2"]);
  });
});

describe("reading answers back for a deck", () => {
  it("asks the Q&A module nothing when no block was named", async () => {
    // A deck with no questions raised must not turn into a full item listing
    // that is then thrown away.
    const { adapter, calls } = qaStub();
    expect(await adapter.listAnswers({ companyId: COMPANY, actingUserId: USER, externalRefs: [] })).toEqual([]);
    expect(await adapter.outstandingCount({ companyId: COMPANY, actingUserId: USER, externalRefs: [] })).toBe(0);
    expect(calls).toEqual([]);
  });

  it("takes only the current answers on the blocks asked about", async () => {
    const { adapter } = qaStub({
      items: [
        { id: "i-1", body: "By segment?", external_ref: "b-1", answered_at: "2026-08-20" },
        { id: "i-2", body: "Elsewhere", external_ref: "b-9", answered_at: null },
        { id: "i-3", body: "Not a CIM question", external_ref: null, answered_at: null },
      ],
      responses: {
        "i-1": [
          answer({ id: "r-old", is_current: false, body: "superseded" }),
          answer({ id: "r-note", kind: "comment", body: "a broker's note" }),
          answer({ id: "r-now" }),
        ],
        "i-2": [answer({ id: "r-other" })],
      },
    });

    const out = await adapter.listAnswers({
      companyId: COMPANY,
      actingUserId: USER,
      externalRefs: ["b-1"],
    });

    expect(out).toEqual([
      {
        itemId: "i-1",
        responseId: "r-now",
        externalRef: "b-1",
        questionText: "By segment?",
        answerText: "the seller's own words",
        respondentId: "seller-1",
        respondentName: "Sam Seller",
        submittedAt: "2026-08-20T10:00:00.000Z",
      },
    ]);
  });

  it("counts only the unanswered questions on this deck", async () => {
    const { adapter } = qaStub({
      items: [
        { id: "i-1", body: "?", external_ref: "b-1", answered_at: null },
        { id: "i-2", body: "?", external_ref: "b-2", answered_at: "2026-08-20" },
        { id: "i-3", body: "?", external_ref: "b-9", answered_at: null },
        { id: "i-4", body: "?", external_ref: null, answered_at: null },
      ],
    });
    expect(
      await adapter.outstandingCount({
        companyId: COMPANY,
        actingUserId: USER,
        externalRefs: ["b-1", "b-2"],
      }),
    ).toBe(1);
  });
});

describe("publishing a deck into the data room", () => {
  it("refuses before writing anything when the company has nowhere to put it", async () => {
    // Ordered deliberately: the folder is resolved first, so a company with no
    // destination does not leave an orphaned blob behind.
    const port = new DrizzleCimDataRoomPort({} as Db, () => Promise.resolve(null));
    await expect(
      port.publishDocument({
        companyId: COMPANY,
        name: "Project Atlas CIM v1.pdf",
        bytes: Buffer.from("%PDF-1.4"),
        contentType: "application/pdf",
        uploadedBy: USER,
      }),
    ).rejects.toThrow(/no destination folder/i);
  });
});
