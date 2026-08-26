import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import {
  REPORT_SOURCE_LABELS,
  type CompanySourceState,
  type ReportSourceKey,
  type ReportSourcesRepository,
  type SourceAvailability,
  type SourceRecord,
} from "./ports.js";

const { companies, generalLedgerEntries, keyReportFileMappings, reportSourceRecords } = schema;

export class DrizzleReportSourcesRepository implements ReportSourcesRepository {
  constructor(private readonly db: Db) {}

  async getCompanyState(companyId: string): Promise<CompanySourceState | null> {
    // `data_source_type`, `quickbooks_connected` and `last_source_switch_at`
    // are on the deployed `companies` table but not modelled on it, so they are
    // named in raw SQL rather than by widening a table five other modules read.
    const [row] = await this.db
      .select({
        dataSourceType: sql<string | null>`data_source_type`,
        quickbooksConnected: sql<boolean | null>`quickbooks_connected`,
        lastSourceSwitchAt: sql<Date | null>`last_source_switch_at`,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!row) return null;
    return {
      dataSourceType: row.dataSourceType ?? null,
      quickbooksConnected: Boolean(row.quickbooksConnected),
      lastSourceSwitchAt: row.lastSourceSwitchAt
        ? new Date(row.lastSourceSwitchAt).toISOString()
        : null,
    };
  }

  async availability(companyId: string): Promise<SourceAvailability> {
    // `limit(1)` on both: the question is whether ANY row exists, and counting
    // 3,723 ledger rows to answer "more than zero" is work for nothing.
    const [ledger] = await this.db
      .select({ id: generalLedgerEntries.id })
      .from(generalLedgerEntries)
      .where(eq(generalLedgerEntries.companyId, companyId))
      .limit(1);

    const [linked] = await this.db
      .select({ id: keyReportFileMappings.id })
      .from(keyReportFileMappings)
      .where(eq(keyReportFileMappings.companyId, companyId))
      .limit(1);

    return { hasGeneralLedger: Boolean(ledger), hasLinkedDocuments: Boolean(linked) };
  }

  async listRecords(companyId: string): Promise<SourceRecord[]> {
    const rows = await this.db
      .select()
      .from(reportSourceRecords)
      .where(eq(reportSourceRecords.companyId, companyId))
      .orderBy(asc(reportSourceRecords.sourceLabel));
    return rows.map((row) => ({
      sourceKey: row.sourceKey,
      sourceLabel: row.sourceLabel,
      isSelected: row.isSelected,
      isAvailable: row.isAvailable,
      isConnected: row.isConnected,
      lastConnectedAt: row.lastConnectedAt ? row.lastConnectedAt.toISOString() : null,
      lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  async ensureRecords(companyId: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    // `doNothing` rather than an upsert: this only creates what is missing, and
    // must never reset the selection or availability of a row already there.
    await this.db
      .insert(reportSourceRecords)
      .values(
        keys.map((sourceKey) => ({
          companyId,
          sourceKey,
          sourceLabel: REPORT_SOURCE_LABELS[sourceKey as ReportSourceKey] ?? sourceKey,
        })),
      )
      .onConflictDoNothing({
        target: [reportSourceRecords.companyId, reportSourceRecords.sourceKey],
      });
  }

  async updateRecord(
    companyId: string,
    sourceKey: string,
    patch: { isAvailable: boolean; isConnected: boolean },
  ): Promise<void> {
    await this.db
      .update(reportSourceRecords)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(reportSourceRecords.companyId, companyId),
          eq(reportSourceRecords.sourceKey, sourceKey),
        ),
      );
  }

  async select(companyId: string, sourceKey: string): Promise<void> {
    // Clear then set, in one transaction: a reader between the two statements
    // would otherwise see a company with no selected source at all and seed a
    // default over the switch in progress.
    await this.db.transaction(async (tx) => {
      await tx
        .update(reportSourceRecords)
        .set({ isSelected: false, updatedAt: new Date() })
        .where(eq(reportSourceRecords.companyId, companyId));
      await tx
        .update(reportSourceRecords)
        .set({ isSelected: true, updatedAt: new Date() })
        .where(
          and(
            eq(reportSourceRecords.companyId, companyId),
            eq(reportSourceRecords.sourceKey, sourceKey),
          ),
        );
      // Keep the denormalized cache on `companies` in step, so anything still
      // reading it agrees with the records rather than contradicting them.
      //
      // Raw SQL because these three columns are on the deployed table but not
      // modelled — casting them onto the Drizzle type would compile and emit
      // nothing.
      await tx.execute(sql`
        UPDATE companies
           SET data_source_type = ${sourceKey},
               last_source_switch_at = now()
         WHERE id = ${companyId}
      `);
    });
  }
}
