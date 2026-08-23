import { describe, expect, it } from "vitest";
import {
  buildTree,
  columnsToLevels,
  hierarchySnapshot,
  isModified,
  levelsToColumns,
  MAX_LEVELS,
  statementTypeFor,
  toAccount,
  type CoaRow,
} from "./mapping.js";

/**
 * Turning stored rows into the grid and tree.
 *
 * The case that carries the most weight is the tree: the last level in an
 * account's path is the account itself, not a category, and treating it as one
 * gives every account a folder containing only itself.
 */

const row = (over: Partial<CoaRow> & { id: string }): CoaRow => ({
  versionId: "v1",
  accountNumber: null,
  accountName: over.id,
  parentAccountId: null,
  accountType: "expense",
  statementType: "profit_loss",
  isActive: true,
  sortOrder: 0,
  baseAccount: null,
  hierarchyPath: null,
  accountIdName: null,
  classificationMethod: "ai",
  originalName: null,
  adjustedName: null,
  metadata: null,
  levels: Array.from({ length: MAX_LEVELS }, () => null),
  ...over,
});

const withLevels = (id: string, levels: string[], over: Partial<CoaRow> = {}) =>
  row({
    id,
    accountName: levels[levels.length - 1] ?? id,
    levels: [...levels, ...Array.from({ length: MAX_LEVELS - levels.length }, () => null)],
    ...over,
  });

describe("statement type", () => {
  it("follows the account type", () => {
    for (const t of ["asset", "liability", "equity"]) expect(statementTypeFor(t)).toBe("balance_sheet");
    for (const t of ["income", "expense", "cogs"]) expect(statementTypeFor(t)).toBe("profit_loss");
  });

  it("treats an unknown or absent type as profit and loss", () => {
    // The safe default: an unclassified account showing on the P&L is visible,
    // whereas one silently on the balance sheet distorts the position.
    expect(statementTypeFor(null)).toBe("profit_loss");
    expect(statementTypeFor("mystery")).toBe("profit_loss");
  });
});

describe("the level columns", () => {
  it("round-trips through the fifteen columns", () => {
    const levels = ["Income Statement", "Revenue", "Product Sales"];
    const padded = [...levels, ...Array.from({ length: MAX_LEVELS - 3 }, () => null)];
    const columns = levelsToColumns(padded);

    expect(columns.level1).toBe("Income Statement");
    expect(columns.level3).toBe("Product Sales");
    expect(columns.level15).toBeNull();
    expect(columnsToLevels(columns)).toEqual(padded);
  });

  it("reads either spelling of the column name", () => {
    // Drizzle returns `level1`; a raw row returns `level_1`.
    expect(columnsToLevels({ level1: "A" })[0]).toBe("A");
    expect(columnsToLevels({ level_1: "A" })[0]).toBe("A");
  });

  it("treats an empty string as no level", () => {
    expect(columnsToLevels({ level1: "" })[0]).toBeNull();
  });

  it("pads a short list rather than producing a ragged row", () => {
    const columns = levelsToColumns(["A"]);
    expect(Object.keys(columns)).toHaveLength(MAX_LEVELS);
    expect(columns.level2).toBeNull();
  });
});

describe("what counts as edited", () => {
  it("trusts the flag every edit path sets", () => {
    expect(isModified(row({ id: "a", metadata: { user_modified: true } }))).toBe(true);
  });

  it("also catches a renamed account from before the flag existed", () => {
    expect(isModified(row({ id: "a", originalName: "Old", adjustedName: "New" }))).toBe(true);
  });

  it("does not call an unchanged account edited", () => {
    expect(isModified(row({ id: "a" }))).toBe(false);
    expect(isModified(row({ id: "a", originalName: "Same", adjustedName: "Same" }))).toBe(false);
  });
});

describe("the account as displayed", () => {
  it("prefers the adjusted name but keeps the source one", () => {
    const account = toAccount(row({ id: "a", accountName: "4000 Sales", adjustedName: "Revenue" }));
    expect(account.accountName).toBe("Revenue");
    expect(account.sourceName).toBe("4000 Sales");
  });

  it("falls back to the source name when nothing was adjusted", () => {
    expect(toAccount(row({ id: "a", accountName: "4000 Sales" })).accountName).toBe("4000 Sales");
  });

  it("reports an absent metadata object as empty rather than null", () => {
    expect(toAccount(row({ id: "a" })).metadata).toEqual({});
  });
});

describe("building the tree", () => {
  it("nests categories and hangs the account off the last one", () => {
    // The last level IS the account. A folder-per-account would be the bug.
    const tree = buildTree([
      toAccount(withLevels("a1", ["Income Statement", "Revenue", "Product Sales"])),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "Income Statement", isGroup: true, level: 1 });
    const revenue = tree[0]!.children[0]!;
    expect(revenue).toMatchObject({ name: "Revenue", isGroup: true, level: 2 });
    expect(revenue.children[0]).toMatchObject({
      name: "Product Sales",
      isGroup: false,
      accountId: "a1",
      level: 3,
    });
  });

  it("shares a category between siblings instead of duplicating it", () => {
    const tree = buildTree([
      toAccount(withLevels("a1", ["Income Statement", "Revenue", "Product"])),
      toAccount(withLevels("a2", ["Income Statement", "Revenue", "Services"])),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.children.map((c) => c.name)).toEqual(["Product", "Services"]);
  });

  it("puts an account with no levels at the root", () => {
    const tree = buildTree([toAccount(row({ id: "orphan", accountName: "Suspense" }))]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "Suspense", isGroup: false, level: 1 });
  });

  it("orders categories before accounts at the same level", () => {
    const tree = buildTree([
      toAccount(withLevels("leaf", ["Assets", "Petty Cash"])),
      toAccount(withLevels("nested", ["Assets", "Bank Accounts", "Checking"])),
    ]);
    const assets = tree[0]!;
    expect(assets.children.map((c) => c.isGroup)).toEqual([true, false]);
  });

  it("uses the reading order of a statement, not the alphabet", () => {
    // Alphabetically "Equity" precedes "Liabilities"; on a balance sheet it
    // does not.
    const tree = buildTree([
      toAccount(withLevels("e", ["Equity", "Owner Capital"])),
      toAccount(withLevels("l", ["Liabilities", "Accounts Payable"])),
      toAccount(withLevels("a", ["Assets", "Cash"])),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["Assets", "Liabilities", "Equity"]);
  });

  it("falls back to alphabetical for captions it does not know", () => {
    const tree = buildTree([
      toAccount(withLevels("z", ["Zebra", "One"])),
      toAccount(withLevels("m", ["Mango", "Two"])),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["Mango", "Zebra"]);
  });

  it("leaves no helper index on the returned nodes", () => {
    // `childIndex` is a build-time Map; serializing it would put an empty
    // object on every node in the response.
    const tree = buildTree([toAccount(withLevels("a1", ["A", "B", "C"]))]);
    expect(tree[0]).not.toHaveProperty("childIndex");
    expect(tree[0]!.children[0]).not.toHaveProperty("childIndex");
  });
});

describe("the audit snapshot", () => {
  it("is stored snake_case, because it is JSON on disk", () => {
    expect(hierarchySnapshot(["A", null], "asset", "balance_sheet", "A")).toEqual({
      levels: ["A", null],
      account_type: "asset",
      statement_type: "balance_sheet",
      base_account: "A",
    });
  });

  it("copies the levels rather than aliasing them", () => {
    const levels = ["A"];
    const snap = hierarchySnapshot(levels, null, null, null);
    levels[0] = "changed";
    expect(snap.levels[0]).toBe("A");
  });
});
