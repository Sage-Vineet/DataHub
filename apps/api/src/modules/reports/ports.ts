import type { SessionUser } from "@datahub/contracts";
import type { EngagementData } from "../../shared/engagement.drizzle.js";

import type { ReportVersionStatus } from "@datahub/contracts";

export interface VersionRecord {
  id: string;
  companyId: string;
  versionNumber: number;
  versionName: string | null;
  status: ReportVersionStatus;
  isActive: boolean;
  resolvedBatchId: string | null;
  lastSyncedAt: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
}

export interface CreateVersionInput {
  companyId: string;
  versionName: string | null;
  metadata: Record<string, unknown>;
  createdBy: string;
}

export type UpdateVersionPatch = {
  versionName?: string | null;
  status?: ReportVersionStatus;
  metadata?: Record<string, unknown>;
};

export interface ReportsRepository {
  listByCompany(companyId: string): Promise<VersionRecord[]>;
  getById(id: string): Promise<VersionRecord | null>;
  /** Create a new draft with `version_number = max(company) + 1`. */
  create(input: CreateVersionInput): Promise<VersionRecord>;
  update(id: string, patch: UpdateVersionPatch): Promise<VersionRecord | null>;
  delete(id: string): Promise<void>;
  /** Copy name/metadata into a new inactive draft. */
  duplicate(id: string, createdBy: string): Promise<VersionRecord | null>;
  /** Make this version the single active one for its company (transactional). */
  activate(id: string): Promise<VersionRecord | null>;
}

/** The seam for the (not-yet-migrated) GL sync/computation engine (design D5). */
/**
 * The engagement behind a version — accounts, ledger and balance-sheet anchors.
 *
 * A port rather than a direct call so the service can be tested with a fixture
 * engagement instead of a database, and so the module never reaches into the
 * tables another domain owns.
 */
export interface EngagementPort {
  load(versionId: string): Promise<EngagementData | null>;
}

/**
 * Building a version's entry tables from the files linked to it.
 *
 * A port rather than the service, so a deployment with no model configured can
 * supply one that says so — and so the reports service never has to know
 * whether extraction is available.
 */
export interface ReportSyncPort {
  sync(user: SessionUser, versionId: string): Promise<unknown>;
}

/**
 * One posted general-ledger row, for the drill-down under a monthly-detail
 * account line.
 *
 * Separate from the engine's `GlEntry`, which is deliberately narrow — the
 * engine needs an account, a period and an amount and nothing else. These are
 * presentation fields, and putting them on `GlEntry` would widen the engine's
 * input for the sake of a table.
 *
 * `debit`, `credit`, `description`, `reference` and `journalType` are nullable
 * because the columns exist but the current extractor does not populate them:
 * in the demo ledger, 3,723 posted rows carry a date, 2,295 carry a vendor, and
 * none carries any of the rest. Emitting zero for an unpopulated debit would
 * state a fact the ledger does not contain.
 */
export interface LedgerTransaction {
  id: string;
  accountId: string;
  fiscalYear: number;
  /** 1–12; `0` where the row carries no usable date. */
  month: number;
  date: string | null;
  vendorName: string | null;
  description: string | null;
  reference: string | null;
  journalType: string | null;
  /** Unsigned, as exported: revenue and cost both arrive positive. */
  amount: number;
  debit: number | null;
  credit: number | null;
}

/** The posted ledger behind a version, at transaction grain. */
export interface LedgerDetailPort {
  list(versionId: string): Promise<LedgerTransaction[]>;
}

/** The five categories a key-report version files documents under. */
export const REPORT_CATEGORIES = [
  "profit_loss",
  "balance_sheet",
  "general_ledger",
  "bank_statement",
  "tax_return",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** A Data Room document linked to one category of a version. */
export interface MappingRecord {
  id: string;
  versionId: string;
  companyId: string;
  reportCategory: string;
  documentId: string | null;
  uploadId: string | null;
  fileName: string | null;
  year: number | null;
  status: string;
  linkedBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export interface LinkDocumentInput {
  versionId: string;
  companyId: string;
  reportCategory: ReportCategory;
  documentId: string;
  uploadId: string | null;
  fileName: string | null;
  year: number | null;
  linkedBy: string | null;
}

/** The Data Room document a mapping points at, as far as this module needs it. */
export interface LinkedDocument {
  id: string;
  companyId: string;
  name: string | null;
  uploadId: string | null;
}

export interface MappingsRepository {
  listByVersion(versionId: string): Promise<MappingRecord[]>;
  getById(mappingId: string): Promise<MappingRecord | null>;
  /**
   * Link a document, or return the existing row unchanged.
   *
   * Idempotent on `(version_id, report_category, document_id)`: the SPA
   * re-sends its whole selection whenever a checkbox changes, so linking the
   * same file twice must not produce a second row.
   */
  link(input: LinkDocumentInput): Promise<MappingRecord>;
  delete(mappingId: string): Promise<void>;
  /** Is this document still linked anywhere in the version? */
  countForDocument(versionId: string, documentId: string): Promise<number>;
  getDocument(documentId: string): Promise<LinkedDocument | null>;
  /** Hold the document in place so the Data Room will not delete it. */
  addFileReference(input: {
    companyId: string;
    documentId: string;
    linkedEntityId: string;
    createdBy: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  removeFileReference(documentId: string, linkedEntityId: string): Promise<void>;
}

/** One recorded attempt at syncing a version's documents into the report tables. */
export interface SyncLogRecord {
  id: number;
  versionId: string;
  companyId: string;
  syncStatus: string;
  syncStartedAt: string | null;
  syncCompletedAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string | null;
}

export interface SyncLogsRepository {
  /** Newest first, capped — the page shows the last few attempts. */
  listByVersion(versionId: string, limit: number): Promise<SyncLogRecord[]>;
}

/** A per-user setting, keyed by name. */
export interface PreferencesRepository {
  get(userId: string, key: string): Promise<Record<string, unknown> | null>;
  set(userId: string, key: string, value: Record<string, unknown>): Promise<void>;
}
