import { describe, expect, it } from "vitest";
import { firstError } from "./first-error.js";

/**
 * The message a rejected request shows.
 *
 * It is the whole of what a caller has to go on: the response is a 400 and a
 * sentence, and if the sentence does not say which field, they are guessing.
 */

describe("reading a validation problem", () => {
  it("shows the first one, which is the field the user is looking at", () => {
    expect(
      firstError({
        issues: [
          { message: "Email is required.", path: ["email"] },
          { message: "Password too short.", path: ["password"] },
        ],
      }),
    ).toBe("Email is required.");
  });

  it("names the field when the message does not", () => {
    // Zod's default for a missing field is the single word "Required", which
    // reaches the page as "Required" — true, unactionable, and identical
    // whichever field is missing.
    expect(firstError({ issues: [{ message: "Required", path: ["password"] }] })).toBe(
      "password: Required",
    );
  });

  it("does not repeat a field the message already names", () => {
    // "email: Email is required." reads worse than either half.
    expect(firstError({ issues: [{ message: "Email is required.", path: ["email"] }] })).toBe(
      "Email is required.",
    );
  });

  it("names a nested field by its path", () => {
    expect(
      firstError({ issues: [{ message: "Required", path: ["mapping", "date"] }] }),
    ).toBe("mapping.date: Required");
  });

  it("leaves an array index out of the name", () => {
    // "documents.0.documentId" is how the schema sees it; "documents.documentId"
    // is what somebody reading the form is looking for.
    expect(
      firstError({ issues: [{ message: "Required", path: ["documents", 0, "id"] }] }),
    ).toBe("documents.id: Required");
  });

  it("says something rather than nothing", () => {
    // A blank error renders as an empty red box, which reads as a bug in the
    // page rather than as a rejected request.
    expect(firstError({ issues: [{ message: "   ", path: ["email"] }] })).toBe("Invalid request.");
    expect(firstError({ issues: [{}] })).toBe("Invalid request.");
    expect(firstError({ issues: [] })).toBe("Invalid request.");
  });

  it("copes with an issue that carries no path", () => {
    expect(firstError({ issues: [{ message: "Required" }] })).toBe("Required");
  });
});
