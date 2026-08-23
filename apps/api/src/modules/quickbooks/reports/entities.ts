import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { StatementExtract, StatementsRepository } from "../../statements/ports.js";
import type { QuickBooksRepository } from "../ports.js";
import {
  QuickBooksAuthError,
  escapeQueryLiteral,
  type QbListEntityType,
  type ReportFetcher,
} from "./client.js";
import { QUICKBOOKS_SOURCE_KEY, type ServedReport } from "./service.js";

/**
 * Customers and invoices.
 *
 * The same cache-then-live sequence the reports take, over Intuit's `/query`
 * endpoint rather than `/reports`. They are lists of records rather than
 * statements with rows and columns, but "what a source told us when asked" is
 * one idea however it was asked, so they are held in the same place.
 *
 * A LIST IS NOT A REPORT ABOUT A PERIOD
 * -------------------------------------
 * The difference that matters for caching: a report is identified by its
 * period, and a list is not. The customer list is just the customer list. So
 * the cache is keyed on the entity type alone, and an exact hit is any hit —
 * there is no period to match, which also means the coverage fallback the
 * reports use has nothing to fall back FROM.
 *
 * Legacy served these from the cache and only went live when the cache came
 * back EMPTY, which is subtly wrong in the other direction: a company that
 * genuinely has no invoices refetched from Intuit on every page load, and one
 * whose list was stale never refetched at all. Staleness is decided by whether
 * a sync has run since, not by whether the answer happens to be empty.
 */

/** How old a cached list may be before it is fetched again. */
const STALE_AFTER_MS = 15 * 60 * 1000;

export interface QuickBooksEntitiesServiceDeps {
  statements: StatementsRepository;
  connections: QuickBooksRepository;
  fetcher: ReportFetcher;
}

export class QuickBooksEntitiesService {
  constructor(private readonly deps: QuickBooksEntitiesServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /**
   * The list, from cache when it is fresh and from Intuit when it is not.
   *
   * Freshness is a clock, not an emptiness test. A company with no invoices
   * has a perfectly good empty list, and treating empty as "not cached" makes
   * every page load an API call for exactly the companies that need it least.
   */
  async list(
    user: SessionUser,
    companyId: string,
    entityType: QbListEntityType,
    now = new Date(),
  ): Promise<ServedReport> {
    this.requireCompany(user, companyId);

    const connection = await this.deps.connections.get(companyId);
    const disconnected = !connection?.isConnected;
    const cached = await this.deps.statements.latest(companyId, entityType, {
      sourceKey: QUICKBOOKS_SOURCE_KEY,
    });

    const fresh =
      cached?.extractedAt !== null &&
      cached?.extractedAt !== undefined &&
      now.getTime() - Date.parse(cached.extractedAt) < STALE_AFTER_MS;

    if (cached && (fresh || disconnected)) {
      return fromCache(cached, disconnected);
    }

    if (!disconnected && connection) {
      const live = await this.fetchLive(companyId, connection.realmId, entityType, user);
      if (live) return live;
    }

    if (cached) return fromCache(cached, disconnected);

    throw new NotFoundError(
      disconnected
        ? `QuickBooks is disconnected and no cached ${entityType} list is available.`
        : `No ${entityType} list is available. Run a QuickBooks sync to fetch one.`,
    );
  }

  /**
   * One invoice, by the number printed on it.
   *
   * Always live: an invoice is looked up by document number when somebody is
   * about to act on it, and a cached one is exactly the wrong thing to show
   * then. It is also the only read here that takes a value from the URL, which
   * is why the escaping matters — legacy pasted the path segment straight into
   * the query string.
   */
  async invoiceByDocNumber(
    user: SessionUser,
    companyId: string,
    docNumber: string,
  ): Promise<ServedReport> {
    this.requireCompany(user, companyId);
    const trimmed = String(docNumber ?? "").trim();
    if (!trimmed) throw new BadRequestError("Missing document number.");

    const connection = await this.deps.connections.get(companyId);
    if (!connection?.isConnected) {
      throw new NotFoundError("QuickBooks is disconnected, so an invoice cannot be looked up.");
    }

    const tokens = await this.deps.connections.tokens(companyId);
    if (!tokens?.accessToken) {
      throw new QuickBooksAuthError("The stored QuickBooks token could not be read.");
    }

    const fetched = await this.deps.fetcher.queryEntity({
      realmId: connection.realmId,
      accessToken: tokens.accessToken,
      entityType: "invoices",
      where: `DocNumber = '${escapeQueryLiteral(trimmed)}'`,
      maxResults: 1,
    });

    const invoices = (fetched.payload as { QueryResponse?: { Invoice?: unknown } }).QueryResponse
      ?.Invoice;
    if (!Array.isArray(invoices) || invoices.length === 0) {
      throw new NotFoundError(`No invoice numbered ${trimmed}.`);
    }

    return {
      source: "live_fetch",
      disconnected: false,
      lastSyncAt: null,
      datasetVersion: null,
      reportParams: fetched.params,
      // The invoice itself, not the query envelope around it — the caller
      // asked for one invoice and unwrapping it here saves every caller from
      // knowing Intuit's response shape.
      data: invoices[0] as Record<string, unknown>,
    };
  }

  private async fetchLive(
    companyId: string,
    realmId: string,
    entityType: QbListEntityType,
    user: SessionUser,
  ): Promise<ServedReport | null> {
    const tokens = await this.deps.connections.tokens(companyId);
    if (!tokens?.accessToken) return null;

    let fetched;
    try {
      fetched = await this.deps.fetcher.queryEntity({
        realmId,
        accessToken: tokens.accessToken,
        entityType,
      });
    } catch (error) {
      // An expired connection is reported; anything else falls back to
      // whatever is cached, because a list a quarter of an hour old beats an
      // error page.
      if (error instanceof QuickBooksAuthError) throw error;
      return null;
    }

    const saved = await this.deps.statements.save({
      companyId,
      provenance: {
        from: "pull",
        reportParams: fetched.params,
        // No period and no basis, so nothing distinguishes two pulls of one
        // list: fetching again REPLACES, which is what a list means.
        variant: null,
      },
      statementType: entityType as never,
      sourceKey: QUICKBOOKS_SOURCE_KEY,
      periodStart: null,
      periodEnd: null,
      asOfDate: null,
      fiscalYear: null,
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

function fromCache(extract: StatementExtract, disconnected: boolean): ServedReport {
  return {
    source: "cached_snapshot",
    disconnected,
    lastSyncAt: extract.extractedAt,
    datasetVersion: extract.datasetVersionId,
    reportParams: extract.reportParams,
    data: extract.payload,
  };
}
