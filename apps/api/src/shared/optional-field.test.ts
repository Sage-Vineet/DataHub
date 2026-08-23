import { describe, expect, it } from "vitest";
import { cleared } from "./optional-field.js";

/**
 * Clearing an optional field.
 *
 * Two services had their own `?? null` for this, and neither of them could
 * actually clear anything: the contract permits a string or nothing, so the
 * null branch never fired and an empty string was stored as an empty string.
 */

describe("clearing a field", () => {
  it("keeps a value that is there", () => {
    expect(cleared("Acme")).toBe("Acme");
  });

  it("treats an empty value as a request to remove it", () => {
    // The only way a caller can say "remove it", given a contract with no null.
    expect(cleared("")).toBeNull();
    expect(cleared("   ")).toBeNull();
  });

  it("treats absent as absent", () => {
    expect(cleared(undefined)).toBeNull();
    expect(cleared(null)).toBeNull();
  });

  it("keeps a value that merely has spaces around it", () => {
    // Trimming decides whether it is empty; it does not rewrite what is stored,
    // because a caller who sent trailing space meant the text, not the space.
    expect(cleared(" Acme ")).toBe(" Acme ");
  });
});
