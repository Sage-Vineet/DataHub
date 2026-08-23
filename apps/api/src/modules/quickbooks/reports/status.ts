import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../../shared/errors.js";
import type { DatasetsRepository } from "../../datasets/ports.js";
import type { StatementsRepository } from "../../statements/ports.js";
import { toProgress } from "../../sync/progress.js";
import type { SyncRepository } from "../../sync/ports.js";
import { QUICKBOOKS_SOURCE_KEY } from "./service.js";

/**
 * The state of a company's QuickBooks sync.
 *
 * A composed read across three tables that legacy read across four ABSENT
 * ones — `sync_metadata`, `sync_jobs`, `finalized_datasets` and
 * `qb_synced_reports`, none of which exists, which is why this endpoint has
 * been answering nothing.
 *
 * It reads rather than stores. Legacy kept a `sync_metadata` row per company
 * carrying a duplicate of the current job's status and progress, which is two
 * places for one fact and the second one goes stale the moment a process dies
 * mid-write. The run itself is the fact; everything here is derived from it.
 */

/** One report held for the current dataset. */
export interface CachedReportSummary {
  reportType: string;
  reportParams: Record<string, unknown>;
  lastSyncedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface QuickBooksSyncStatus {
  companyId: string;
  source: "cached_snapshot";
  syncStatus: string;
  syncProgress: number;
  syncJobId: string | null;
  datasetVersion: string | null;
  lastSuccessfulSync: string | null;
  lastAttemptedSync: string | null;
  lastError: string | null;
  totalCachedReports: number;
  reports: CachedReportSummary[];
}

export interface QuickBooksSyncStatusDeps {
  runs: SyncRepository;
  datasets: DatasetsRepository;
  statements: StatementsRepository;
}

export class QuickBooksSyncStatusService {
  constructor(private readonly deps: QuickBooksSyncStatusDeps) {}

  async status(
    user: SessionUser,
    companyId: string,
    now = new Date(),
  ): Promise<QuickBooksSyncStatus> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const [run, active, held] = await Promise.all([
      this.deps.runs.current(companyId, { sourceKey: QUICKBOOKS_SOURCE_KEY }),
      this.deps.datasets.active(companyId),
      this.deps.statements.list(companyId, { sourceKey: QUICKBOOKS_SOURCE_KEY }),
    ]);

    // `toProgress` is the same derivation the progress endpoint uses, which is
    // what stops the two disagreeing about whether a sync is running — legacy
    // had one read `sync_metadata` and the other `sync_jobs`, and they could
    // and did answer differently.
    const progress = toProgress(run, now);

    return {
      companyId,
      source: "cached_snapshot",
      syncStatus: progress.status,
      syncProgress: progress.percentage,
      syncJobId: progress.runId,
      datasetVersion: active?.id ?? null,
      // The dataset's finalization, not the run's finish: a run can end in
      // failure, and reporting its end as a successful sync is how a page
      // tells somebody their data is current when it is not.
      lastSuccessfulSync: active?.finalizedAt ?? null,
      lastAttemptedSync: progress.startedAt,
      lastError: progress.errorMessage,
      totalCachedReports: held.length,
      reports: held.map((extract) => ({
        reportType: extract.statementType,
        reportParams: extract.reportParams,
        lastSyncedAt: extract.extractedAt,
        periodStart: extract.periodStart,
        periodEnd: extract.periodEnd,
      })),
    };
  }
}
