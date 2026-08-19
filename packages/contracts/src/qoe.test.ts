import { describe, expect, it } from "vitest";
import { addbackCreate, bridgeQuery } from "./qoe.js";

const base = {
  version_id: "v1",
  company_id: "11111111-1111-4111-8111-111111111111",
  type_key: "other_addback",
  name: "Test",
};

describe("bridgeQuery", () => {
  it("parses discretely selected years", () => {
    const parsed = bridgeQuery.parse({ version_id: "v1", years: "2022, 2024" });
    expect(parsed.years).toEqual([2022, 2024]);
    expect(parsed.aggregation).toBe("annual");
    expect(parsed.data_source).toBe("company_financials");
  });

  it("rejects an empty selection", () => {
    expect(bridgeQuery.safeParse({ version_id: "v1", years: "" }).success).toBe(false);
  });
});

describe("addbackCreate", () => {
  it("refuses a manual adjustment with no explanation", () => {
    const result = addbackCreate.safeParse({ ...base, kind: "manual_adjustment" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/written explanation/);
  });

  it("accepts a manual adjustment once explained", () => {
    const result = addbackCreate.safeParse({
      ...base,
      kind: "manual_adjustment",
      explanation: "Owner's personal travel.",
    });
    expect(result.success).toBe(true);
  });

  it("refuses a manually entered amount on a GL-sourced add-back", () => {
    const result = addbackCreate.safeParse({
      ...base,
      kind: "pnl_account_vendor",
      linked_account_id: "meals",
      values: { "2024": 100 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/cannot be entered manually/);
  });

  it("requires a normalized value on a recast", () => {
    const result = addbackCreate.safeParse({
      ...base,
      kind: "recast",
      linked_account_id: "rent",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/normalized post-close value/);
  });
});
