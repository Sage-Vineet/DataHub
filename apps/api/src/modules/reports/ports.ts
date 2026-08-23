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
