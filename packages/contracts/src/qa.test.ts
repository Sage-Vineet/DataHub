import { describe, expect, it } from "vitest";
import * as qa from "./qa.js";
import { itemCreate, presentationCreate, responseCreate, visibilityRule } from "./qa.js";

const USER = "11111111-1111-4111-8111-111111111111";
const RESP = "22222222-2222-4222-8222-222222222222";

describe("the shape of immutability", () => {
  it("exposes no schema for updating or deleting a response", () => {
    // QA-0002 makes a posted response permanently immutable. The cleanest
    // enforcement is to give the system no vocabulary for the operation: no
    // schema here means no route there.
    const names = Object.keys(qa);
    expect(names).not.toContain("responseUpdate");
    expect(names).not.toContain("responseDelete");
    expect(names).not.toContain("responsePatch");
  });

  it("expresses a correction as a new response pointing at the one it replaces", () => {
    const parsed = responseCreate.parse({ body: "actually, 4.2m", supersedes_id: RESP });
    expect(parsed.supersedes_id).toBe(RESP);
    expect(parsed.kind).toBe("answer");
  });

  it("keeps the broker's rewording a separate object, never a field on a response", () => {
    // If this were a field, some route would eventually write it onto the row.
    const parsed = presentationCreate.parse({ source_response_id: RESP, body: "Polished." });
    expect(parsed.source_response_id).toBe(RESP);
    expect(Object.keys(responseCreate.parse({ body: "x" }))).not.toContain("presentable");
  });
});

describe("item creation", () => {
  const base = { title: "Explain the Q3 swing", body: "Revenue moved 18% — why?" };

  it("defaults priority and leaves requestees to the category's nominees", () => {
    const parsed = itemCreate.parse(base);
    expect(parsed.priority).toBe("medium");
    // Omitted, not empty: an empty array would mean "explicitly nobody", which is
    // a different instruction from "use whoever the seller nominated".
    expect(parsed.requestee_ids).toBeUndefined();
  });

  it("accepts explicit requestees when the asker overrides the nomination", () => {
    expect(itemCreate.parse({ ...base, requestee_ids: [USER] }).requestee_ids).toEqual([USER]);
  });

  it("rejects an empty title or body rather than storing whitespace", () => {
    expect(() => itemCreate.parse({ ...base, title: "  " })).toThrow();
    expect(() => itemCreate.parse({ ...base, body: "" })).toThrow();
  });

  it("rejects an origin outside the three the reporting layer knows", () => {
    expect(() => itemCreate.parse({ ...base, origin: "somewhere_else" })).toThrow();
    expect(itemCreate.parse({ ...base, origin: "cim_guided" }).origin).toBe("cim_guided");
  });

  it("carries the opaque external reference another module writes into", () => {
    expect(itemCreate.parse({ ...base, external_ref: "block-42" }).external_ref).toBe("block-42");
  });
});

describe("assignment", () => {
  it("refuses to leave an item with nobody accountable", () => {
    expect(() => qa.assigneesReplace.parse({ user_ids: [] })).toThrow(/at least one/i);
  });

  it("treats delegation and reassignment as the same event with a different label", () => {
    expect(qa.assigneesReplace.parse({ user_ids: [USER] }).kind).toBe("requestee");
    expect(qa.assigneesReplace.parse({ user_ids: [USER], kind: "delegate" }).kind).toBe("delegate");
  });
});

describe("visibility rules", () => {
  it("names a user or a role, never both", () => {
    expect(() => visibilityRule.parse({ user_id: USER, role_key: "buyer" })).toThrow();
  });

  it("names a user or a role, never neither", () => {
    expect(() => visibilityRule.parse({})).toThrow();
  });

  it("accepts either one alone, defaulting to hiding", () => {
    expect(visibilityRule.parse({ user_id: USER }).effect).toBe("hide");
    expect(visibilityRule.parse({ role_key: "buyer" }).effect).toBe("hide");
  });
});

describe("attachments", () => {
  it("requires a destination folder, so evidence is filed rather than scattered", () => {
    expect(() => qa.attachmentCreate.parse({ document_id: RESP })).toThrow();
    expect(qa.attachmentCreate.parse({ document_id: RESP, folder_id: USER }).folder_id).toBe(USER);
  });
});

describe("filters", () => {
  it("separates items I raised from items assigned to me", () => {
    expect(qa.itemListQuery.parse({ mine: "requestor" }).mine).toBe("requestor");
    expect(qa.itemListQuery.parse({ mine: "requestee" }).mine).toBe("requestee");
    expect(() => qa.itemListQuery.parse({ mine: "everyone" })).toThrow();
  });
});
