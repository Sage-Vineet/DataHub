import type { SessionUser } from "@datahub/contracts";
import { HttpError } from "../../../shared/errors.js";
import type { FinishInput, ProgressPatch, SyncRunRecord } from "../../sync/ports.js";
import { QuickBooksAuthError, type QbReportType } from "./client.js";
import { QUICKBOOKS_SOURCE_KEY } from "./service.js";

/**
 * Pulling a company's whole reporting history from QuickBooks.
 *
 * One period at a time, one report at a time, recorded against a `sync_runs`
 * row so the page can watch it and so a run that dies is recoverable.
 *
 * WHAT REPLACES THE IN-PROCESS MAP
 * --------------------------------
 * Legacy tracked a running sync in `backgroundSyncByCompany`, a Map in the
 * request process. Two consequences: two gateway instances each started their
 * own sync for the same company and neither knew about the other, and a
 * restart lost the record entirely while the work was still half-done.
 *
 * `sync_runs` carries a partial unique index over unfinished runs per company
 * and source, so the DATABASE refuses the second one. That is the only place
 * the refusal can be correct, because it is the only thing both instances
 * share.
 *
 * AND THE SLEEP
 * -------------
 * Legacy answered 202 after `await new Promise(r => setTimeout(r, 60))` — a
 * sixty-millisecond wait hoping the worker had created its row. On a slow
 * database it had not, and the caller got a status naming no run. The run is
 * started BEFORE the response here, so the response always names a real one.
 */

/** The reports a full sync pulls, in the order it pulls them. */
export const SYNC_REPORT_TYPES: readonly QbReportType[] = [
  "balance_sheet",
  "profit_and_loss",
  "cash_flow",
  "general_ledger",
  "account_list",
];

export interface SyncPlanPeriod {
  startDate: string;
  endDate: string;
}

/**
 * The periods a sync covers.
 *
 * Whole calendar years back from the most recent complete one. Monthly
 * granularity is a separate request — `summarize_column_by=Month` on one year
 * — rather than twelve pulls, which is what the reports actually support.
 */
export function yearlyPeriods(yearsBack: number, today: Date): SyncPlanPeriod[] {
  const capped = Math.min(Math.max(Math.trunc(yearsBack), 1), 10);
  const thisYear = today.getUTCFullYear();
  const periods: SyncPlanPeriod[] = [];
  for (let offset = 0; offset < capped; offset += 1) {
    const year = thisYear - offset;
    periods.push({ startDate: `${year}-01-01`, endDate: `${year}-12-31` });
  }
  return periods;
}

export interface SyncPlanStep {
  reportType: QbReportType;
  period: SyncPlanPeriod | null;
}

/**
 * Everything a sync will fetch.
 *
 * An account list has no period — it is the chart as it stands — so it is
 * pulled once rather than once per year. Pulling it per year would store the
 * same list under five keys and make "the latest" mean whichever year finished
 * last.
 */
export function buildSyncPlan(yearsBack: number, today: Date): SyncPlanStep[] {
  const periods = yearlyPeriods(yearsBack, today);
  const steps: SyncPlanStep[] = [];

  for (const reportType of SYNC_REPORT_TYPES) {
    if (reportType === "account_list") {
      steps.push({ reportType, period: null });
      continue;
    }
    for (const period of periods) steps.push({ reportType, period });
  }
  return steps;
}

/**
 * The part of the reports service a sync uses.
 *
 * Narrower than the class on purpose: a sync fetches reports, and naming only
 * that keeps the dependency honest and lets a test stand something small in
 * its place.
 */
export interface ReportServer {
  serve(
    user: SessionUser,
    companyId: string,
    reportType: QbReportType,
    rawQuery: Record<string, unknown>,
    options?: { force?: boolean },
  ): Promise<unknown>;
}

/**
 * The part of the sync service a QuickBooks sync uses.
 *
 * `SyncService` already owns the access check, the reaping of stalled runs and
 * the 409 that refuses a second unfinished run of one source. Depending on it
 * rather than on the repository keeps that in one place — two implementations
 * of "is another sync already going?" is how they come to disagree.
 */
export interface SyncRunner {
  start(
    user: SessionUser,
    companyId: string,
    input: { sourceKey: string; kind?: string; totalFiles?: number },
    now?: Date,
  ): Promise<SyncRunRecord>;
  advance(
    user: SessionUser,
    companyId: string,
    runId: string,
    patch: ProgressPatch,
  ): Promise<void>;
  finish(
    user: SessionUser,
    companyId: string,
    runId: string,
    input: FinishInput,
  ): Promise<void>;
}

export interface QuickBooksSyncServiceDeps {
  runs: SyncRunner;
  reports: ReportServer;
}

/** One report-and-period that could not be fetched. */
export interface SyncFailure {
  reportType: string;
  period: string;
  message: string;
}

export interface SyncOutcome {
  fetched: number;
  failed: SyncFailure[];
}

export interface StartedSync {
  run: SyncRunRecord;
  /** How many report-and-period pairs the run will fetch. */
  totalSteps: number;
}

export class QuickBooksSyncService {
  constructor(private readonly deps: QuickBooksSyncServiceDeps) {}

  /**
   * Start a sync, and answer once the run exists.
   *
   * The pulls happen after the response. A caller watches
   * `/api/quickbooks/sync-status`, which reads the same run — so the progress
   * it sees is the run's own, not a second copy that can disagree.
   *
   * A second sync while one is running is a 409 rather than a queue: two syncs
   * of one source race each other into the same rows and the later writer wins
   * by accident of timing.
   */
  async start(
    user: SessionUser,
    companyId: string,
    options: { yearsBack?: number; accountingMethod?: string } = {},
    now = new Date(),
  ): Promise<StartedSync> {
    const plan = buildSyncPlan(options.yearsBack ?? 4, now);

    // Checks the company, reaps a stalled run so a crashed sync does not hold
    // the button hostage forever, and throws 409 when one is genuinely still
    // going.
    const run = await this.deps.runs.start(
      user,
      companyId,
      { sourceKey: QUICKBOOKS_SOURCE_KEY, kind: "full", totalFiles: plan.length },
      now,
    );

    return { run, totalSteps: plan.length };
  }

  /**
   * Run the plan.
   *
   * Separate from `start` so the route can answer as soon as the run exists
   * and drive this afterwards. Each step advances the run, which is both the
   * progress bar and the heartbeat that stops the run being reaped as stalled.
   *
   * One step failing does not fail the run: a company with no cash-flow report
   * for 2019 should still get its 2020-2024 balance sheets. What failed is
   * counted and named in the result.
   */
  async run(
    user: SessionUser,
    companyId: string,
    runId: string,
    options: { yearsBack?: number; accountingMethod?: string } = {},
    now = new Date(),
  ): Promise<SyncOutcome> {
    const plan = buildSyncPlan(options.yearsBack ?? 4, now);
    const failed: SyncFailure[] = [];
    let fetched = 0;

    try {
      for (const [index, step] of plan.entries()) {
        const label = step.period
          ? `${step.reportType} ${step.period.startDate.slice(0, 4)}`
          : step.reportType;

        await this.deps.runs.advance(user, companyId, runId, {
          processedFiles: index,
          currentFile: label,
          currentStep: "fetching",
        });

        try {
          await this.deps.reports.serve(
            user,
            companyId,
            step.reportType,
            {
              ...(step.period
                ? { start_date: step.period.startDate, end_date: step.period.endDate }
                : {}),
              ...(options.accountingMethod
                ? { accounting_method: options.accountingMethod }
                : {}),
            },
            // A sync exists to refresh. Serving the cache would make the button
            // do nothing on its second press.
            { force: true },
          );
          fetched += 1;
        } catch (error) {
          // An expired connection stops the whole run: every remaining step
          // would fail the same way, and burning through fifty of them to
          // discover that wastes a minute and tells nobody anything.
          if (error instanceof HttpError && error.status === 401) throw error;
          if (error instanceof QuickBooksAuthError) throw error;
          failed.push({
            reportType: step.reportType,
            period: step.period ? step.period.startDate.slice(0, 4) : "all",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      // Whatever went wrong, the run is finished here rather than left
      // `running`. A row nobody closes reads as a live sync for five minutes
      // and then as a stalled one forever, and the company cannot start
      // another until it is reaped.
      await this.deps.runs.finish(user, companyId, runId, {
        status: "failed",
        result: { fetched, failed },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const outcome: SyncOutcome = { fetched, failed };
    await this.deps.runs.advance(user, companyId, runId, {
      processedFiles: plan.length,
      currentFile: null,
      currentStep: "done",
    });
    await this.deps.runs.finish(user, companyId, runId, {
      status: fetched > 0 || plan.length === 0 ? "completed" : "failed",
      result: { ...outcome },
      ...(fetched === 0 && plan.length > 0
        ? { errorMessage: "No report could be fetched from QuickBooks." }
        : {}),
    });

    return outcome;
  }
}
