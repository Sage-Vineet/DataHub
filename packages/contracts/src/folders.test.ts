import { describe, expect, it } from "vitest";
import {
  folderAccessCreate,
  folderCreate,
  folderListQuery,
  folderMove,
  folderUpdate,
} from "./folders.js";

const UID = "11111111-1111-1111-1111-111111111111";
const GID = "22222222-2222-2222-2222-222222222222";

describe("folderCreate / update / move", () => {
  it("requires a name; accepts an optional nullable parent", () => {
    expect(folderCreate.safeParse({ name: "Finance" }).success).toBe(true);
    expect(folderCreate.safeParse({ name: "Sub", parent_id: UID }).success).toBe(true);
    expect(folderCreate.safeParse({ name: "  " }).success).toBe(false);
  });

  it("update rejects an empty patch", () => {
    expect(folderUpdate.safeParse({}).success).toBe(false);
    expect(folderUpdate.safeParse({ name: "New" }).success).toBe(true);
  });

  it("move accepts a null parent (to root)", () => {
    expect(folderMove.safeParse({ parent_id: null }).success).toBe(true);
    expect(folderMove.safeParse({ parent_id: UID }).success).toBe(true);
    expect(folderMove.safeParse({}).success).toBe(false);
  });
});

describe("folderAccessCreate — exactly one subject (D4)", () => {
  it("accepts a user-only or group-only grant", () => {
    expect(folderAccessCreate.safeParse({ user_id: UID, can_read: true }).success).toBe(true);
    expect(folderAccessCreate.safeParse({ group_id: GID }).success).toBe(true);
  });

  it("rejects both or neither subject", () => {
    expect(folderAccessCreate.safeParse({ user_id: UID, group_id: GID }).success).toBe(false);
    expect(folderAccessCreate.safeParse({ can_read: true }).success).toBe(false);
  });
});

describe("folderListQuery", () => {
  it("coerces include_archived from string or boolean", () => {
    expect(folderListQuery.parse({ include_archived: "true" }).include_archived).toBe(true);
    expect(folderListQuery.parse({ include_archived: false }).include_archived).toBe(false);
    expect(folderListQuery.parse({}).include_archived).toBe(false);
  });

  it("accepts the camelCase wire name legacy reads and the SPA sends", () => {
    // apps/web/src/lib/api.js builds "?includeArchived=true"; legacy reads
    // req.query.includeArchived. Honouring only snake_case would make the filter
    // silently inert after cutover — it parses fine and returns everything.
    expect(folderListQuery.parse({ includeArchived: "true" }).include_archived).toBe(true);
    expect(folderListQuery.parse({ includeArchived: "false" }).include_archived).toBe(false);
  });

  it("treats either spelling as opt-in", () => {
    expect(folderListQuery.parse({ includeArchived: "true", include_archived: "false" }).include_archived).toBe(true);
    expect(folderListQuery.parse({ includeArchived: "false", include_archived: "true" }).include_archived).toBe(true);
  });
});
