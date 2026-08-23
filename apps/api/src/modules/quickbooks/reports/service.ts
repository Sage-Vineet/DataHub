import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { StatementExtract, StatementsRepository } from "../../statements/ports.js";
import type { QuickBooksRepository } from "../ports.js";
import { QuickBooksAuthError, type QbReportType, type ReportFetcher } from "./client.js";
import {
  reportParamsOf,
  toReportQuery,
  verdictFor,
  type CachedReport,
  type ReportQuery,
} from "./resolution.js";

/**
 * Serving a QuickBooks report.
 *
 * One service behind five routes that legacy had as five near-identical
 * handlers. The sequence is the same in all of them and was already drifting:
 *
 *   1. An exact cached report — same period, same basis. Serve it.
 *   2. Connected? Ask QuickBooks, and keep what comes back.
 *   3. Live failed or disconnected? A wider cached report, SAYING SO.
 *   4. Nothing. Say which of those two it was, because the fix differs.
 *
 * Step 3 is the one that earns its keep. A booth demo or a client review with
 * QuickBooks disconnected still shows figures, and the response says plainly
 * that they are from a wider period than was asked for — legacy's `note` field,
 * kept, because a figure that silently answers a different question is the
 * thing this whole module is arranged to prevent.
 */

/** Which source key a pulled QuickBooks report is filed under. */
export const QUICKBOOKS_SOURCE_KEY = "quickbooks";

/** What a caller gets back, whatever produced it. */
export interface ServedReport {
  source: "cached_snapshot" | "live_fetch";
  disconnected: boolean;
  lastSyncAt: string | null;
  datasetVersion: string | null;
  reportParams: Record<string, unknown>;
  data: Record<string, unknown>;
  /** Set when the report served covers a wider period than was asked for. */
  coverageFallback?: true;
  note?: string;
}

export interface QuickBooksReportsServiceDeps {
  statements: StatementsRepository;
  connections: QuickBooksRepository;
  fetcher: ReportFetcher;
}

const toCached = (extract: StatementExtract): CachedReport => ({
  periodStart: extract.periodStart,
  periodEnd: extract.periodEnd,
  asOfDate: extract.asOfDate,
  reportParams: extract.reportParams,
  payload: extract.payload,
  extractedAt: extract.extractedAt,
  datasetVersionId: extract.datasetVersionId,
});

export class QuickBooksReportsService {
  constructor(private readonly deps: QuickBooksReportsServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /**
   * The most recently pulled report of a type.
   *
   * One per type rather than a search across every stored period, because the
   * page asks for one period at a time and the sync keeps the newest pull for
   * each. Widening this to "the best-covering stored period" would be a real
   * improvement and a different change; it is not what legacy did, and doing
   * it silently here would change which figures a page shows.
   */
  private async cachedFor(
    companyId: string,
    reportType: QbReportType,
  ): Promise<StatementExtract | null> {
    return this.deps.statements.latest(companyId, reportType, {
      sourceKey: QUICKBOOKS_SOURCE_KEY,
    });
  }

  async serve(
    user: SessionUser,
    companyId: string,
    reportType: QbReportType,
    rawQuery: Record<string, unknown>,
  ): Promise<ServedReport> {
    this.requireCompany(user, companyId);
    const query = toReportQuery(rawQuery);

    const connection = await this.deps.connections.get(companyId);
    const disconnected = !connection?.isConnected;

    const cached = await this.cachedFor(companyId, reportType);
    const verdict = verdictFor(query, cached ? toCached(cached) : null);

    if (verdict.kind === "exact" && cached) {
      return this.fromCache(cached, disconnected);
    }

    if (!disconnected && connection) {
      const live = await this.fetchLive(companyId, connection.realmId, reportType, query, user);
      // `null` means the live fetch failed for a reason worth falling back
      // from. An auth failure is not one of those — see `fetchLive`.
      if (live) return live;
    }

    if (verdict.kind === "covers" && cached) {
      return {
        ...this.fromCache(cached, disconnected),
        coverageFallback: true,
        note:
          `No snapshot for ${query.startDate ?? "the start"}–${query.endDate ?? "the end"}. ` +
          `Showing the nearest available (${verdict.storedStart ?? "open"}–${verdict.storedEnd ?? "open"}).`,
      };
    }

    // Which of the two it was matters: "reconnect QuickBooks" and "run a sync"
    // are different actions, and a single message covering both sends half the
    // readers to the wrong one.
    throw new NotFoundError(
      disconnected
        ? `QuickBooks is disconnected and no cached ${reportType.replace(/_/g, " ")} ` +
          `is available for the requested period.`
        : `No ${reportType.replace(/_/g, " ")} is available for the requested period. ` +
          `Run a QuickBooks sync to generate one.`,
    );
  }

  private fromCache(extract: StatementExtract, disconnected: boolean): ServedReport {
    return {
      source: "cached_snapshot",
      disconnected,
      lastSyncAt: extract.extractedAt,
      datasetVersion: extract.datasetVersionId,
      reportParams: extract.reportParams,
      data: extract.payload,
    };
  }

  /**
   * Ask QuickBooks, and keep what comes back.
   *
   * Returns null when the fetch failed in a way a cached report can stand in
   * for — a timeout, a 500, a bad gateway. An auth failure THROWS instead:
   * serving a cached report there would leave somebody looking at figures and
   * no indication their connection has expired, and they would keep looking at
   * the same figures for as long as it stayed expired.
   */
  private async fetchLive(
    companyId: string,
    realmId: string,
    reportType: QbReportType,
    query: ReportQuery,
    user: SessionUser,
  ): Promise<ServedReport | null> {
    const tokens = await this.deps.connections.tokens(companyId);
    if (!tokens?.accessToken) {
      // Connected but with no readable token — the row says connected and the
      // sealed column could not be opened. Not an auth error to report to the
      // user; a cached report is the better answer, and the connection needs
      // remaking either way.
      return null;
    }

    const params = reportParamsOf(query);
    let fetched;
    try {
      fetched = await this.deps.fetcher.fetchReport({
        realmId,
        accessToken: tokens.accessToken,
        reportType,
        params,
      });
    } catch (error) {
      if (error instanceof QuickBooksAuthError) throw error;
      return null;
    }

    const saved = await this.deps.statements.save({
      companyId,
      // A pull, not a file. `sync_run_id` is null here because this is an
      // on-demand fetch rather than a run — the row carries `report_params`
      // instead, which is what a reader needs to know what was asked.
      provenance: {
        from: "pull",
        // No run: this is an on-demand fetch because somebody asked for a
        // period no sync had covered. See migration 0015 for why that is a
        // legitimate provenance rather than a missing one.
        reportParams: fetched.params,
        // The basis is part of the identity. Without it the same period on a
        // cash basis and on an accrual basis share one key, and the second
        // pull replaces the first — leaving the page showing whichever was
        // fetched last, with nothing to say which.
        variant: query.accountingMethod,
      },
      statementType: reportType as never,
      sourceKey: QUICKBOOKS_SOURCE_KEY,
      periodStart: query.startDate,
      periodEnd: query.endDate,
      asOfDate: query.asOfDate,
      fiscalYear: fiscalYearOf(query),
      payload: fetched.payload,
      extractedBy: user.id,
    });

    return {
      source: "live_fetch",
      disconnected: false,
      lastSyncAt: saved.extractedAt,
      datasetVersion: saved.datasetVersionId,
      reportParams: fetched.params,
      data: fetched.payload,
    };
  }
}

/**
 * The year a pulled report belongs to.
 *
 * The year it CLOSES in — a report is filed under the year it ends, so a
 * December-to-January span sorts with the year it completes rather than the
 * one it opens. Null when there is no date at all, which is the honest answer
 * for an account list.
 */
export function fiscalYearOf(query: ReportQuery): number | null {
  const anchor = query.endDate ?? query.asOfDate ?? query.startDate;
  if (!anchor) return null;
  const year = Number.parseInt(anchor.slice(0, 4), 10);
  return Number.isInteger(year) ? year : null;
}
