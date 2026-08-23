import { and, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { buildChartOfAccounts, type GeneratedAccount, type SourceAccountRow } from "./generate.js";

const {
  balanceSheetEntries,
  chartOfAccounts,
  generalLedgerEntries,
  profitLossEntries,
} = schema;

/**
 * Rebuilding a version's chart of accounts from what extraction stored.
 *
 * The classification is pure and lives in `generate.ts`. This is the part that
 * reads rows and writes the chart — kept apart so the rules are testable
 * without a database, which is why they had never been tested before.
 *
 * WHAT A REBUILD MUST NOT DESTROY
 * -------------------------------
 * A chart account carries two kinds of thing: what the rules produced, and
 * what a PERSON decided afterwards — a renamed account, a moved one, one
 * deactivated. The rules can be recomputed from the entries at any time. The
 * decisions cannot be recovered from anything, so a rebuild rewrites the
 * derived columns and leaves the adjusted ones exactly as they are.
 */

/**
 * Ledger rows that are not transactions.
 *
 * A general-ledger export carries "Beginning Balance" and "Ending Balance"
 * lines per account, and they are rows about an account rather than an account
 * of their own. Excluded by `row_type`, which says what kind of row it is,
 * rather than by matching the text — a name-based rule would also catch an
 * account genuinely called "Ending Balance Adjustment".
 */
const LEDGER_NON_TRANSACTION_ROW_TYPES = [
  "account_header",
  "beginning_balance",
  "ending_balance",
  "total_row",
  "total",
  "header",
];

export interface RegenerateResult {
  accountCount: number;
  /** Accounts removed because nothing extracted mentions them any more. */
  removedCount: number;
  /** Accounts that were already there and kept their id and any edits. */
  keptCount: number;
}

export class DrizzleChartOfAccountsGenerator {
  constructor(private readonly db: Db) {}

  /** Every account named anywhere in a version's extracted entries. */
  async collect(versionId: string): Promise<SourceAccountRow[]> {
    const [ledger, balanceSheet, profitLoss] = await Promise.all([
      this.db
        .select({
          accountName: generalLedgerEntries.accountName,
          distributionAccount: generalLedgerEntries.distributionAccount,
          accountNumber: generalLedgerEntries.accountNumber,
          accountType: generalLedgerEntries.accountType,
          fiscalYear: generalLedgerEntries.fiscalYear,
          rowType: generalLedgerEntries.rowType,
        })
        .from(generalLedgerEntries)
        .where(
          and(
            eq(generalLedgerEntries.versionId, versionId),
            // Compared case-insensitively: the column defaults to
            // `TRANSACTION` in upper case and older writers used lower. A
            // case-sensitive list matches neither reliably, which admits every
            // balance row into the chart as an account.
            //
            // No `IS NULL` branch: the column is NOT NULL with a default, so a
            // row that predates it carries `TRANSACTION` rather than nothing.
            // A guard for a null here would be a branch that can never run.
            notInArray(
              sql`lower(${generalLedgerEntries.rowType})`,
              LEDGER_NON_TRANSACTION_ROW_TYPES,
            ),
          ),
        ),
      this.db
        .select({
          accountName: balanceSheetEntries.accountName,
          accountNumber: balanceSheetEntries.accountNumber,
          accountType: balanceSheetEntries.accountType,
          section: balanceSheetEntries.section,
          fiscalYear: balanceSheetEntries.fiscalYear,
          isTotal: balanceSheetEntries.isTotal,
        })
        .from(balanceSheetEntries)
        .where(
          and(
            eq(balanceSheetEntries.versionId, versionId),
            // A subtotal the extractor produced. Feeding one back in as an
            // account double counts everything beneath it.
            or(isNull(balanceSheetEntries.isTotal), ne(balanceSheetEntries.isTotal, true)),
          ),
        ),
      this.db
        .select({
          accountName: profitLossEntries.accountName,
          accountNumber: profitLossEntries.accountNumber,
          accountType: profitLossEntries.accountType,
          fiscalYear: profitLossEntries.fiscalYear,
          isTotal: profitLossEntries.isTotal,
        })
        .from(profitLossEntries)
        .where(
          and(
            eq(profitLossEntries.versionId, versionId),
            or(isNull(profitLossEntries.isTotal), ne(profitLossEntries.isTotal, true)),
          ),
        ),
    ]);

    return [
      ...ledger.map(
        (row): SourceAccountRow => ({
          // A QuickBooks ledger names the account in `distribution_account`; a
          // hand-built one uses `account_name`. Either is the account.
          accountName: row.accountName ?? row.distributionAccount,
          accountNumber: row.accountNumber,
          accountType: row.accountType,
          fiscalYear: row.fiscalYear,
          source: "general_ledger",
        }),
      ),
      ...balanceSheet.map(
        (row): SourceAccountRow => ({
          accountName: row.accountName,
          accountNumber: row.accountNumber,
          accountType: row.accountType,
          bsSection: row.section,
          fiscalYear: row.fiscalYear,
          source: "balance_sheet",
        }),
      ),
      ...profitLoss.map(
        (row): SourceAccountRow => ({
          accountName: row.accountName,
          accountNumber: row.accountNumber,
          accountType: row.accountType,
          fiscalYear: row.fiscalYear,
          source: "profit_loss",
        }),
      ),
    ];
  }

  /**
   * Rebuild the chart, in one transaction.
   *
   * One transaction because a half-rebuilt chart is worse than a stale one:
   * every report groups by it, so a chart missing half its accounts produces
   * statements that are quietly short rather than obviously broken.
   */
  async regenerate(
    companyId: string,
    versionId: string,
  ): Promise<RegenerateResult & { accounts: GeneratedAccount[] }> {
    const accounts = buildChartOfAccounts(await this.collect(versionId));

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.versionId, versionId));

      const existingByKey = new Map(
        existing.map((row) => [keyOf(row.accountName, row.accountNumber), row]),
      );

      const keptIds: string[] = [];
      let keptCount = 0;
      for (const account of accounts) {
        const prior = existingByKey.get(keyOf(account.accountName, account.accountNumber));
        const derived = {
          accountType: account.accountType,
          statementType: account.statementType,
          classificationMethod: account.classificationMethod,
          sortOrder: account.sortOrder,
          baseAccount: account.baseAccount,
          hierarchyPath: account.hierarchyPath,
          ...levelColumns(account.levels),
        };

        if (prior) {
          keptIds.push(prior.id);
          keptCount += 1;
          await tx
            .update(chartOfAccounts)
            // Only the derived columns. `adjustedName`, `adjustedHierarchy`
            // and `isActive` are what a person decided and are not recoverable
            // from anything, so a rebuild must not touch them.
            .set({ ...derived, updatedAt: new Date() })
            .where(eq(chartOfAccounts.id, prior.id));
          continue;
        }

        const [inserted] = await tx
          .insert(chartOfAccounts)
          .values({
            versionId,
            companyId,
            accountName: account.accountName,
            accountNumber: account.accountNumber,
            isActive: true,
            // Which statements mention this account, and in which years, is
            // deliberately NOT stored. It is a query over the entries, and a
            // denormalised copy here goes stale the moment extraction runs
            // again — a chart that says an account appears in 2023 when the
            // re-extraction dropped that year is worse than one that says
            // nothing. `metadata` is a typed column with a known shape, and
            // widening it to hold this would give up that typing for a cache
            // nobody asked for.
            // The rules' own answer, kept beside whatever is edited later so
            // "restore to the original classification" has something to
            // restore to.
            originalName: account.accountName,
            originalHierarchy: account.levels,
            ...derived,
          })
          .returning({ id: chartOfAccounts.id });
        if (inserted) keptIds.push(inserted.id);
      }

      // Anything the entries no longer mention. Deleted rather than
      // deactivated: `is_active` is a person's decision to hide an account
      // that still exists, and reusing it for "this account is gone" would
      // make the two indistinguishable on screen.
      const removed = await tx
        .delete(chartOfAccounts)
        .where(
          keptIds.length > 0
            ? and(
                eq(chartOfAccounts.versionId, versionId),
                notInArray(chartOfAccounts.id, keptIds),
              )
            : eq(chartOfAccounts.versionId, versionId),
        )
        .returning({ id: chartOfAccounts.id });

      return {
        accounts,
        accountCount: accounts.length,
        keptCount,
        removedCount: removed.length,
      };
    });
  }
}

/** The same identity the generator uses, for matching against what is stored. */
function keyOf(accountName: string, accountNumber: string | null): string {
  const number = String(accountNumber ?? "").trim().toLowerCase();
  const name = String(accountName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return number === "" ? name : `${number}|${name}`;
}

/**
 * The fifteen level columns, from the array.
 *
 * Spelled out rather than built by a loop, because the table's columns are
 * fifteen distinct fields and a dynamically-keyed object loses the type that
 * catches a typo in one of them.
 */
function levelColumns(levels: ReadonlyArray<string | null>) {
  return {
    level1: levels[0] ?? null,
    level2: levels[1] ?? null,
    level3: levels[2] ?? null,
    level4: levels[3] ?? null,
    level5: levels[4] ?? null,
    level6: levels[5] ?? null,
    level7: levels[6] ?? null,
    level8: levels[7] ?? null,
    level9: levels[8] ?? null,
    level10: levels[9] ?? null,
    level11: levels[10] ?? null,
    level12: levels[11] ?? null,
    level13: levels[12] ?? null,
    level14: levels[13] ?? null,
    level15: levels[14] ?? null,
  };
}

/** Exported for a test that checks the level array reaches the columns. */
export { keyOf as chartAccountKeyOf, levelColumns };
