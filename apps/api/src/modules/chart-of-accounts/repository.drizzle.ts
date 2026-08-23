import { asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { columnsToLevels, levelsToColumns, type CoaRow } from "./mapping.js";
import type {
  AccountUpdate,
  AdjustmentRecord,
  ChartOfAccountsRepository,
  ClassificationHistoryRecord,
  HierarchyLevel,
} from "./ports.js";

const { chartOfAccounts, coaAccountAdjustments, coaClassificationHistory, coaHierarchyLevels } =
  schema;

type Row = typeof chartOfAccounts.$inferSelect;

function toRow(r: Row): CoaRow & { companyId: string | null } {
  return {
    id: r.id,
    versionId: r.versionId,
    companyId: r.companyId,
    accountNumber: r.accountNumber,
    accountName: r.accountName,
    parentAccountId: r.parentAccountId,
    accountType: r.accountType,
    statementType: r.statementType,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    baseAccount: r.baseAccount,
    hierarchyPath: r.hierarchyPath,
    accountIdName: r.accountIdName,
    classificationMethod: r.classificationMethod,
    originalName: r.originalName,
    adjustedName: r.adjustedName,
    metadata: r.metadata,
    levels: columnsToLevels(r as unknown as Record<string, unknown>),
  };
}

/** The chart of accounts over Postgres. */
export class DrizzleChartOfAccountsRepository implements ChartOfAccountsRepository {
  constructor(private readonly db: Db) {}

  async listByVersion(versionId: string): Promise<CoaRow[]> {
    const rows = await this.db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.versionId, versionId))
      .orderBy(asc(chartOfAccounts.sortOrder));
    return rows.map(toRow);
  }

  async getAccount(accountId: string): Promise<(CoaRow & { companyId: string | null }) | null> {
    const rows = await this.db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, accountId))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async updateAccount(accountId: string, update: AccountUpdate): Promise<CoaRow | null> {
    const set: Record<string, unknown> = {
      classificationMethod: update.classificationMethod,
      metadata: update.metadata,
      updatedAt: new Date(),
    };
    if (update.adjustedName !== undefined) set.adjustedName = update.adjustedName || null;
    if (update.accountType !== undefined) set.accountType = update.accountType;
    if (update.statementType !== undefined) set.statementType = update.statementType;
    if (update.isActive !== undefined) set.isActive = update.isActive;
    if (update.baseAccount !== undefined) set.baseAccount = update.baseAccount;
    if (update.hierarchyPath !== undefined) set.hierarchyPath = update.hierarchyPath;
    if (update.adjustedHierarchy !== undefined) set.adjustedHierarchy = update.adjustedHierarchy;
    if (update.levels !== undefined) Object.assign(set, levelsToColumns(update.levels));

    const rows = await this.db
      .update(chartOfAccounts)
      .set(set)
      .where(eq(chartOfAccounts.id, accountId))
      .returning();
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * Audit writes never fail the caller's edit.
   *
   * Losing a history row is bad; refusing somebody's reclassification because
   * the audit table rejected a write is worse, and legacy made the same choice
   * for the same reason.
   */
  async recordAdjustment(record: Omit<AdjustmentRecord, "changedAt">): Promise<void> {
    try {
      await this.db.insert(coaAccountAdjustments).values({
        accountId: record.accountId,
        versionId: record.versionId,
        companyId: record.companyId,
        fieldChanged: record.fieldChanged,
        oldValue: record.oldValue,
        newValue: record.newValue,
        changedBy: record.changedBy,
      });
    } catch (err) {
      console.warn(`[chart-of-accounts] adjustment log skipped: ${String(err)}`);
    }
  }

  async recordHistory(record: Omit<ClassificationHistoryRecord, "createdAt">): Promise<void> {
    try {
      await this.db.insert(coaClassificationHistory).values({
        accountId: record.accountId,
        versionId: record.versionId,
        companyId: record.companyId,
        classificationMethod: record.classificationMethod,
        hierarchySnapshot: record.hierarchySnapshot,
        source: record.source,
        createdBy: record.createdBy,
      });
    } catch (err) {
      console.warn(`[chart-of-accounts] history log skipped: ${String(err)}`);
    }
  }

  async listAdjustments(versionId: string): Promise<AdjustmentRecord[]> {
    const rows = await this.db
      .select()
      .from(coaAccountAdjustments)
      .where(eq(coaAccountAdjustments.versionId, versionId))
      .orderBy(desc(coaAccountAdjustments.changedAt));
    return rows.map((r) => ({
      accountId: r.accountId,
      versionId: r.versionId,
      companyId: r.companyId,
      fieldChanged: r.fieldChanged,
      oldValue: r.oldValue,
      newValue: r.newValue,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
    }));
  }

  async listHistory(versionId: string): Promise<ClassificationHistoryRecord[]> {
    const rows = await this.db
      .select()
      .from(coaClassificationHistory)
      .where(eq(coaClassificationHistory.versionId, versionId))
      .orderBy(desc(coaClassificationHistory.createdAt));
    return rows.map((r) => ({
      accountId: r.accountId,
      versionId: r.versionId,
      companyId: r.companyId,
      classificationMethod: r.classificationMethod,
      hierarchySnapshot: r.hierarchySnapshot,
      source: r.source,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async listHierarchyLevels(): Promise<HierarchyLevel[]> {
    const rows = await this.db
      .select()
      .from(coaHierarchyLevels)
      .orderBy(asc(coaHierarchyLevels.levelNumber), asc(coaHierarchyLevels.sortOrder));
    return rows.map((r) => ({
      levelNumber: r.levelNumber,
      statementType: r.statementType,
      parentLabel: r.parentLabel,
      label: r.label,
      sortOrder: r.sortOrder,
      isStandard: r.isStandard,
    }));
  }
}
