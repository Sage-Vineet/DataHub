import {
  buildLevelsFromPath,
  classifyAccountType,
  classifyStandardised,
  STATEMENT_BY_TYPE,
  type ClassificationBasis,
  type CoaAccountType,
} from "@datahub/financial-engine";

/**
 * Building a chart of accounts out of what extraction stored.
 *
 * The entry tables hold one row per transaction or per statement line. A chart
 * of accounts is the DISTINCT accounts across all of them, each classified and
 * placed in the standardised hierarchy — so this is a fold over rows, and it
 * is pure. Reading the rows and writing the chart happen elsewhere; getting
 * those mixed with the classification is how the classification went untested.
 *
 * WHAT COUNTS AS THE SAME ACCOUNT
 * -------------------------------
 * The NAME is the identity and the number disambiguates — not the other way
 * round. Keying on the number first looks tidier and is wrong: the same
 * account appears as "6000 Office Rent" in one export and "Office Rent" in
 * another, and a number-first key makes those two accounts, splitting one
 * line's figures across two that each look plausible.
 *
 * So rows are bucketed by name, matched case-insensitively with whitespace
 * collapsed — "Rent" and "rent " are one line on one statement. Within a
 * bucket, two rows carrying DIFFERENT numbers are two accounts, because a
 * chart that numbers them apart means them apart. A row with no number joins
 * whichever entry is already there.
 */

/** A row as it comes out of one of the entry tables. */
export interface SourceAccountRow {
  accountName: string | null;
  accountNumber?: string | null;
  /** The type the statement stated, when it stated one. */
  accountType?: string | null;
  /** Which statement this row was found on. */
  source: "profit_loss" | "balance_sheet" | "general_ledger";
  /** The balance sheet's own section, which beats a keyword for liabilities. */
  bsSection?: string | null;
  fiscalYear?: number | null;
}

/** One account, ready to store. */
export interface GeneratedAccount {
  accountKey: string;
  accountName: string;
  accountNumber: string | null;
  accountType: CoaAccountType;
  statementType: "balance_sheet" | "profit_loss";
  /** How the type was decided — stated, numbered, guessed, or defaulted. */
  classificationMethod: ClassificationBasis;
  levels: Array<string | null>;
  hierarchyPath: string;
  baseAccount: string;
  sortOrder: number;
  /** Which statements this account appeared on, for a reader checking it. */
  sources: string[];
  fiscalYears: number[];
}

/**
 * Rows that are not accounts.
 *
 * Extraction keeps a statement's totals and headings as rows, because they
 * carry figures. They are not accounts, and letting one into the chart creates
 * an "account" called "Total Expenses" that then rolls up under Total
 * Expenses — double counting every expense beneath it.
 */

/** A statement's own furniture — the header lines above the figures. */
const REPORT_FURNITURE =
  /^(accrual basis|cash basis|report generated|date generated|generated on|as of\b|unrealized gains?)/i;

/**
 * A total or a derived line.
 *
 * `^total\b` is deliberately broad, and it has a cost: an account genuinely
 * called "Total Quality Services Ltd" is excluded. That is the trade legacy
 * made and it is kept, because the two errors are not symmetric — a total
 * admitted as an account rolls up under itself and double counts every figure
 * beneath it, silently and everywhere, where a dropped account is one line
 * missing from one chart. Narrowing this is a change to what the numbers say,
 * not a tidy-up, and belongs with somebody who can look at the result.
 */
const TOTAL_OR_DERIVED =
  /(^total\b|\btotal$|\bsubtotal\b|\bnet income\b|\bnet loss\b|\bgross profit\b|\bnet operating income\b|\bnet operating loss\b|\boperating income\b|\bpretax income\b|\bincome before taxes?\b|\bnet revenue\b)/i;

/**
 * A section heading, matched exactly.
 *
 * Exactly, not by prefix: "Current Assets" is a heading and "Current Assets
 * Clearing" is an account. A prefix match would swallow the second.
 */
const SECTION_LABELS = new Set([
  "assets", "liabilities", "equity", "income", "revenue", "expense", "expenses",
  "current assets", "fixed assets", "other assets", "other current assets",
  "current liabilities", "long-term liabilities", "long term liabilities",
  "other current liabilities", "other liabilities", "cost of goods sold",
  "liabilities and equity", "liabilities & equity", "total liabilities and equity",
]);

export function isNonAccountRow(name: string | null | undefined): boolean {
  const text = String(name ?? "").trim();
  if (text === "") return true;
  if (REPORT_FURNITURE.test(text)) return true;
  if (TOTAL_OR_DERIVED.test(text)) return true;
  return SECTION_LABELS.has(text.toLowerCase().replace(/\s+/g, " "));
}

/** A name, as the buckets compare it. */
export function nameKeyOf(accountName: string | null | undefined): string {
  return String(accountName ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * The stable identity of one account, once its rows have been folded together.
 *
 * Name AND number, matching the two partial unique indexes the table carries:
 * numbered accounts are unique on `(version, number, name)` and unnumbered
 * ones on `(version, name)`. Anything else here would let the generator
 * produce two rows the database then refuses.
 */
export function accountKeyOf(
  accountName: string | null | undefined,
  accountNumber: string | null | undefined,
): string {
  const number = String(accountNumber ?? "").trim().toLowerCase();
  return number === "" ? nameKeyOf(accountName) : `${number}|${nameKeyOf(accountName)}`;
}

/**
 * Fold the entry rows into a chart of accounts.
 *
 * The order of the result is the order accounts should appear in: statement
 * first, then the hierarchy path, then the account. Stable, so a rebuild that
 * changes nothing produces the same `sort_order` for every row and no
 * spurious updates.
 */
export function buildChartOfAccounts(rows: readonly SourceAccountRow[]): GeneratedAccount[] {
  interface Accumulated {
    accountName: string;
    accountNumber: string | null;
    statedType: string | null;
    bsSection: string | null;
    source: SourceAccountRow["source"];
    sources: Set<string>;
    fiscalYears: Set<number>;
  }

  // Bucketed by NAME; the number splits a bucket rather than forming the key.
  const byName = new Map<string, Accumulated[]>();

  for (const row of rows) {
    const name = String(row.accountName ?? "").trim();
    if (isNonAccountRow(name)) continue;

    const number = String(row.accountNumber ?? "").trim() || null;
    const bucket = byName.get(nameKeyOf(name)) ?? [];

    // A row with a number matches an entry with the SAME number, or one that
    // has none yet. A row without one joins whatever is already there — the
    // commonest case is one account exported twice, once numbered.
    const existing = bucket.find((entry) =>
      number && entry.accountNumber ? entry.accountNumber === number : true,
    );

    if (!existing) {
      bucket.push({
        accountName: name,
        accountNumber: number,
        statedType: row.accountType ?? null,
        bsSection: row.bsSection ?? null,
        source: row.source,
        sources: new Set([row.source]),
        fiscalYears: new Set(row.fiscalYear ? [row.fiscalYear] : []),
      });
      byName.set(nameKeyOf(name), bucket);
      continue;
    }

    existing.sources.add(row.source);
    if (row.fiscalYear) existing.fiscalYears.add(row.fiscalYear);
    // A number learned later fills one that was missing — the same account can
    // appear numbered on a balance sheet and bare in a ledger.
    existing.accountNumber ??= number;
    // A STATED type beats an absent one, whichever row carried it. A balance
    // sheet says what its accounts are; a ledger usually does not.
    existing.statedType ??= row.accountType ?? null;
    existing.bsSection ??= row.bsSection ?? null;
    // A balance-sheet sighting settles the type guard: the account is on the
    // balance sheet, so a keyword pointing there is not a P&L misreading.
    if (row.source === "balance_sheet") existing.source = "balance_sheet";
  }

  const accounts = [...byName.values()].flat().map((acc) => {
    const accountKey = accountKeyOf(acc.accountName, acc.accountNumber);
    const { accountType, basis } = classifyAccountType({
      accountName: acc.accountName,
      accountNumber: acc.accountNumber,
      statedType: acc.statedType,
      source: acc.source,
    });

    const standard = classifyStandardised({
      accountName: acc.accountName,
      accountNumber: acc.accountNumber,
      accountType,
      bsSection: acc.bsSection,
    });

    // No deeper company-specific levels here: those come from the review step,
    // which asks a model and records what a person accepted. This produces the
    // deterministic part, which is the part that must be right without anyone
    // looking at it.
    const { levels, hierarchyPath } = buildLevelsFromPath(
      standard.levels,
      standard.depth,
      [],
      acc.accountName,
    );

    return {
      accountKey,
      accountName: acc.accountName,
      accountNumber: acc.accountNumber,
      accountType,
      statementType: STATEMENT_BY_TYPE[accountType],
      classificationMethod: basis,
      levels,
      hierarchyPath,
      baseAccount: acc.accountName,
      sortOrder: 0,
      sources: [...acc.sources].sort(),
      fiscalYears: [...acc.fiscalYears].sort((a, b) => a - b),
    };
  });

  // Balance sheet before P&L, then by path, then by name — the order a person
  // reading a chart expects, and stable so a rebuild that changes nothing
  // produces no updates.
  accounts.sort(
    (a, b) =>
      a.statementType.localeCompare(b.statementType) ||
      a.hierarchyPath.localeCompare(b.hierarchyPath) ||
      a.accountName.localeCompare(b.accountName),
  );

  return accounts.map((account, index) => ({ ...account, sortOrder: index }));
}
