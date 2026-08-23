import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { CimStore, memoryCim, unavailableCimDataRoom, unavailableQa } from "./repository.memory.js";
import type { CimServiceDeps } from "./service.js";
import { CimService } from "./service.js";
import type { CimActivityPort } from "./ports.js";

const CO = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_CO = "aaaaaaaa-0000-4000-8000-000000000002";

const broker: SessionUser = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  name: "Blake Broker",
  email: "b@x.test",
  role: "broker",
  company_id: CO,
  status: "active",
  company_ids: [CO],
};
const seller: SessionUser = { ...broker, id: "bbbbbbbb-0000-4000-8000-000000000002", role: "buyer" };
const outsider: SessionUser = { ...broker, company_id: OTHER_CO, company_ids: [OTHER_CO] };

let store: CimStore;
let service: CimService;
let emitted: string[];

/**
 * `CimServiceDeps` directly, rather than reaching through
 * `Parameters<typeof CimService.prototype.constructor>` — that resolves to the
 * base `Function` type, whose parameter list is `never`, so every override was
 * silently unchecked.
 */
function build(overrides: Partial<CimServiceDeps> = {}) {
  const ports = memoryCim(new CimStore());
  store = ports.store;
  emitted = [];
  const activity: CimActivityPort = { emit: (e) => emitted.push(e.type) };
  service = new CimService({ ...ports, activity, ...overrides });
  return ports;
}

async function newDeck() {
  const deck = await service.createDeck(broker, CO, { name: "Project Atlas CIM" });
  return { deck, versionId: deck.current_version_id! };
}

/** First block of the executive-summary section — the demo's usual target. */
async function firstGap(versionId: string) {
  const gaps = await service.gaps(broker, versionId);
  return gaps[0]!;
}

beforeEach(() => {
  build();
});

describe("creating a CIM", () => {
  it("starts from the default section outline", async () => {
    const { versionId } = await newDeck();

    const detail = await service.getVersion(broker, versionId);

    expect(detail.sections.map((s) => s.section_key)).toEqual([
      "executive-summary",
      "business-overview",
      "products-services",
      "market-competition",
      "customers",
      "operations",
      "management",
      "growth",
      "financial-summary",
      "transaction",
      "appendix",
    ]);
  });

  it("gives every slide addressable blocks, so an answer has somewhere to land", async () => {
    const { versionId } = await newDeck();

    const detail = await service.getVersion(broker, versionId);

    const blocks = detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks));
    expect(blocks.length).toBeGreaterThan(20);
    expect(blocks.every((b) => b.block_key.length > 0)).toBe(true);
  });

  it("opens at version 1, in draft", async () => {
    const { deck } = await newDeck();

    expect(deck.current_version_no).toBe(1);
    expect(deck.current_status).toBe("draft");
  });

  it("defaults every block to deal content, unlocked", async () => {
    const { versionId } = await newDeck();

    const detail = await service.getVersion(broker, versionId);

    const blocks = detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks));
    expect(blocks.every((b) => b.content_class === "deal")).toBe(true);
    expect(blocks.every((b) => b.content_class_locked === false)).toBe(true);
  });

  it("records deck creation on the audit trail", async () => {
    await newDeck();

    expect(emitted).toContain("cim.deck.created");
  });
});

describe("who may work on a CIM", () => {
  it("refuses a counterparty, who contributes through Q&A instead", async () => {
    // CM-0001 §5 excludes buyers outright and limits the seller to answering and
    // approving — neither of which goes through the builder.
    await expect(service.listDecks(seller, CO)).rejects.toThrow(/only the deal team/i);
  });

  it("refuses another company's CIMs", async () => {
    await expect(service.listDecks(outsider, CO)).rejects.toThrow(/do not have access/i);
  });

  it("refuses a version belonging to a deal the caller cannot reach", async () => {
    const { versionId } = await newDeck();

    await expect(service.getVersion(outsider, versionId)).rejects.toThrow(/do not have access/i);
  });
});

describe("a published version is frozen", () => {
  async function publishedDeck() {
    const { deck, versionId } = await newDeck();
    await service.publish(broker, versionId, Buffer.from("%PDF-1.7 fake"), {
      contentType: "application/pdf",
      pageCount: 12,
    });
    return { deck, versionId };
  }

  it("refuses to save blocks onto it", async () => {
    const { versionId } = await publishedDeck();

    await expect(
      service.saveBlocks(broker, versionId, { blocks: [{ block_key: "2:headline", content: "x" }] }),
    ).rejects.toThrow(/published and cannot be edited/i);
  });

  it("refuses to generate questions from it", async () => {
    const { versionId } = await publishedDeck();

    await expect(
      service.generate(broker, versionId, {
        questions: [{ block_id: "any", text: "q" }],
      }),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it("forks into a new draft rather than unfreezing", async () => {
    const { deck, versionId } = await publishedDeck();

    const draft = await service.createDraftFrom(broker, deck.id);

    expect(draft.version_no).toBe(2);
    expect(draft.status).toBe("draft");
    const published = await service.getVersion(broker, versionId);
    expect(published.version.status).toBe("published");
  });

  it("carries the published content into the new draft", async () => {
    const { deck, versionId } = await newDeck();
    const gap = await firstGap(versionId);
    await service.saveBlocks(broker, versionId, {
      blocks: [{ block_key: gap.block_key, content: "Written before publication." }],
    });
    await service.publish(broker, versionId, Buffer.from("pdf"), {
      contentType: "application/pdf",
      pageCount: 1,
    });

    const draft = await service.createDraftFrom(broker, deck.id);

    const detail = await service.getVersion(broker, draft.id);
    const carried = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.block_key === gap.block_key);
    expect(carried!.content).toBe("Written before publication.");
  });

  it("keeps the published version retrievable afterwards", async () => {
    const { deck, versionId } = await publishedDeck();
    await service.createDraftFrom(broker, deck.id);

    const versions = await service.listVersions(broker, deck.id);

    expect(versions.map((v) => v.version_no).sort()).toEqual([1, 2]);
    expect(versions.find((v) => v.version_no === 1)!.sha256).toBeTruthy();
    void versionId;
  });

  it("refuses a second open draft, so what is being edited is never ambiguous", async () => {
    const { deck } = await publishedDeck();
    await service.createDraftFrom(broker, deck.id);

    await expect(service.createDraftFrom(broker, deck.id)).rejects.toThrow(/already has an open draft/i);
  });
});

describe("gap analysis", () => {
  it("reports every unfilled block", async () => {
    const { versionId } = await newDeck();

    const gaps = await service.gaps(broker, versionId);

    const detail = await service.getVersion(broker, versionId);
    const total = detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks)).length;
    expect(gaps).toHaveLength(total);
  });

  it("drops a block once it has been written", async () => {
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);

    await service.saveBlocks(broker, versionId, {
      blocks: [{ block_key: gap.block_key, content: "Now answered." }],
    });

    const after = await service.gaps(broker, versionId);
    expect(after.map((g) => g.block_key)).not.toContain(gap.block_key);
  });

  it("treats an empty string as unanswered, not as content", async () => {
    // Otherwise a deck reports itself complete with the slide still blank.
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);

    await service.saveBlocks(broker, versionId, {
      blocks: [{ block_key: gap.block_key, content: "   " }],
    });

    const after = await service.gaps(broker, versionId);
    expect(after.map((g) => g.block_key)).toContain(gap.block_key);
  });

  it("uses the authored label as the question when the library has none", async () => {
    const { versionId } = await newDeck();

    const gaps = await service.gaps(broker, versionId);

    // The labels are already phrased as questions, which is why the library is
    // seeded from them.
    expect(gaps[0]!.question_text).toMatch(/\?$/);
    expect(gaps[0]!.unmapped).toBe(false);
  });

  it("prefers a library question over the label where one is mapped", async () => {
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);
    store.library.push({
      id: "q-1",
      scope: "system",
      sectionKey: gap.section_key,
      blockKeyPattern: gap.block_key,
      questionText: "The firm's preferred wording?",
      helpText: null,
      sortOrder: 1,
    });

    const gaps = await service.gaps(broker, versionId);

    expect(gaps.find((g) => g.block_key === gap.block_key)!.question_text).toBe(
      "The firm's preferred wording?",
    );
  });

  it("flags a block with neither label nor mapped question rather than omitting it", async () => {
    const { versionId } = await newDeck();
    const block = store.blocks.find((b) => b.versionId === versionId)!;
    block.label = null;

    const gaps = await service.gaps(broker, versionId);

    const found = gaps.find((g) => g.block_id === block.id)!;
    expect(found.unmapped).toBe(true);
  });
});

describe("the guided Q&A loop", () => {
  it("creates items in the Q&A module carrying the block as an opaque reference", async () => {
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);

    const result = await service.generate(broker, versionId, {
      questions: [{ block_id: gap.block_id, text: "How would you describe the business?" }],
    });

    expect(result.created).toBe(1);
    // The Q&A module never learns what a CIM is; one field is the whole contract.
    expect(store.createdItems[0]!.externalRef).toBe(gap.block_id);
    expect(store.createdItems[0]!.text).toBe("How would you describe the business?");
  });

  it("refuses to generate against a block on another CIM", async () => {
    const { versionId } = await newDeck();

    await expect(
      service.generate(broker, versionId, {
        questions: [{ block_id: "cccccccc-0000-4000-8000-000000000009", text: "q" }],
      }),
    ).rejects.toThrow(/different CIM/i);
  });

  it("reports the Q&A module as unavailable rather than half-sending", async () => {
    build({ qa: unavailableQa });
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);

    await expect(
      service.generate(broker, versionId, { questions: [{ block_id: gap.block_id, text: "q" }] }),
    ).rejects.toThrow(/not available/i);
  });

  it("surfaces a submitted answer for review without touching the slide", async () => {
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);
    store.answers.push({
      itemId: "i-1",
      responseId: "r-1",
      externalRef: gap.block_id,
      questionText: "How would you describe the business?",
      answerText: "We make industrial fasteners.",
      respondentId: seller.id,
      respondentName: "Dana Seller",
      submittedAt: "2026-08-20T10:00:00.000Z",
    });

    const queue = await service.reviewQueue(broker, versionId);

    expect(queue).toHaveLength(1);
    expect(queue[0]!.answer_text).toBe("We make industrial fasteners.");
    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content).toBeNull();
  });

  async function withAnswer() {
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);
    store.answers.push({
      itemId: "i-1",
      responseId: "r-1",
      externalRef: gap.block_id,
      questionText: "q",
      answerText: "the seller's own words",
      respondentId: seller.id,
      respondentName: "Dana Seller",
      submittedAt: "2026-08-20T10:00:00.000Z",
    });
    return { versionId, gap };
  }

  it("writes the answer onto the block when accepted", async () => {
    const { versionId, gap } = await withAnswer();

    const result = await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "skip",
    });

    expect(result.accepted).toBe(true);
    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content).toBe("the seller's own words");
    expect(block.populated_by).toBe("answer");
  });

  it("locks an answer-populated block so it can never become firm boilerplate", async () => {
    const { versionId, gap } = await withAnswer();
    await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "skip",
    });

    // CM-0002: deal content must never travel into a template that another
    // company's CIM could be built from.
    await service.saveBlocks(broker, versionId, {
      blocks: [
        { block_key: gap.block_key, content: "edited", content_class: "firm_boilerplate" },
      ],
    });

    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content_class).toBe("deal");
    expect(block.content_class_locked).toBe(true);
  });

  it("preserves the respondent's original text when the broker edits before accepting", async () => {
    const { gap } = await withAnswer();

    await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      // `mode` is `.default("skip")` in the contract, so the router never sends
      // it absent. Calling the service directly skips that, and omitting it
      // here tested a shape the service can never receive.
      mode: "skip",
      text: "Tidied for a buyer audience.",
    });

    const provenance = store.provenance.find((p) => p.blockId === gap.block_id)!;
    expect(provenance.rawAnswer).toBe("the seller's own words");
    expect(provenance.outcome).toBe("accepted");
  });

  it("leaves a filled block alone when the mode is skip", async () => {
    const { versionId, gap } = await withAnswer();
    await service.saveBlocks(broker, versionId, {
      blocks: [{ block_key: gap.block_key, content: "the broker already wrote this" }],
    });

    const result = await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "skip",
    });

    expect(result.accepted).toBe(false);
    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content).toBe("the broker already wrote this");
  });

  it("replaces a filled block only when told to", async () => {
    const { versionId, gap } = await withAnswer();
    await service.saveBlocks(broker, versionId, {
      blocks: [{ block_key: gap.block_key, content: "old" }],
    });

    await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "replace",
    });

    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content).toBe("the seller's own words");
  });

  it("appends when asked, keeping what was there", async () => {
    const { versionId, gap } = await withAnswer();
    await service.saveBlocks(broker, versionId, {
      blocks: [{ block_key: gap.block_key, content: "first para" }],
    });

    await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "append",
    });

    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content).toBe("first para\n\nthe seller's own words");
  });

  it("takes a decided answer out of the review queue", async () => {
    const { versionId, gap } = await withAnswer();
    await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "skip",
    });

    expect(await service.reviewQueue(broker, versionId)).toHaveLength(0);
  });

  it("retains a discarded answer rather than deleting it", async () => {
    const { versionId, gap } = await withAnswer();

    await service.discardAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
    });

    expect(await service.reviewQueue(broker, versionId)).toHaveLength(0);
    const provenance = store.provenance.find((p) => p.qaResponseId === "r-1")!;
    expect(provenance.outcome).toBe("discarded");
    expect(provenance.rawAnswer).toBe("the seller's own words");
    const detail = await service.getVersion(broker, versionId);
    const block = detail.sections
      .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
      .find((b) => b.id === gap.block_id)!;
    expect(block.content).toBeNull();
  });

  it("records an acceptance on the audit trail", async () => {
    const { gap } = await withAnswer();
    emitted.length = 0;

    await service.acceptAnswer(broker, gap.block_id, {
      qa_item_id: "i-1",
      qa_response_id: "r-1",
      mode: "skip",
    });

    expect(emitted).toContain("cim.answer.accepted");
  });
});

describe("publishing", () => {
  it("hashes the artifact and lands it in the data room", async () => {
    const { versionId } = await newDeck();
    const bytes = Buffer.from("%PDF-1.7 the rendered deck");

    const result = await service.publish(broker, versionId, bytes, {
      contentType: "application/pdf",
      pageCount: 14,
    });

    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.document_id).toBeTruthy();
    expect(store.publishedDocuments[0]!.name).toBe("Project Atlas CIM v1.pdf");
    expect(Buffer.compare(store.publishedDocuments[0]!.bytes, bytes)).toBe(0);
  });

  it("makes the same bytes hash the same, so a change is detectable", async () => {
    const { versionId } = await newDeck();
    const bytes = Buffer.from("identical");
    const first = await service.publish(broker, versionId, bytes, {
      contentType: "application/pdf",
      pageCount: 1,
    });

    build();
    const second = await newDeck();
    const again = await service.publish(broker, second.versionId, bytes, {
      contentType: "application/pdf",
      pageCount: 1,
    });

    expect(again.sha256).toBe(first.sha256);
  });

  it("refuses an empty document", async () => {
    const { versionId } = await newDeck();

    await expect(
      service.publish(broker, versionId, Buffer.alloc(0), {
        contentType: "application/pdf",
        pageCount: 0,
      }),
    ).rejects.toThrow(/empty/i);
  });

  it("refuses to publish when the data room has nowhere to put it", async () => {
    build({ dataRoom: unavailableCimDataRoom });
    const { versionId } = await newDeck();

    await expect(
      service.publish(broker, versionId, Buffer.from("pdf"), {
        contentType: "application/pdf",
        pageCount: 1,
      }),
    ).rejects.toThrow(/data room is not available/i);
  });

  it("refuses to publish the same version twice", async () => {
    const { versionId } = await newDeck();
    await service.publish(broker, versionId, Buffer.from("pdf"), {
      contentType: "application/pdf",
      pageCount: 1,
    });

    await expect(
      service.publish(broker, versionId, Buffer.from("pdf again"), {
        contentType: "application/pdf",
        pageCount: 1,
      }),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it("records publication on the audit trail", async () => {
    const { versionId } = await newDeck();
    emitted.length = 0;

    await service.publish(broker, versionId, Buffer.from("pdf"), {
      contentType: "application/pdf",
      pageCount: 1,
    });

    expect(emitted).toContain("cim.version.published");
  });
});

describe("deck health", () => {
  it("counts what is still unfilled", async () => {
    const { versionId } = await newDeck();

    const health = await service.health(broker, versionId);

    expect(health.unpopulated_blocks).toBeGreaterThan(0);
    expect(health.seller_approved).toBe(false);
  });

  it("does not block publication on an unanswered request", async () => {
    // CM-0004 is explicit: an open request must never stop a release.
    const { versionId } = await newDeck();
    const gap = await firstGap(versionId);
    await service.generate(broker, versionId, {
      questions: [{ block_id: gap.block_id, text: "q" }],
    });

    const health = await service.health(broker, versionId);

    expect(health.outstanding_questions).toBe(1);
    expect(health.publishable).toBe(true);
  });

  it("does not block publication on missing seller approval", async () => {
    // A real weakening of a CM-0001 control, deferred deliberately and recorded
    // in the change's Non-goals. Asserted so the deferral is visible rather than
    // silently assumed.
    const { versionId } = await newDeck();

    const health = await service.health(broker, versionId);

    expect(health.seller_approved).toBe(false);
    expect(health.publishable).toBe(true);
  });

  it("records approval when it is given", async () => {
    const { versionId } = await newDeck();

    await service.recordApproval(broker, versionId);

    const health = await service.health(broker, versionId);
    expect(health.seller_approved).toBe(true);
  });

  it("reports a published version as no longer publishable", async () => {
    const { versionId } = await newDeck();
    await service.publish(broker, versionId, Buffer.from("pdf"), {
      contentType: "application/pdf",
      pageCount: 1,
    });

    const health = await service.health(broker, versionId);

    expect(health.publishable).toBe(false);
  });
});
