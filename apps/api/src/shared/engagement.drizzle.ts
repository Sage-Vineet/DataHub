import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { isStatementCaption } from "@datahub/financial-engine";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EbitdaRole } from "@datahub/contracts";
import { emptyToNull, postedAt } from "./ledger-row.js";

const { keyReportVersions, companies, chartOfAccounts, generalLedgerEntries, balanceSheetEntries } =
  schema;

/**
 * The engagement read model: everything `@datahub/financial-engine` needs for
 * one key-report version, assembled from the tables that actually hold it —
 * `chart_of_accounts`, `general_ledger_entries` and `balance_sheet_entries`.
 *
 * Shared rather than owned by a module because two now need it and the queries
 * are subtle: which GL rows count as posted, which balance-sheet rows are
 * captions rather than accounts, and how a balance-sheet section maps to an
 * account type. Two copies of that would drift, and the statements they produce
 * would then disagree with each other while both looking right.
 */
export interface EngagementData {
  companyId: string;
  companyName: string;
  profitMetric: "adjusted_ebitda" | "sde";
  marketRateReplacementSalary: number | null;
  fiscalYears: number[];
  accounts: Account[];
  entries: GlEntry[];
  /**
   * Balance-sheet statements to roll from, earliest first. Empty when none has
   * been ingested — the balance sheet cannot be derived without at least one.
   */
  anchors: BalanceSheetAnchor[];
}

const INCOME_TYPES = new Set(["income", "revenue", "other_income"]);
/** What the database calls cost of sales, however it was spelled on ingest. */
const COGS_TYPES = new Set(["cogs", "cost_of_goods_sold", "cost_of_sales"]);

/** `balance_sheet_entries.section` uses plurals; the engine uses the singular. */
const SECTION_TO_TYPE: Record<string, "asset" | "liability" | "equity"> = {
  assets: "asset",
  asset: "asset",
  liabilities: "liability",
  liability: "liability",
  equity: "equity",
};

/** Fiscal year and month from an `as_of_date`. */
function periodOf(asOf: string): { fiscalYear: number; month: number } {
  const [year, month] = asOf.split("-");
  return { fiscalYear: Number(year), month: Number(month ?? "12") };
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** A chart-of-accounts row, as the engagement reads it. */
export interface CoaRowForEngagement {
  id: string;
  accountName: string;
  statementType: string | null;
  accountType: string | null;
  ebitdaRole: string | null;
}

/**
 * One stored account as the engine's `Account`.
 *
 * Two things here are corrections rather than translation, and both were
 * silent when they were wrong:
 *
 * A balance-sheet account carries a real type. Returning null for one made
 * every liability and equity account fall back to "asset" in the roll-forward's
 * balance check, and put the debit/credit split in the trial balance on the
 * wrong side of the ledger.
 *
 * Cost of sales is preserved rather than folded into expense. Folding it kept
 * net income right — cogs is subtracted either way — but threw away the only
 * thing gross profit can be derived from, and discarded a QoE reclassification
 * to `cogs` on the way back out: the write succeeded and every subsequent read
 * said `expense`.
 */
export function toEngagementAccount(row: CoaRowForEngagement): Account {
  const statementType = row.statementType === "profit_loss" ? "profit_loss" : "balance_sheet";
  const type = String(row.accountType ?? "").toLowerCase();

  return {
    id: row.id,
    name: row.accountName,
    statementType,
    accountType:
      statementType === "profit_loss"
        // Lower-cased like the other two. Matched case-sensitively, an account
        // stored as "Revenue" missed the income set and fell through to
        // EXPENSE — which inverts its sign in every statement derived from it,
        // and still balances.
        ? INCOME_TYPES.has(type)
          ? "income"
          : COGS_TYPES.has(type)
            ? "cogs"
            : "expense"
        : (SECTION_TO_TYPE[type] ?? null),
    ebitdaRole: (row.ebitdaRole as EbitdaRole | null) ?? null,
  };
}

/** Load one version's accounts, ledger and balance-sheet anchors. */
export async function loadEngagement(db: Db, versionId: string): Promise<EngagementData | null> {
    const [version] = await db
      .select({ id: keyReportVersions.id, companyId: keyReportVersions.companyId })
      .from(keyReportVersions)
      .where(eq(keyReportVersions.id, versionId))
      .limit(1);
    if (!version) return null;

    const [company] = await db
      .select({
        name: companies.name,
        profitMetric: companies.profitMetric,
        replacement: sql<string | null>`market_rate_replacement_salary`,
      })
      .from(companies)
      .where(eq(companies.id, version.companyId))
      .limit(1);

    const coaRows = await db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.versionId, versionId));

    const accounts: Account[] = coaRows.map(toEngagementAccount);

    // Only posted transactions: header, beginning-balance and total rows would
    // double-count the very amounts they summarize.
    const glRows = await db
      .select({
        coaId: generalLedgerEntries.coaId,
        fiscalYear: generalLedgerEntries.fiscalYear,
        transactionDate: generalLedgerEntries.transactionDate,
        amount: generalLedgerEntries.amount,
        vendor: generalLedgerEntries.vendor,
      })
      .from(generalLedgerEntries)
      .where(
        and(
          eq(generalLedgerEntries.versionId, versionId),
          eq(generalLedgerEntries.rowType, "TRANSACTION"),
        ),
      );

    const entries: GlEntry[] = [];
    const years = new Set<number>();
    for (const row of glRows) {
      // Same placement the monthly drill-down uses. Two copies of "which year
      // is this row in?" is one that can drift, and the drift shows as two
      // reports disagreeing about the company's own ledger.
      const posted = postedAt(row);
      if (!posted) continue;
      years.add(posted.fiscalYear);
      entries.push({
        ...posted,
        amount: toNumber(row.amount),
        vendor: emptyToNull(row.vendor),
      });
    }

    const anchors = await loadAnchors(db, versionId);

    return {
      companyId: version.companyId,
      companyName: company?.name ?? "",
      profitMetric: company?.profitMetric === "sde" ? "sde" : "adjusted_ebitda",
      marketRateReplacementSalary: company?.replacement ? toNumber(company.replacement) : null,
      fiscalYears: [...years].sort((a, b) => a - b),
      accounts,
      entries,
      anchors,
    };
  }

  /**
   * Balance-sheet statements usable as roll-forward anchors.
   *
   * Subtotal rows (`is_total`) and rows this system previously generated
   * (`is_generated`) are excluded: feeding a derived figure back in as an
   * anchor would compound whatever produced it. Statements are returned
   * earliest-first, so the earliest is rolled from and any later one becomes a
   * tie-out.
   */

/** Balance-sheet statements for a version, earliest first. */
export async function loadAnchors(db: Db, versionId: string): Promise<BalanceSheetAnchor[]> {
    const rows = await db
      .select({
        asOfDate: balanceSheetEntries.asOfDate,
        accountName: balanceSheetEntries.accountName,
        section: balanceSheetEntries.section,
        subSection: balanceSheetEntries.subSection,
        amount: balanceSheetEntries.amount,
        coaId: balanceSheetEntries.coaId,
        hierarchyLevel: balanceSheetEntries.hierarchyLevel,
        isTotal: balanceSheetEntries.isTotal,
      })
      .from(balanceSheetEntries)
      .where(
        and(
          eq(balanceSheetEntries.versionId, versionId),
          or(isNull(balanceSheetEntries.isTotal), ne(balanceSheetEntries.isTotal, true)),
          or(isNull(balanceSheetEntries.isGenerated), ne(balanceSheetEntries.isGenerated, true)),
        ),
      )
      .orderBy(asc(balanceSheetEntries.asOfDate), asc(balanceSheetEntries.sortOrder));

    // `hierarchy_level` only tells us anything when it actually varies — the
    // column defaults to 0, so a statement where nothing set it would otherwise
    // look like nothing but section headers.
    const levelsAreMeaningful = new Set(rows.map((r) => r.hierarchyLevel)).size > 1;

    const byDate = new Map<string, BalanceSheetAnchor>();
    for (const row of rows) {
      if (!row.asOfDate || !row.accountName) continue;
      const section = SECTION_TO_TYPE[String(row.section ?? "").toLowerCase()];
      if (!section) continue;
      // A parent caption is structure, not an account. Extraction filters
      // subtotals but not headings, so "Bank Accounts" arrives looking like a
      // balance and would be double-counted against the accounts beneath it
      // (UAT #4).
      if (
        isStatementCaption(
          {
            accountName: row.accountName,
            hierarchyLevel: row.hierarchyLevel,
            isTotal: row.isTotal,
          },
          { levelsAreMeaningful },
        )
      ) {
        continue;
      }

      let anchor = byDate.get(row.asOfDate);
      if (!anchor) {
        const { fiscalYear, month } = periodOf(row.asOfDate);
        anchor = { kind: "starting", fiscalYear, month, rows: [] };
        byDate.set(row.asOfDate, anchor);
      }
      anchor.rows.push({
        accountId: row.coaId ?? row.accountName,
        accountName: row.accountName,
        section,
        group: row.subSection ?? null,
        amount: toNumber(row.amount),
      });
    }

    const anchors = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, anchor]) => anchor);

    // The earliest statement is the one rolled FROM; anything later states a
    // closing position and is only used to check against.
    return anchors.map((anchor, index) => ({
      ...anchor,
      kind: index === 0 ? "starting" : "ending",
    }));
  }

