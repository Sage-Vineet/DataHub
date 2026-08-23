/**
 * Working out what kind of account something is, from its name and number.
 *
 * Only ever a fallback. When a statement states the type, that is the answer —
 * this is for a ledger that gives a name, maybe a number, and nothing else.
 *
 * THE NUMBER BEATS THE NAME, AND THAT IS A CHANGE
 * -----------------------------------------------
 * The version this replaces tested the name first and consulted the number
 * only when no keyword matched. So "Bank Charges & Fees" — an expense,
 * numbered 6100 — matched `\bbank\b` and became an ASSET, and the 6 was never
 * looked at. Same for "Car & Truck Expense" (`\btruck\b` → asset) and
 * "Credit Card Fees" (`\bcredit card\b` → liability).
 *
 * A numbered chart of accounts is an explicit statement of type by whoever set
 * it up. A keyword is a guess about English. When they disagree the explicit
 * statement wins, and the caller can see which of the two decided.
 *
 * The old ordering had a patch applied downstream — a second pass that
 * demoted P&L-sourced accounts back to expense unless a "strong" keyword
 * agreed. That patch is kept, because it is still needed for a chart with no
 * numbers at all, but it now catches far less.
 */

import type { CoaAccountType } from "./coa-hierarchy.js";

export type { CoaAccountType };

/**
 * How an account's type was decided.
 *
 * Reported rather than inferred, because "we read this off the statement",
 * "the account number says so" and "the name looked like one" are three very
 * different levels of confidence, and a person reviewing a chart needs to know
 * which they are looking at.
 */
export type ClassificationBasis = "stated" | "account_number" | "keyword" | "default";

export interface AccountClassification {
  accountType: CoaAccountType;
  basis: ClassificationBasis;
}

const NAME_RULES: ReadonlyArray<readonly [RegExp, CoaAccountType]> = [
  [
    /\bcash\b|\bbank\b|\bchecking\b|\bsavings\b|\breceivable\b|\ba\/r\b|\binventory\b|\basset\b|\bprepaid\b|\bfixed asset\b|\bequipment\b|\bmachinery\b|\bvehicle\b|\btruck\b|\bfurniture\b|\bfixture\b|\bcomputer\b|\bbuilding\b|\bland\b|\bmoney\s+market\b|\bundeposited\b|\bpetty\s+cash\b|\bcertificate\s+of\s+deposit\b/,
    "asset",
  ],
  [
    /\bpayable\b|\bloan\b|\bliability\b|\bcredit card\b|\bcc\b|\bvisa\b|\bmastercard\b|\bamex\b|\bdebt\b|\bnote payable\b|\bnotes payable\b/,
    "liability",
  ],
  [/\bequity\b|\bcapital\b|\bdraw\b|\bretained earnings\b|\bowner\b/, "equity"],
  [/\bsales\b|\brevenue\b|\bincome\b|\bfee\b|\brefunds?\b|\bdiscounts?\b|\bgain\b/, "income"],
  [/\bcogs\b|\bcost of goods\b|\bdirect cost\b/, "cogs"],
  [/\bexpense\b|\brent\b|\butilit\b|\bsalaries\b|\bwages\b|\btravel\b|\bmeals\b|\boffice\b/, "expense"],
];

/**
 * The conventional account-number ranges.
 *
 * 1 asset, 2 liability, 3 equity, 4 income, 5 cost of sales, 6–8 expense —
 * near-universal in small-business accounting. 9 is deliberately absent: it is
 * used for "other" and for statistical accounts and means nothing consistent.
 */
const NUMBER_RANGES: Readonly<Record<string, CoaAccountType>> = {
  "1": "asset",
  "2": "liability",
  "3": "equity",
  "4": "income",
  "5": "cogs",
  "6": "expense",
  "7": "expense",
  "8": "expense",
};

/** The type a chart's numbering says an account is, if it says anything. */
export function typeFromAccountNumber(accountNumber: string | null | undefined): CoaAccountType | null {
  const text = String(accountNumber ?? "").trim();
  // A number that does not START with a digit is not in a numbered scheme —
  // "A-100" or "GL/Cash" tell us nothing about a range.
  const first = text.charAt(0);
  return NUMBER_RANGES[first] ?? null;
}

/** The type an account's name suggests, if it suggests one. */
export function typeFromAccountName(accountName: string | null | undefined): CoaAccountType | null {
  const text = String(accountName ?? "").toLowerCase();
  if (text.trim() === "") return null;
  for (const [pattern, type] of NAME_RULES) {
    if (pattern.test(text)) return type;
  }
  return null;
}

/**
 * Keywords strong enough to move a P&L-sourced account onto the balance sheet.
 *
 * A general ledger's P&L section contains expenses. When an account there has
 * no stated type and no number, a broad keyword match is more likely wrong
 * than right — `\bbank\b` catches "Bank Charges", `\btruck\b` catches "Truck
 * Repairs". So a balance-sheet type only survives on a term that could not
 * plausibly be an expense.
 *
 * "credit card" is deliberately NOT here: "Credit Card Fees" and "Credit Card
 * Charges" are expenses. Only "Credit Card Payable" survives, through
 * `payable`.
 */
const STRONG_FROM_PL: Readonly<Record<"asset" | "liability" | "equity", RegExp>> = {
  asset:
    /\b(checking|savings|receivable|a\/r|inventory|prepaid|equipment|machinery|furniture|fixture|computer|building|cash\s+(and|&)\s+(cash\s+)?equivalent|money\s+market|undeposited|petty\s+cash|certificate\s+of\s+deposit)\b/i,
  liability: /\b(payable|a\/p|loan|mortgage|note\s+payable|line\s+of\s+credit)\b/i,
  equity: /\b(retained\s+earnings|owner.?s?\s+equity|capital\s+stock|common\s+stock)\b/i,
};

const BALANCE_SHEET_TYPES = new Set<CoaAccountType>(["asset", "liability", "equity"]);

export interface ClassifyAccountTypeInput {
  accountName: string | null | undefined;
  accountNumber?: string | null;
  /** The type the source statement stated, when it stated one. */
  statedType?: string | null;
  /**
   * Which statement the account was found on.
   *
   * `profit_loss` turns on the guard above: a keyword-derived balance-sheet
   * type from a P&L row is demoted to expense unless a strong term agrees.
   */
  source?: "profit_loss" | "balance_sheet" | "general_ledger" | null;
}

const KNOWN_TYPES = new Set<string>(["asset", "liability", "equity", "income", "cogs", "expense"]);

/** A stated type, normalised — or null if it is not one of the six. */
export function normaliseAccountType(value: string | null | undefined): CoaAccountType | null {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (KNOWN_TYPES.has(text)) return text as CoaAccountType;
  // The spellings a statement actually uses for cost of sales.
  if (text === "cost_of_goods_sold" || text === "cost_of_sales" || text === "cost_of_revenue") {
    return "cogs";
  }
  if (text === "revenue" || text === "sales") return "income";
  if (text === "expenses") return "expense";
  return null;
}

/**
 * What kind of account this is, and how confident that is.
 *
 * In order: what the statement said, what the number says, what the name
 * suggests, and finally expense — because an unclassified account still has to
 * go somewhere, and an expense that turns out to be an asset overstates costs,
 * where the reverse overstates profit. Overstating profit is the error that
 * costs somebody money.
 */
/**
 * Named for the TYPE, not just "classify".
 *
 * `classifyAccount` in `classify.ts` already means something else entirely —
 * an account's role in the EBITDA bridge. Two functions called the same thing
 * that answer different questions is how somebody calls the wrong one and gets
 * a plausible answer.
 */
export function classifyAccountType(input: ClassifyAccountTypeInput): AccountClassification {
  const stated = normaliseAccountType(input.statedType);
  if (stated) return { accountType: stated, basis: "stated" };

  // The number before the name. A numbered chart is an explicit statement of
  // type by whoever set it up; a keyword is a guess about English.
  const numbered = typeFromAccountNumber(input.accountNumber);
  if (numbered) return { accountType: numbered, basis: "account_number" };

  const named = typeFromAccountName(input.accountName);
  if (named) {
    if (
      input.source === "profit_loss" &&
      BALANCE_SHEET_TYPES.has(named) &&
      !STRONG_FROM_PL[named as "asset" | "liability" | "equity"].test(
        String(input.accountName ?? ""),
      )
    ) {
      return { accountType: "expense", basis: "default" };
    }
    return { accountType: named, basis: "keyword" };
  }

  return { accountType: "expense", basis: "default" };
}
