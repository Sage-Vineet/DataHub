import type { CompanyStatus, ProfitMetric } from "@datahub/contracts";

/**
 * A company as the module works with it (camelCase; integration-managed columns
 * included for reads but never written by update). `since` is an ISO date string.
 */
export interface CompanyRecord {
  id: string;
  name: string;
  projectName: string | null;
  industry: string | null;
  status: CompanyStatus;
  since: string | null;
  logo: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  profitMetric: ProfitMetric;
  dataSourceType: string | null;
  quickbooksConnected: boolean;
  manualUploadActive: boolean;
}

/** Fields the repository writes on create (already validated + normalized). */
export interface CompanyCreateInput {
  name: string;
  projectName: string | null;
  industry: string | null;
  status: CompanyStatus;
  since: string | null;
  logo: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  profitMetric: ProfitMetric;
}

/** Safe-field patch for update — only keys present are written. */
export type CompanyUpdatePatch = Partial<CompanyCreateInput>;

/** Request-count stats for a company (from the `requests` domain, via a port). */
export interface CompanyStats {
  total: number;
  pending: number;
  completed: number;
}

/**
 * Data access for companies. Two adapters: Drizzle (runtime) and in-memory
 * (tests). Raw SQL lives only in the Drizzle adapter (blueprint rule).
 */
/** One row of the deal activity feed, with the actor's name already resolved. */
export interface ActivityRecord {
  id: string;
  companyId: string;
  type: "upload" | "request" | "approved" | "reminder";
  message: string;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface CompaniesRepository {
  getById(id: string): Promise<CompanyRecord | null>;
  /** Most recent activity on a deal, newest first. */
  listActivity(companyId: string, limit: number): Promise<ActivityRecord[]>;
  listAll(): Promise<CompanyRecord[]>;
  listByIds(ids: readonly string[]): Promise<CompanyRecord[]>;
  create(input: CompanyCreateInput): Promise<CompanyRecord>;
  /** Apply a safe-field patch; returns the updated row or null if absent. */
  updateSafeFields(id: string, patch: CompanyUpdatePatch): Promise<CompanyRecord | null>;
  /** Associate a user with a company (idempotent) — used to link the creator. */
  linkUserCompany(userId: string, companyId: string): Promise<void>;
  /** The 4-step cascade, atomically (design D4). */
  cascadeDelete(id: string): Promise<void>;
}

/**
 * Request-count stats live in the `requests` domain. Exposed as a read port so
 * the companies repository never reaches into another domain's tables (design D5).
 */
export interface CompanyStatsPort {
  countsFor(companyIds: readonly string[]): Promise<Map<string, CompanyStats>>;
}

/**
 * Default-folder provisioning is a `folders` concern (design D3). Legacy-backed
 * now; swapped for the folders module service when it lands — no contract change.
 */
export interface FolderProvisioningPort {
  ensureDefaultFolders(companyId: string, createdBy: string): Promise<void>;
}

/**
 * Client-representative sync is a `users` concern (design D3): create/update the
 * buyer user tied to a company's contact email. Legacy-backed now; swapped for the
 * users module service later.
 */
export interface UserProvisioningPort {
  syncClientRepresentative(
    company: { id: string; contactEmail: string | null; contactName: string | null },
    previous?: { contactEmail: string | null },
  ): Promise<void>;
}
