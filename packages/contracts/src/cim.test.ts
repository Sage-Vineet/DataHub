import { describe, expect, it } from "vitest";
import { acceptAnswer, blockBulkUpsert, deckCreate, generateRequest } from "./cim.js";

const BLOCK = "11111111-1111-4111-8111-111111111111";

describe("accepting an answer onto a slide", () => {
  it("defaults to skip, so authored content is never overwritten by omission", () => {
    // CM-0004 requires an explicit choice before existing content is touched. A
    // default of `replace` would destroy authored work the first time someone
    // accepted onto a filled block without thinking about it.
    const parsed = acceptAnswer.parse({ qa_item_id: "i-1", qa_response_id: "r-1" });

    expect(parsed.mode).toBe("skip");
  });

  it("accepts an explicit replace or append", () => {
    expect(
      acceptAnswer.parse({ qa_item_id: "i", qa_response_id: "r", mode: "replace" }).mode,
    ).toBe("replace");
    expect(
      acceptAnswer.parse({ qa_item_id: "i", qa_response_id: "r", mode: "append" }).mode,
    ).toBe("append");
  });

  it("rejects a mode the service would not know how to honour", () => {
    expect(() =>
      acceptAnswer.parse({ qa_item_id: "i", qa_response_id: "r", mode: "merge" }),
    ).toThrow();
  });

  it("carries the broker's edit separately from the identifiers", () => {
    const parsed = acceptAnswer.parse({
      qa_item_id: "i",
      qa_response_id: "r",
      text: "Tidied for a buyer audience.",
    });

    // The respondent's original is preserved as provenance server-side; this is
    // only what should land on the slide.
    expect(parsed.text).toBe("Tidied for a buyer audience.");
  });

  it("requires both identifiers, so provenance can never be half-recorded", () => {
    expect(() => acceptAnswer.parse({ qa_item_id: "i" })).toThrow();
    expect(() => acceptAnswer.parse({ qa_response_id: "r" })).toThrow();
  });
});

describe("generating a request", () => {
  it("refuses an empty request", () => {
    expect(() => generateRequest.parse({ questions: [] })).toThrow(/at least one/i);
  });

  it("carries the broker's rewording per question", () => {
    const parsed = generateRequest.parse({
      questions: [{ block_id: BLOCK, text: "How would you describe the customer base?" }],
    });

    // Rewording here does not modify the library entry — that is a service
    // guarantee, but the shape makes it possible by keeping them separate.
    expect(parsed.questions[0]!.text).toMatch(/customer base/);
  });

  it("allows a per-question recipient, for a section that has its own owner", () => {
    const parsed = generateRequest.parse({
      questions: [{ block_id: BLOCK, text: "q", assignee_user_id: BLOCK }],
    });

    expect(parsed.questions[0]!.assignee_user_id).toBe(BLOCK);
  });
});

describe("the editor's save", () => {
  it("accepts a partial set of blocks", () => {
    const parsed = blockBulkUpsert.parse({
      blocks: [{ block_key: "5:abc:token:0:name", content: "Acme" }],
    });

    expect(parsed.blocks).toHaveLength(1);
  });

  it("leaves block content opaque, so a new layout is not a contract change", () => {
    // The renderer already knows how to read a field value; describing that shape
    // twice would mean two definitions drifting apart.
    const shapes = [
      "a string",
      { rows: [["a", "b"]] },
      ["a", "list"],
      42,
      null,
    ];

    for (const content of shapes) {
      expect(() =>
        blockBulkUpsert.parse({ blocks: [{ block_key: "k", content }] }),
      ).not.toThrow();
    }
  });

  it("requires a block key, since that is the block's identity", () => {
    expect(() => blockBulkUpsert.parse({ blocks: [{ content: "orphan" }] })).toThrow();
    expect(() => blockBulkUpsert.parse({ blocks: [{ block_key: "", content: "x" }] })).toThrow();
  });

  it("caps a single save, so one request cannot rewrite an unbounded deck", () => {
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({
      block_key: `k-${i}`,
      content: "x",
    }));

    expect(() => blockBulkUpsert.parse({ blocks: tooMany })).toThrow();
  });
});

describe("deck creation", () => {
  it("requires a name", () => {
    expect(() => deckCreate.parse({ name: "   " })).toThrow();
    expect(deckCreate.parse({ name: "Project Atlas CIM" }).name).toBe("Project Atlas CIM");
  });
});
