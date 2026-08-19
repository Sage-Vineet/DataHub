import type { Account } from "./types.js";

/**
 * Group balance-sheet accounts under the sub-headings a balance sheet has.
 *
 * UAT #7: *"the balance sheet is missing the various hierarchy levels, so
 * things are not organized or categorized into bank accounts, accounts
 * receivable, credit card liabilities, total current assets."*
 *
 * That depth is missing by construction on the legacy side. The chart-of-
 * accounts rules give assets, liabilities and equity a two-level prefix against
 * the profit-and-loss side's seven; equity gets no sub-grouping at all; the
 * current-vs-long-term branch is unreachable because extraction only ever
 * reports `assets | liabilities | equity`; and the uploaded statement's own
 * indentation is collapsed to a single flag before any of it runs.
 *
 * Precedence here is deliberate:
 *
 *   1. The statement's own sub-heading, when it survived ingestion. The
 *      uploaded document already knows that "Provident Bank Checking" sits
 *      under "Bank Accounts" — deriving what was given to us would be
 *      re-guessing a fact.
 *   2. Otherwise, derive it from the account.
 *
 * Nothing is invented: an account that matches no rule falls to the section's
 * general bucket, which is where a balance sheet puts it anyway.
 */

export type BalanceSheetGroup =
  | "Bank Accounts"
  | "Accounts Receivable"
  | "Other Current Assets"
  | "Fixed Assets"
  | "Other Assets"
  | "Credit Cards"
  | "Other Current Liabilities"
  | "Long-term Liabilities"
  | "Equity";

interface Rule {
  group: BalanceSheetGroup;
  test: RegExp;
  /**
   * False where the name alone cannot settle the question and the statement
   * has to. The clearest case is debt: this engagement files six "Loan
   * Payable" accounts as current and four as long-term, and nothing in the
   * names distinguishes them.
   */
  certain?: boolean;
}

/** Order matters: the first match wins, so specific rules precede general ones. */
const ASSET_RULES: Rule[] = [
  { group: "Fixed Assets", test: /accumulated (depreciation|amortization)/, certain: true },
  { group: "Bank Accounts", test: /\b(checking|savings|money market|bank|petty cash|cash)\b/, certain: true },
  { group: "Accounts Receivable", test: /\b(accounts? receivable|a\/?r)\b|receivable/, certain: true },
  {
    group: "Fixed Assets",
    test: /\b(furniture|fixtures?|equipment|machinery|vehicles?|leasehold|land|buildings?)\b|improvements?/,
    certain: true,
  },
  { group: "Other Current Assets", test: /\b(inventory|prepaid|due from|loans? to)\b/, certain: true },
  // Conventionally fixed, but this engagement's statement files it under Other
  // Assets — so the convention is a fallback, not a fact.
  { group: "Fixed Assets", test: /construction in progress/, certain: false },
  { group: "Other Assets", test: /\b(other long-?term|intangible|goodwill|security deposit)\b|amortization of financing/, certain: false },
];

const LIABILITY_RULES: Rule[] = [
  { group: "Credit Cards", test: /credit card/, certain: true },
  { group: "Long-term Liabilities", test: /\b(long-?term|mortgage)\b/, certain: true },
  { group: "Other Current Liabilities", test: /\b(accrued|deferred|customer deposit)\b/, certain: true },
  // Debt with no explicit term. Defaults to current because that is the more
  // conservative presentation, but the statement decides.
  { group: "Other Current Liabilities", test: /\b(loan|note)s? payable\b|payable/, certain: false },
];

function normalize(name: string): string {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface GroupAssignment {
  group: BalanceSheetGroup;
  /** True when the uploaded statement supplied it rather than a rule. */
  fromStatement: boolean;
  /**
   * True when the assignment follows from the account itself. False where a
   * convention was applied that the statement could legitimately contradict —
   * chiefly whether debt is current or long-term.
   */
  certain: boolean;
}

/** Derive the sub-heading for one account, with how much to trust it. */
export function assignGroup(
  account: Pick<Account, "name" | "accountType" | "group">,
): GroupAssignment | null {
  // The statement already told us. Prefer it over any derivation.
  if (account.group) {
    return { group: account.group as BalanceSheetGroup, fromStatement: true, certain: true };
  }

  const name = normalize(account.name);
  const match = (rules: Rule[], fallback: BalanceSheetGroup): GroupAssignment => {
    for (const rule of rules) {
      if (rule.test.test(name)) {
        return { group: rule.group, fromStatement: false, certain: rule.certain ?? false };
      }
    }
    return { group: fallback, fromStatement: false, certain: false };
  };

  switch (account.accountType) {
    case "asset":
      return match(ASSET_RULES, "Other Current Assets");
    case "liability":
      return match(LIABILITY_RULES, "Other Current Liabilities");
    case "equity":
      return { group: "Equity", fromStatement: false, certain: true };
    default:
      return null;
  }
}

/** The sub-heading alone, for callers that do not need the provenance. */
export function deriveGroup(
  account: Pick<Account, "name" | "accountType" | "group">,
): BalanceSheetGroup | null {
  return assignGroup(account)?.group ?? null;
}

/** Display order for the sub-headings, as a balance sheet presents them. */
export const GROUP_ORDER: BalanceSheetGroup[] = [
  "Bank Accounts",
  "Accounts Receivable",
  "Other Current Assets",
  "Fixed Assets",
  "Other Assets",
  "Credit Cards",
  "Other Current Liabilities",
  "Long-term Liabilities",
  "Equity",
];

export interface GroupedSection {
  section: "asset" | "liability" | "equity";
  groups: Array<{ group: BalanceSheetGroup; accountIds: string[] }>;
}

/** Arrange accounts into sections and sub-headings, in presentation order. */
export function groupBalanceSheet(
  accounts: Array<Pick<Account, "id" | "name" | "accountType" | "group">>,
): GroupedSection[] {
  const sections: Array<"asset" | "liability" | "equity"> = ["asset", "liability", "equity"];

  return sections.map((section) => {
    const buckets = new Map<BalanceSheetGroup, string[]>();
    for (const account of accounts) {
      if (account.accountType !== section) continue;
      const group = deriveGroup(account);
      if (!group) continue;
      const bucket = buckets.get(group);
      if (bucket) bucket.push(account.id);
      else buckets.set(group, [account.id]);
    }
    return {
      section,
      groups: GROUP_ORDER.filter((g) => buckets.has(g)).map((group) => ({
        group,
        accountIds: buckets.get(group)!,
      })),
    };
  });
}
