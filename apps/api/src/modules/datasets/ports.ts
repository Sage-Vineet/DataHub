/**
 * Numbered snapshots of a company's imported data.
 *
 * The three operations a user actually performs: see what imports exist,
 * switch which one the reports read, and go back to an earlier one after an
 * import turned out to be wrong.
 */

export const DATASET_STATUSES = [
  "staging",
  "validating",
  "finalized",
  "failed",
  "rolled_back",
] as const;

export type DatasetStatus = (typeof DATASET_STATUSES)[number];

export interface DatasetVersionRecord {
  id: string;
  companyId: string;
  versionNumber: number;
  label: string | null;
  sourceKey: string;
  status: string;
  isActive: boolean;
  syncRunId: string | null;
  rowCount: number;
  fiscalYears: number[];
  finalizedAt: string | null;
  activatedAt: string | null;
  createdAt: string | null;
}

export interface CreateDatasetVersionInput {
  companyId: string;
  sourceKey: string;
  label: string | null;
  syncRunId: string | null;
  createdBy: string | null;
}

export interface FinalizeInput {
  rowCount: number;
  fiscalYears: number[];
}

export interface DatasetsRepository {
  list(companyId: string, filter: { sourceKey?: string; limit: number }): Promise<DatasetVersionRecord[]>;
  getById(companyId: string, id: string): Promise<DatasetVersionRecord | null>;
  active(companyId: string): Promise<DatasetVersionRecord | null>;
  /** Create the next version for a company and source. */
  create(input: CreateDatasetVersionInput): Promise<DatasetVersionRecord>;
  /** Move a staging version to finalized, so it can be activated. */
  finalize(id: string, input: FinalizeInput): Promise<DatasetVersionRecord | null>;
  fail(id: string, reason: string): Promise<void>;
  /**
   * Make one version the single active one, transactionally.
   *
   * `supersede` marks whatever was active as `rolled_back` rather than merely
   * deactivating it — the distinction matters when reading the list back, where
   * "this was current and was replaced" is different from "this never was".
   */
  activate(companyId: string, id: string, supersede: boolean): Promise<DatasetVersionRecord | null>;
}
