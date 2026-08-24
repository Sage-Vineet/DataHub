import type { StatementNode } from "@datahub/financial-engine";

/**
 * A model-read statement, flattened into the rows the entry tables hold.
 *
 * `balance_sheet_entries` and `profit_loss_entries` are what the financial
 * engine reads: `loadAnchors` rolls the balance sheet forward from them, and
 * the chart of accounts is regenerated from them. Nothing in the gateway wrote
 * either table until now — they were filled by the legacy extraction pipeline
 * alone, which is why porting the sync that fills them matters more than its
 * route count suggests.
 *
 * WHAT A TOTAL IS, AND WHY IT IS A COLUMN
 * ---------------------------------------
 * A node with children is a heading or a subtotal — "Bank Accounts", "Total
 * Current Assets" — and its amount is the sum of what sits under it. Stored as
 * an account it would be counted AGAINST the accounts beneath it, and the
 * sheet would still balance: it would just be wrong by the size of every
 * heading. `is_total` is a column rather than something inferred from the name
 * downstream, because "Total Revenue" and "Totalisator Receipts" are not
 * distinguishable by name and one of them is an account.
 */

/** One row as an entry table holds it. */
export interface StatementEntryRow {
  accountName: string;
  accountNumber: string | null;
  accountType: string | null;
  /** Balance sheet: assets | liabilities | equity. Null on a P&L. */
  section: string | null;
  /** The heading it presents under — "Bank Accounts", "Operating Expenses". */
  subSection: string | null;
  amount: number;
  /** Depth in the statement's own tree, roots at 0. */
  hierarchyLevel: number;
  /** Reading order, so the page renders the statement as it was written. */
  sortOrder: number;
  isTotal: boolean;
}

/** Two decimal places, and never `-0`. */
function round2(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * An account number written into the name.
 *
 * Charts export "4000 Sales" and "4000 · Sales" as often as they carry a
 * separate column. Split here rather than left in the name, because the
 * classifier and the chart of accounts both key on the number when there is
 * one — and "4000 Sales" and "Sales" are two accounts to anything comparing
 * names.
 */
export function splitAccountName(raw: string): { name: string; number: string | null } {
  const text = raw.trim();
  const match = text.match(/^([0-9][0-9.-]*)\s*(?:[·:|–—-]\s*|\s+)(.+)$/);
  if (!match) return { name: text, number: null };

  const number = match[1]!.replace(/[.-]+$/, "");
  const name = match[2]!.trim();
  // A number with nothing after it is not an account number, it is the whole
  // name — a row called "2024" is a year heading, not account 2024.
  if (name === "") return { name: text, number: null };
  return { name, number };
}

/** Is this the balance sheet's own top-level section? */
function sectionOf(rootName: string): string | null {
  const text = rootName.trim().toLowerCase();
  if (/liabilit/.test(text)) return "liabilities";
  if (/equity|capital|shareholder|owner/.test(text)) return "equity";
  if (/asset/.test(text)) return "assets";
  return null;
}

export interface FlattenOptions {
  /** A balance sheet carries a section; a profit and loss does not. */
  kind: "balance_sheet" | "profit_and_loss";
}

/**
 * Walk the statement, depth first, in the order it was written.
 *
 * Depth first and in order, because the page renders the result as a
 * statement: a row's position IS information, and re-sorting it by name or
 * amount produces something nobody recognises as their own accounts.
 */
export function flattenStatement(
  rows: readonly StatementNode[],
  options: FlattenOptions,
): StatementEntryRow[] {
  const out: StatementEntryRow[] = [];
  let sortOrder = 0;

  const walk = (
    node: StatementNode,
    depth: number,
    rootName: string,
    parentName: string | null,
  ): void => {
    const rawName = String(node.name ?? "").trim();
    // A row with no name is a spacer the statement carries for layout. Stored,
    // it becomes an account called "" that every grouping has to special-case.
    if (rawName === "") return;

    const children = Array.isArray(node.children) ? node.children : [];
    const { name, number } = splitAccountName(rawName);

    out.push({
      accountName: name,
      accountNumber: number,
      accountType: node.type === undefined || node.type === null ? null : String(node.type),
      section: options.kind === "balance_sheet" ? sectionOf(rootName) : null,
      // The heading it sits under, which is its parent unless it IS one of the
      // statement's own sections.
      subSection: parentName,
      amount: round2(typeof node.amount === "number" ? node.amount : 0),
      hierarchyLevel: depth,
      sortOrder: (sortOrder += 1),
      isTotal: children.length > 0,
    });

    for (const child of children) walk(child, depth + 1, rootName, name);
  };

  for (const root of rows) {
    const rootName = String(root?.name ?? "").trim();
    walk(root, 0, rootName, null);
  }
  return out;
}

/**
 * The fiscal years a flattened statement covers.
 *
 * One, in practice — a statement states one position or one period — but it is
 * derived rather than assumed so a caller can tell a statement that named no
 * year from one that named a year nobody expected.
 */
export function yearsIn(entries: readonly StatementEntryRow[], fiscalYear: number): number[] {
  return entries.length > 0 ? [fiscalYear] : [];
}
