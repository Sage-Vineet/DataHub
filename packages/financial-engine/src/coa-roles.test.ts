import { describe, expect, it } from "vitest";
import {
  EBIT_ROLE_ORDER,
  ROLE_LABELS,
  accountsByRole,
  roleSign,
  unflaggedProfitLossAccounts,
} from "./coa-roles.js";
import type { Account, EbitdaRole } from "./types.js";

/**
 * The EBIT roles, and what the bridge does with them.
 *
 * These were exercised only through `buildBridge`, which adds them up — so the
 * grouping and the "what did you skip?" list, neither of which the total
 * depends on, had nothing asserting them.
 */

const account = (over: Partial<Account>): Account => ({
  id: "a-1",
  name: "Interest Paid",
  statementType: "profit_loss",
  accountType: "expense",
  ...over,
});

describe("which way a role moves the number", () => {
  it("gives every role in the bridge order a sign", () => {
    // A role with no sign is one the bridge adds where it should subtract.
    for (const role of EBIT_ROLE_ORDER) {
      expect([1, -1], role).toContain(roleSign(role));
    }
  });

  it("labels every role in the bridge order", () => {
    // The label is the row heading. A missing one renders as an empty row on
    // the bridge with a number beside it.
    for (const role of EBIT_ROLE_ORDER) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
    }
  });

  it("adds interest and depreciation back, and takes interest income out", () => {
    // The definition of EBITDA, stated where somebody can check it.
    expect(roleSign("interest_expense")).toBe(1);
    expect(roleSign("depreciation")).toBe(1);
    expect(roleSign("amortization")).toBe(1);
    expect(roleSign("income_tax")).toBe(1);
    expect(roleSign("interest_income")).toBe(-1);
  });
});

describe("grouping accounts by the role they carry", () => {
  it("puts several accounts under one role, in chart order", () => {
    // A company with three loans has three interest accounts, and the bridge
    // shows one line. Keeping only the last would understate the add-back by
    // the other two.
    const accounts = [
      account({ id: "a", name: "Interest — Bank", ebitdaRole: "interest_expense" }),
      account({ id: "b", name: "Depreciation", ebitdaRole: "depreciation" }),
      account({ id: "c", name: "Interest — SBA", ebitdaRole: "interest_expense" }),
    ];

    const byRole = accountsByRole(accounts);
    expect(byRole.get("interest_expense")!.map((a) => a.id)).toEqual(["a", "c"]);
    expect(byRole.get("depreciation")!.map((a) => a.id)).toEqual(["b"]);
  });

  it("leaves out accounts carrying no role", () => {
    const byRole = accountsByRole([
      account({ id: "a", ebitdaRole: "interest_expense" }),
      account({ id: "b", name: "Rent" }),
    ]);
    expect([...byRole.values()].flat().map((a) => a.id)).toEqual(["a"]);
  });

  it("has nothing to say about an empty chart", () => {
    expect(accountsByRole([]).size).toBe(0);
  });
});

describe("what the bridge says it skipped", () => {
  it("names every P&L account with no role, sorted", () => {
    // Surfaced so a reviewer sees what was skipped rather than discovering it
    // in a workpaper review — which is where it was discovered before.
    const names = unflaggedProfitLossAccounts([
      account({ id: "a", name: "Rent" }),
      account({ id: "b", name: "Advertising" }),
      account({ id: "c", name: "Interest Paid", ebitdaRole: "interest_expense" }),
    ]);
    expect(names).toEqual(["Advertising", "Rent"]);
  });

  it("says nothing about balance-sheet accounts", () => {
    // They are not skipped; they were never in scope. Listing them would make
    // the reviewer's list mostly noise.
    const names = unflaggedProfitLossAccounts([
      account({ id: "a", name: "Cash", statementType: "balance_sheet", accountType: "asset" }),
      account({ id: "b", name: "Rent" }),
    ]);
    expect(names).toEqual(["Rent"]);
  });

  it("says nothing at all when every P&L account carries a role", () => {
    const names = unflaggedProfitLossAccounts([
      account({ id: "a", name: "Interest Paid", ebitdaRole: "interest_expense" }),
    ]);
    expect(names).toEqual([]);
  });
});

describe("the roles a bridge renders, and their order", () => {
  it("lists each role once", () => {
    // A duplicate would render the same add-back twice and count it twice.
    expect(new Set(EBIT_ROLE_ORDER).size).toBe(EBIT_ROLE_ORDER.length);
  });

  it("puts interest before depreciation, as a bridge is read", () => {
    const order = (role: EbitdaRole) => EBIT_ROLE_ORDER.indexOf(role);
    expect(order("interest_expense")).toBeLessThan(order("depreciation"));
    expect(order("depreciation")).toBeLessThan(order("amortization"));
  });
});
