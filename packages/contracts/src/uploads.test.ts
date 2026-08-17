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
  it("requires a non-empty action", () => {
    expect(documentActivityCreate.safeParse({ action: "downloaded" }).success).toBe(true);
    expect(documentActivityCreate.safeParse({ action: "" }).success).toBe(false);
  });
});
