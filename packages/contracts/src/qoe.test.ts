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

  it("requires a GL account on a GL-sourced add-back", () => {
    // The amount comes FROM the account. Without one there is nothing to read,
    // and the add-back would sit on the bridge contributing zero for a reason
    // no page explains.
    const result = addbackCreate.safeParse({ ...base, kind: "pnl_account_vendor" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/linked GL account/);
  });

  it("accepts a GL-sourced add-back that names its account and no amount", () => {
    const result = addbackCreate.safeParse({
      ...base,
      kind: "pnl_account_vendor",
      linked_account_id: "meals",
    });
    expect(result.success).toBe(true);
  });

  it("requires a P&L account on a recast", () => {
    // A recast restates one account's cost at a post-close rate. Without the
    // account there is nothing being restated — and the normalized value would
    // be applied against nothing.
    const result = addbackCreate.safeParse({
      ...base,
      kind: "recast",
      recast_normalized_value: 90000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/linked P&L account/);
  });

  it("accepts a recast that names both its account and its value", () => {
    const result = addbackCreate.safeParse({
      ...base,
      kind: "recast",
      linked_account_id: "rent",
      recast_normalized_value: 90000,
    });
    expect(result.success).toBe(true);
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
