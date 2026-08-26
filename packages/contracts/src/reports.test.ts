import { describe, expect, it } from "vitest";
import { reportVersionCreate, reportVersionUpdate } from "./reports.js";

const CID = "11111111-1111-1111-1111-111111111111";

describe("reportVersionCreate", () => {
  it("requires a company_id; name/metadata optional", () => {
    expect(reportVersionCreate.safeParse({ company_id: CID }).success).toBe(true);
    expect(reportVersionCreate.safeParse({ company_id: CID, version_name: "Q1", metadata: { a: 1 } }).success).toBe(true);
    expect(reportVersionCreate.safeParse({}).success).toBe(false);
  });
});

describe("reportVersionUpdate", () => {
  it("rejects an empty patch and a bad status", () => {
    expect(reportVersionUpdate.safeParse({}).success).toBe(false);
    expect(reportVersionUpdate.safeParse({ status: "nope" }).success).toBe(false);
    expect(reportVersionUpdate.safeParse({ status: "synced" }).success).toBe(true);
  });
});
