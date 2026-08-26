import { describe, expect, it } from "vitest";
import { hasContent } from "./service.js";

/**
 * Whether a CIM block counts as filled in.
 *
 * It is the whole of the gap list: a block wrongly counted as filled never
 * appears on it, and the deck goes out with a heading and nothing under it.
 * A block wrongly counted as empty puts a question in front of a seller that
 * somebody has already answered.
 */

const block = (content: unknown, populatedBy: string | null = "author") =>
  ({ content, populatedBy }) as Parameters<typeof hasContent>[0];

describe("a block nobody has written to", () => {
  it("is empty however its content column reads", () => {
    // The provenance is what says whether anybody put text there. A block
    // whose content was cleared keeps its column until something overwrites
    // it, so trusting the column alone would count a stale value as filled.
    expect(hasContent(block("left over from a draft", null))).toBe(false);
    expect(hasContent(block(null, null))).toBe(false);
  });
});

describe("a block somebody has written to", () => {
  it("counts real text", () => {
    expect(hasContent(block("A manufacturer of widgets."))).toBe(true);
  });

  it("does not count whitespace", () => {
    // A blank string is not content; it is an unfilled field somebody tabbed
    // through.
    expect(hasContent(block(""))).toBe(false);
    expect(hasContent(block("   \n\t "))).toBe(false);
  });

  it("does not count an absent value", () => {
    expect(hasContent(block(null))).toBe(false);
    expect(hasContent(block(undefined))).toBe(false);
  });

  it("counts a list with something in it, and not an empty one", () => {
    // A bullet block is an array. An empty one renders as a heading with no
    // bullets, which is exactly the gap the list is for.
    expect(hasContent(block(["First point"]))).toBe(true);
    expect(hasContent(block([]))).toBe(false);
  });

  it("counts an object with something in it, and not an empty one", () => {
    // A table or a chart block is an object.
    expect(hasContent(block({ rows: [1] }))).toBe(true);
    expect(hasContent(block({}))).toBe(false);
  });

  it("counts a number or a boolean, which have no emptiness to test", () => {
    // Zero and false are values somebody chose, not blanks.
    expect(hasContent(block(0))).toBe(true);
    expect(hasContent(block(false))).toBe(true);
  });
});
