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

export interface ReportSyncPort {
  sync(versionId: string): Promise<never>;
}
