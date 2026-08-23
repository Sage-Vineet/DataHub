/**
 * Which set of books the Reports page is reading from.
 *
 * WHAT "AVAILABLE" MEANS NOW, AND WHY IT HAD TO CHANGE
 * ---------------------------------------------------
 * Legacy decided availability by probing four tables — `quickbooks_connections`,
 * `qb_synced_reports`, `sync_metadata` and `manual_gl_batches`. Three of the
 * four do not exist in the database, and `report_source_records` itself holds
 * zero rows, so the endpoint could not answer: every source came back
 * unavailable, or the read failed outright.
 *
 * There is no way to preserve behaviour that does not run, so availability is
 * redefined against something checkable: **a source is available when the
 * tables its own reports read hold data for this company.** That is the
 * question the selector is really asking — "will switching to this show me
 * anything?" — and it is now answerable:
 *
 *   quickbooks_online        `companies.quickbooks_connected`
 *   manual_gl_upload         the company has posted `general_ledger_entries`
 *   manual_upload_excel_pdf  documents are linked to a key-report version
 *   quickbooks_manual        nothing backs it; reported unavailable, honestly
 *
 * SELECTION IS NOT AVAILABILITY. A source can be selected while empty — that is
 * what a user sees immediately after switching and before uploading anything —
 * so switching is never blocked on availability. The two are separate fields
 * and the page renders them differently.
 */

export const REPORT_SOURCE_KEYS = {
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
  MANUAL_UPLOAD: "manual_upload_excel_pdf",
  QUICKBOOKS_MANUAL: "quickbooks_manual",
} as const;

export type ReportSourceKey = (typeof REPORT_SOURCE_KEYS)[keyof typeof REPORT_SOURCE_KEYS];

export const REPORT_SOURCE_LABELS: Readonly<Record<ReportSourceKey, string>> = {
  [REPORT_SOURCE_KEYS.QUICKBOOKS]: "QuickBooks Online",
  [REPORT_SOURCE_KEYS.MANUAL_GL]: "Manual GL Upload",
  [REPORT_SOURCE_KEYS.MANUAL_UPLOAD]: "Manual Upload (Excel or PDF)",
  [REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL]: "QuickBooks Manual",
};

/** Every key, in the order the selector lists them. */
export const ALL_SOURCE_KEYS: readonly ReportSourceKey[] = [
  REPORT_SOURCE_KEYS.QUICKBOOKS,
  REPORT_SOURCE_KEYS.MANUAL_GL,
  REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
  REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL,
];

/** The two keys that mean "somebody uploaded this by hand". */
export const MANUAL_SOURCE_KEYS: readonly ReportSourceKey[] = [
  REPORT_SOURCE_KEYS.MANUAL_GL,
  REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
];

export interface SourceRecord {
  sourceKey: string;
  sourceLabel: string;
  isSelected: boolean;
  isAvailable: boolean;
  isConnected: boolean;
  lastConnectedAt: string | null;
  lastSyncedAt: string | null;
  metadata: Record<string, unknown>;
}

/** What the company row says about its own sourcing. */
export interface CompanySourceState {
  dataSourceType: string | null;
  quickbooksConnected: boolean;
  lastSourceSwitchAt: string | null;
}

/** Which sources actually have something behind them, per company. */
export interface SourceAvailability {
  hasGeneralLedger: boolean;
  hasLinkedDocuments: boolean;
}

export interface ReportSourcesRepository {
  getCompanyState(companyId: string): Promise<CompanySourceState | null>;
  availability(companyId: string): Promise<SourceAvailability>;
  listRecords(companyId: string): Promise<SourceRecord[]>;
  /** Create any of the four that are missing. Idempotent. */
  ensureRecords(companyId: string, keys: readonly string[]): Promise<void>;
  /** Set availability/connectedness on one record. */
  updateRecord(
    companyId: string,
    sourceKey: string,
    patch: { isAvailable: boolean; isConnected: boolean },
  ): Promise<void>;
  /** Make exactly one record selected, and record the switch on the company. */
  select(companyId: string, sourceKey: string): Promise<void>;
}
