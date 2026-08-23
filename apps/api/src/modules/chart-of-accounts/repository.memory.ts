import { columnsToLevels, MAX_LEVELS, type CoaRow } from "./mapping.js";
import type {
  AccountUpdate,
  AdjustmentRecord,
  ChartOfAccountsRepository,
  ClassificationHistoryRecord,
  HierarchyLevel,
} from "./ports.js";

type StoredRow = CoaRow & { companyId: string | null };

/** In-memory chart of accounts for service tests. */
export class InMemoryChartOfAccountsRepository implements ChartOfAccountsRepository {
  private readonly rows = new Map<string, StoredRow>();
  readonly adjustments: AdjustmentRecord[] = [];
  readonly history: ClassificationHistoryRecord[] = [];
  private levels: HierarchyLevel[] = [];
  private clock = Date.UTC(2024, 0, 1);

  seed(row: Partial<StoredRow> & { id: string; versionId: string }): StoredRow {
    const full: StoredRow = {
      companyId: "company-1",
      accountNumber: null,
      accountName: row.id,
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
      ...row,
    };
    this.rows.set(full.id, full);
    return full;
  }

  seedHierarchyLevels(levels: HierarchyLevel[]): void {
    this.levels = levels;
  }

  private stamp(): string {
    return new Date(this.clock++).toISOString();
  }

  listByVersion(versionId: string): Promise<CoaRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.versionId === versionId)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    );
  }

  getAccount(accountId: string): Promise<StoredRow | null> {
    return Promise.resolve(this.rows.get(accountId) ?? null);
  }

  updateAccount(accountId: string, update: AccountUpdate): Promise<CoaRow | null> {
    const row = this.rows.get(accountId);
    if (!row) return Promise.resolve(null);

    const next: StoredRow = {
      ...row,
      classificationMethod: update.classificationMethod,
      metadata: update.metadata as StoredRow["metadata"],
    };
    if (update.adjustedName !== undefined) next.adjustedName = update.adjustedName || null;
    if (update.accountType !== undefined) next.accountType = update.accountType;
    if (update.statementType !== undefined) next.statementType = update.statementType;
    if (update.isActive !== undefined) next.isActive = update.isActive;
    if (update.baseAccount !== undefined) next.baseAccount = update.baseAccount;
    if (update.hierarchyPath !== undefined) next.hierarchyPath = update.hierarchyPath;
    if (update.levels !== undefined) next.levels = [...update.levels];

    this.rows.set(accountId, next);
    return Promise.resolve(next);
  }

  recordAdjustment(record: Omit<AdjustmentRecord, "changedAt">): Promise<void> {
    this.adjustments.push({ ...record, changedAt: this.stamp() });
    return Promise.resolve();
  }

  recordHistory(record: Omit<ClassificationHistoryRecord, "createdAt">): Promise<void> {
    this.history.push({ ...record, createdAt: this.stamp() });
    return Promise.resolve();
  }

  listAdjustments(versionId: string): Promise<AdjustmentRecord[]> {
    return Promise.resolve(this.adjustments.filter((a) => a.versionId === versionId));
  }

  listHistory(versionId: string): Promise<ClassificationHistoryRecord[]> {
    return Promise.resolve(this.history.filter((h) => h.versionId === versionId));
  }

  listHierarchyLevels(): Promise<HierarchyLevel[]> {
    return Promise.resolve(this.levels);
  }
}

/** Re-exported so tests can build rows without importing the mapping module. */
export { columnsToLevels };
