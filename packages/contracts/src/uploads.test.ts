import { describe, expect, it } from "vitest";
import { documentActivityCreate, documentCreate, documentListQuery } from "./uploads.js";

const UID = "11111111-1111-1111-1111-111111111111";

describe("documentCreate", () => {
  it("requires name/upload_id/size/ext", () => {
    expect(documentCreate.safeParse({ name: "Q1.pdf", upload_id: UID, size: "1024", ext: "pdf" }).success).toBe(true);
    expect(documentCreate.safeParse({ name: "Q1.pdf", size: "1024", ext: "pdf" }).success).toBe(false);
    expect(documentCreate.safeParse({ name: "  ", upload_id: UID, size: "1", ext: "pdf" }).success).toBe(false);
    expect(documentCreate.safeParse({ name: "x", upload_id: "not-a-uuid", size: "1", ext: "pdf" }).success).toBe(false);
  });
});

describe("documentListQuery", () => {
  it("coerces include_archived", () => {
    expect(documentListQuery.parse({ include_archived: "true" }).include_archived).toBe(true);
    expect(documentListQuery.parse({}).include_archived).toBe(false);
  });

  it("accepts the camelCase wire name legacy reads and the SPA sends", () => {
    expect(documentListQuery.parse({ includeArchived: "true" }).include_archived).toBe(true);
    expect(documentListQuery.parse({ includeArchived: "false" }).include_archived).toBe(false);
  });
});

describe("documentActivityCreate", () => {
  it("accepts the two actions the deployed column can store", () => {
    expect(documentActivityCreate.safeParse({ action: "view" }).success).toBe(true);
    expect(documentActivityCreate.safeParse({ action: "download" }).success).toBe(true);
  });

  it("refuses anything else, including near-misses", () => {
    // `document_activity.activity_type` is a Postgres enum of exactly
    // view|download. This previously accepted any non-empty string, so
    // "downloaded" passed the contract and then failed the insert — a 400's
    // worth of information arriving as a 500.
    for (const action of ["downloaded", "viewed", "printed", "", "VIEW"]) {
      expect(documentActivityCreate.safeParse({ action }).success).toBe(false);
    }
  });
});
