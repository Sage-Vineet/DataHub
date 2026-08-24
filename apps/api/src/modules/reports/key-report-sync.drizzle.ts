import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { StatementEntryWriter, SyncLogWriter } from "./key-report-sync.js";
import type { StatementEntryRow } from "./statement-entries.js";

const { balanceSheetEntries, profitLossEntries, keyReportSyncLogs } = schema;

/**
 * Writing a read statement into the entry tables.
 *
 * Two tables rather than one because they answer different questions: a
 * balance sheet states a position on a DATE and carries a section, while a
 * profit and loss covers a YEAR and carries a category. Folding them together
 * would mean a nullable date on half the rows and a section nobody sets on the
 * other half.
 */
export class DrizzleStatementEntryWriter implements StatementEntryWriter {
  constructor(private readonly db: Db) {}

  /**
   * Remove the rows this system derived.
   *
   * Only the balance sheet has them: `is_generated` exists on
   * `balance_sheet_entries` alone, because the carry-forward that produces
   * generated rows is a balance-sheet operation. A profit and loss is never
   * carried forward — a period's figures are that period's.
   */
  async clearGenerated(versionId: string): Promise<number> {
    const removed = await this.db
      .delete(balanceSheetEntries)
      .where(
        and(
          eq(balanceSheetEntries.versionId, versionId),
          eq(balanceSheetEntries.isGenerated, true),
        ),
      )
      .returning({ id: balanceSheetEntries.id });
    return removed.length;
  }

  /**
   * Replace one document's rows, in one transaction.
   *
   * Delete-then-insert rather than upsert: a re-read of the same file can
   * produce FEWER rows than last time — a statement corrected to drop a line —
   * and an upsert would leave the dropped ones behind, where every report
   * would keep counting them.
   *
   * Scoped to the document, so re-syncing one file does not empty the others.
   */
  async replaceForDocument(input: {
    versionId: string;
    companyId: string;
    documentId: string;
    kind: "balance_sheet" | "profit_and_loss";
    fiscalYear: number;
    asOfDate: string | null;
    rows: readonly StatementEntryRow[];
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      if (input.kind === "balance_sheet") {
        await tx
          .delete(balanceSheetEntries)
          .where(
            and(
              eq(balanceSheetEntries.versionId, input.versionId),
              eq(balanceSheetEntries.sourceFileId, input.documentId),
            ),
          );
        if (input.rows.length === 0) return 0;

        await tx.insert(balanceSheetEntries).values(
          input.rows.map((row) => ({
            versionId: input.versionId,
            companyId: input.companyId,
            sourceFileId: input.documentId,
            // NOT NULL on the table: a position with no date anchors nothing,
            // and the caller resolves one before it gets here.
            asOfDate: input.asOfDate ?? `${input.fiscalYear}-12-31`,
            fiscalYear: input.fiscalYear,
            accountName: row.accountName,
            accountNumber: row.accountNumber,
            accountType: row.accountType,
            section: row.section,
            subSection: row.subSection,
            amount: row.amount.toFixed(2),
            hierarchyLevel: row.hierarchyLevel,
            sortOrder: row.sortOrder,
            isTotal: row.isTotal,
            isGenerated: false,
          })),
        );
        return input.rows.length;
      }

      await tx
        .delete(profitLossEntries)
        .where(
          and(
            eq(profitLossEntries.versionId, input.versionId),
            eq(profitLossEntries.sourceFileId, input.documentId),
          ),
        );
      if (input.rows.length === 0) return 0;

      await tx.insert(profitLossEntries).values(
        input.rows.map((row) => ({
          versionId: input.versionId,
          companyId: input.companyId,
          sourceFileId: input.documentId,
          fiscalYear: input.fiscalYear,
          accountName: row.accountName,
          accountNumber: row.accountNumber,
          accountType: row.accountType,
          // A P&L's heading is its category — "Income", "Operating Expenses" —
          // which is the same thing the balance sheet calls a sub-section.
          category: row.subSection,
          subCategory: null,
          amount: row.amount.toFixed(2),
          hierarchyLevel: row.hierarchyLevel,
          sortOrder: row.sortOrder,
          isTotal: row.isTotal,
        })),
      );
      return input.rows.length;
    });
  }
}

/** The sync log a version's page reads to say when it was last built. */
export class DrizzleSyncLogWriter implements SyncLogWriter {
  constructor(private readonly db: Db) {}

  async start(input: {
    versionId: string;
    companyId: string;
    createdBy: string | null;
  }): Promise<number> {
    const [row] = await this.db
      .insert(keyReportSyncLogs)
      .values({
        versionId: input.versionId,
        companyId: input.companyId,
        syncStatus: "started",
        createdBy: input.createdBy,
      })
      .returning({ id: keyReportSyncLogs.id });
    return row!.id;
  }

  async finish(
    id: number,
    input: {
      status: "success" | "failed";
      errorMessage?: string | null;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.db
      .update(keyReportSyncLogs)
      .set({
        syncStatus: input.status,
        syncCompletedAt: new Date(),
        errorMessage: input.errorMessage ?? null,
        metadata: input.metadata,
      })
      .where(eq(keyReportSyncLogs.id, id));
  }
}
