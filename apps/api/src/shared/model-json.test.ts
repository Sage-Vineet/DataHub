import { describe, expect, it } from "vitest";
import {
  ModelReplyError,
  findJsonBlock,
  modelNumber,
  modelNumberOr,
  parseModelJson,
} from "./model-json.js";

/**
 * Reading JSON out of a language model's reply.
 *
 * A model asked for JSON returns JSON most of the time. The rest of the time it
 * fences it, or writes a sentence first, or thanks you afterwards. Each of
 * those made `JSON.parse` throw, and a throw here becomes "extraction failed"
 * on a page where the extraction actually succeeded.
 */

describe("finding the JSON in a reply", () => {
  it("takes a bare object", () => {
    expect(findJsonBlock('{"year":2024}')).toBe('{"year":2024}');
  });

  it("takes one out of a markdown fence", () => {
    expect(findJsonBlock('```json\n{"year":2024}\n```')).toBe('{"year":2024}');
    expect(findJsonBlock('```\n{"year":2024}\n```')).toBe('{"year":2024}');
  });

  it("takes one with prose in front of it", () => {
    // The old strip only handled a fence with nothing outside it, so a reply
    // that explained itself first failed to parse at all.
    expect(findJsonBlock('Here is the data you asked for:\n{"year":2024}')).toBe('{"year":2024}');
  });

  it("takes one with prose after it", () => {
    expect(
      findJsonBlock('{"year":2024}\n\nLet me know if you need anything else!'),
    ).toBe('{"year":2024}');
  });

  it("takes one wrapped in both", () => {
    expect(
      findJsonBlock('Sure!\n```json\n{"year":2024}\n```\nHope that helps.'),
    ).toBe('{"year":2024}');
  });

  it("keeps a nested object whole", () => {
    // Stopping at the first close brace would truncate every nested value.
    expect(findJsonBlock('{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
  });

  it("stops at the matching brace, not the last one in the reply", () => {
    // Matching greedily to the final brace captures whatever prose follows.
    expect(findJsonBlock('{"a":1} and then {"b":2}')).toBe('{"a":1}');
  });

  it("ignores a brace inside a string value", () => {
    expect(findJsonBlock('{"note":"} end"}')).toBe('{"note":"} end"}');
  });

  it("ignores an escaped quote inside a string", () => {
    expect(findJsonBlock('{"note":"say \\"hi\\" }"}')).toBe('{"note":"say \\"hi\\" }"}');
  });

  it("takes an array as readily as an object", () => {
    expect(findJsonBlock('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
  });

  it("skips an unbalanced opener and finds a later balanced one", () => {
    expect(findJsonBlock('{ oh dear\n{"a":1}')).toBe('{"a":1}');
  });

  it("says nothing when there is no JSON at all", () => {
    for (const reply of ["", "I could not read that document.", "```\nnot json\n```"]) {
      expect(findJsonBlock(reply)).toBeNull();
    }
  });
});

describe("parsing a reply", () => {
  it("returns the value", () => {
    expect(parseModelJson('```json\n{"year":2024}\n```')).toEqual({ year: 2024 });
  });

  it("names what came back when there is no JSON", () => {
    // The difference between diagnosing a bad prompt and staring at
    // "extraction failed".
    let error: ModelReplyError | null = null;
    try {
      parseModelJson("I was unable to read this PDF.");
    } catch (e) {
      error = e as ModelReplyError;
    }
    expect(error).toBeInstanceOf(ModelReplyError);
    expect(error!.reply).toBe("I was unable to read this PDF.");
  });

  it("names what came back when the JSON is malformed", () => {
    let error: ModelReplyError | null = null;
    try {
      parseModelJson('{"year": 2024,}');
    } catch (e) {
      error = e as ModelReplyError;
    }
    expect(error).toBeInstanceOf(ModelReplyError);
    expect(error!.message).toMatch(/not valid JSON/);
  });

  it("truncates a very long reply rather than logging a page of it", () => {
    let error: ModelReplyError | null = null;
    try {
      parseModelJson("no json here ".repeat(200));
    } catch (e) {
      error = e as ModelReplyError;
    }
    expect(error!.reply.length).toBeLessThanOrEqual(500);
  });
});

describe("reading a number a model wrote", () => {
  it("reads the way a person writes money", () => {
    // `Number("1,234.56") || 0` is 0 — which is how a company's revenue
    // silently becomes nothing.
    expect(modelNumber("1,234.56")).toBe(1234.56);
    expect(modelNumber("$1,234")).toBe(1234);
    expect(modelNumber("(500)")).toBe(-500);
    expect(modelNumber("-99.5")).toBe(-99.5);
  });

  it("takes a number as a number", () => {
    expect(modelNumber(1234.56)).toBe(1234.56);
    expect(modelNumber(0)).toBe(0);
  });

  it("keeps a genuine zero apart from nothing said", () => {
    // A caller has to be able to tell "the model said nought" from "the model
    // did not say".
    expect(modelNumber("0")).toBe(0);
    expect(modelNumber("")).toBeNull();
    expect(modelNumber(null)).toBeNull();
    expect(modelNumber(undefined)).toBeNull();
  });

  it("returns null rather than NaN for something unreadable", () => {
    for (const value of ["n/a", "-", ".", "see attached", Number.NaN, {}]) {
      expect(modelNumber(value)).toBeNull();
    }
  });

  it("falls back only where a caller asked it to", () => {
    expect(modelNumberOr("n/a", 0)).toBe(0);
    expect(modelNumberOr("1,000", 0)).toBe(1000);
    expect(modelNumberOr("0", -1)).toBe(0);
  });
});
