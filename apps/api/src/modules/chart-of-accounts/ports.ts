import type { CoaRow, HierarchySnapshot } from "./mapping.js";

/** A hand edit, as the caller expresses it. Absent fields are left alone. */
export interface AccountPatch {
  adjustedName?: string;
  accountType?: string;
  statementType?: string;
  levels?: Array<string | null>;
  isActive?: boolean;
  /** Distinguishes a re-parent from a re-label in the audit trail. */
  movedParent?: boolean;
}

/** The columns an edit writes. Snake-cased at the adapter, not here. */
export interface AccountUpdate {
  adjustedName?: string;
  accountType?: string;
  statementType?: string;
  isActive?: boolean;
  baseAccount?: string | null;
  hierarchyPath?: string | null;
  adjustedHierarchy?: HierarchySnapshot;
  levels?: Array<string | null>;
  classificationMethod: string;
  metadata: Record<string, unknown>;
}

export interface AdjustmentRecord {
  accountId: string;
  versionId: string;
  companyId: string | null;
  fieldChanged: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string | null;
  changedAt: string;
}

export interface ClassificationHistoryRecord {
  accountId: string;
  versionId: string;
  companyId: string | null;
  classificationMethod: string | null;
  hierarchySnapshot: unknown;
  source: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface HierarchyLevel {
  levelNumber: number;
  statementType: string | null;
  parentLabel: string | null;
  label: string;
  sortOrder: number;
  isStandard: boolean;
}

export interface ChartOfAccountsRepository {
  listByVersion(versionId: string): Promise<CoaRow[]>;
  getAccount(accountId: string): Promise<(CoaRow & { companyId: string | null }) | null>;
  updateAccount(accountId: string, update: AccountUpdate): Promise<CoaRow | null>;
  /**
   * Audit writes are separate calls rather than part of the update, because
   * they are best-effort: losing an audit row must not fail a person's edit,
   * and the service decides that rather than the adapter.
   */
  recordAdjustment(record: Omit<AdjustmentRecord, "changedAt">): Promise<void>;
  recordHistory(record: Omit<ClassificationHistoryRecord, "createdAt">): Promise<void>;
  listAdjustments(versionId: string): Promise<AdjustmentRecord[]>;
  listHistory(versionId: string): Promise<ClassificationHistoryRecord[]>;
  listHierarchyLevels(): Promise<HierarchyLevel[]>;
}
