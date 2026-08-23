/**
 * Deciding whether a cached QuickBooks report answers the question asked.
 *
 * Legacy had this logic five times — balance sheet, P&L, cash flow, general
 * ledger, account list — as five near-identical 150-line handlers, and they
 * had already drifted: only two of them checked the accounting method, and one
 * of those checked it in a different order. This is that decision, once, as a
 * pure function, so the five routes cannot disagree about what a cache hit is.
 *
 * Everything here is about ONE risk: serving a cached report that answers a
 * different question from the one asked. A balance sheet on a cash basis
 * looks exactly like one on an accrual basis — same shape, same accounts,
 * different numbers — and nothing on screen says which it is. That is the
 * failure this file exists to prevent.
 */

/** What the caller asked QuickBooks for. */
export interface ReportQuery {
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  /** "Cash" or "Accrual". Empty means the caller did not care. */
  accountingMethod: string | null;
  /**
   * How the report is broken into columns — `Month`, `Quarter`, `Year`.
   *
   * A summarised report is a DIFFERENT report, not a view of the same one: its
   * columns are months rather than a single total. Part of the query and part
   * of the cache key, because sharing a key with the unsummarised report would
   * make the two replace each other and the page show whichever was fetched
   * last — one with twelve columns and one with one, rendered by the same code.
   */
  summarizeColumnBy: string | null;
}

/** A report already held, as it comes off `statement_extracts`. */
export interface CachedReport {
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
  /** What the API was asked when this was pulled. */
  reportParams: Record<string, unknown>;
  /** The report itself, as QuickBooks returned it. */
  payload: Record<string, unknown>;
  extractedAt: string | null;
  datasetVersionId: string | null;
}

/**
 * What the cache can do for this request.
 *
 * `exact` — same period, same basis. Serve it.
 * `covers` — a wider period on the same basis. Serve it, SAYING SO.
 * `no` — different basis, or a period it does not reach. Do not serve it.
 */
export type CacheVerdict =
  | { kind: "exact" }
  | { kind: "covers"; storedStart: string | null; storedEnd: string | null }
  | {
      kind: "no";
      because:
        | "method-mismatch"
        | "summarisation-mismatch"
        | "period-not-covered"
        | "nothing-cached";
    };

/**
 * "Cash" or "Accrual", however it was written.
 *
 * QuickBooks answers `Header.ReportBasis` as "Cash"/"Accrual"; the SPA sends
 * whatever is in the dropdown. Comparing them raw makes "cash" and "Cash"
 * different bases, which forces a live fetch on every request and — when
 * disconnected — rejects a cache that was perfectly correct.
 */
export function normaliseAccountingMethod(raw: unknown): string | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "") return null;
  if (text === "cash") return "Cash";
  if (text === "accrual") return "Accrual";
  // Not a basis this knows about. Returned as given rather than dropped: an
  // unrecognised basis must not compare equal to a recognised one, and
  // silently treating it as "no preference" would serve either.
  return String(raw).trim();
}

/**
 * Whether a cached report is on the basis that was asked for.
 *
 * Checked against BOTH what we recorded asking for and what QuickBooks said it
 * answered. They can differ: asking for a cash-basis report on a company
 * configured for accrual gets an accrual report back with `ReportBasis:
 * "Accrual"`, and trusting only our own request would file it as cash.
 */
export function accountingMethodMatches(
  requested: string | null,
  cached: Pick<CachedReport, "reportParams" | "payload">,
): boolean {
  const want = normaliseAccountingMethod(requested);
  // The caller did not say, so anything answers.
  if (want === null) return true;

  const storedAsk = normaliseAccountingMethod(
    (cached.reportParams as { accounting_method?: unknown }).accounting_method,
  );
  const answered = normaliseAccountingMethod(
    ((cached.payload as { Header?: { ReportBasis?: unknown } }).Header ?? {}).ReportBasis,
  );

  // An absent value on either side is unknown, not wrong. A report pulled
  // before the basis was recorded is not proof of a mismatch, and refusing it
  // would mean a disconnected company sees nothing at all.
  return (storedAsk === null || storedAsk === want) && (answered === null || answered === want);
}

/**
 * Whether a cached report is broken into the same columns as the one asked for.
 *
 * An absent value on either side is "not summarised", which is QuickBooks'
 * default — so a report pulled before this was recorded is comparable rather
 * than unusable.
 */
export function summarisationMatches(
  requested: string | null,
  cached: Pick<CachedReport, "reportParams">,
): boolean {
  const want = String(requested ?? "").trim().toLowerCase();
  const had = String(
    (cached.reportParams as { summarize_column_by?: unknown }).summarize_column_by ?? "",
  )
    .trim()
    .toLowerCase();
  return want === had;
}

/** What a stored pull says its period was. */
function storedPeriod(cached: CachedReport): {
  start: string | null;
  end: string | null;
  asOf: string | null;
} {
  const params = cached.reportParams as {
    start_date?: unknown;
    end_date?: unknown;
    as_of_date?: unknown;
  };
  const text = (value: unknown): string | null => {
    const trimmed = String(value ?? "").trim();
    return trimmed === "" ? null : trimmed;
  };
  // The columns are the truth; the params are what was asked. They agree for
  // anything this code wrote, and the params are the fallback for a row
  // written before the columns existed.
  return {
    start: cached.periodStart ?? text(params.start_date),
    end: cached.periodEnd ?? text(params.end_date),
    asOf: cached.asOfDate ?? text(params.as_of_date),
  };
}

/**
 * Can this cached report answer this request?
 *
 * The order is deliberate: basis first, then period. A report on the wrong
 * basis is wrong however well its dates line up, and checking dates first
 * invites the reading that a close-enough period excuses it.
 */
export function verdictFor(query: ReportQuery, cached: CachedReport | null): CacheVerdict {
  if (!cached) return { kind: "no", because: "nothing-cached" };
  if (!accountingMethodMatches(query.accountingMethod, cached)) {
    return { kind: "no", because: "method-mismatch" };
  }
  // A monthly report cannot answer a request for an annual one, or the other
  // way round: the shapes differ, and the code that renders one would read the
  // other as a report with a single unnamed column.
  if (!summarisationMatches(query.summarizeColumnBy, cached)) {
    return { kind: "no", because: "summarisation-mismatch" };
  }

  const stored = storedPeriod(cached);
  const exact =
    (!query.startDate || stored.start === query.startDate) &&
    (!query.endDate || stored.end === query.endDate) &&
    (!query.asOfDate || stored.asOf === query.asOfDate);
  if (exact) return { kind: "exact" };

  // A wider stored period contains the requested one, so the figures for it
  // are present even though the report is not the one asked for. Serving that
  // is better than nothing when disconnected — but only when SAID, which is
  // why it is a distinct verdict rather than an "exact" with a looser test.
  //
  // ISO dates compare correctly as strings, which is the whole reason the
  // columns are `date` and the params are ISO.
  const startsTooLate = Boolean(query.startDate && stored.start && stored.start > query.startDate);
  const endsTooEarly = Boolean(query.endDate && stored.end && stored.end < query.endDate);
  if (startsTooLate || endsTooEarly) {
    return { kind: "no", because: "period-not-covered" };
  }

  return { kind: "covers", storedStart: stored.start, storedEnd: stored.end };
}

/**
 * The identity of a pulled report, for the cache key.
 *
 * The basis is part of it. Without that, pulling the same period on both bases
 * gives two reports one key, and the second silently replaces the first — so
 * the page would flip between cash and accrual figures depending on which sync
 * ran last, with nothing on screen to explain it.
 */
export function reportParamsOf(query: ReportQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.startDate) params.start_date = query.startDate;
  if (query.endDate) params.end_date = query.endDate;
  if (query.asOfDate) params.as_of_date = query.asOfDate;
  const method = normaliseAccountingMethod(query.accountingMethod);
  if (method) params.accounting_method = method;
  if (query.summarizeColumnBy) params.summarize_column_by = query.summarizeColumnBy;
  return params;
}

/** Read a request's query string into the shape everything here speaks. */
export function toReportQuery(query: Record<string, unknown>): ReportQuery {
  const text = (value: unknown): string | null => {
    const trimmed = String(value ?? "").trim();
    return trimmed === "" ? null : trimmed;
  };
  return {
    startDate: text(query.start_date),
    endDate: text(query.end_date),
    // Legacy defaulted `as_of_date` to `end_date` on some routes and not
    // others, which is why a balance sheet asked for one way hit the cache and
    // the same balance sheet asked another way did not. Defaulted everywhere:
    // a balance sheet is a moment, and the moment is the end of the period.
    asOfDate: text(query.as_of_date) ?? text(query.end_date),
    accountingMethod: text(query.accounting_method),
    summarizeColumnBy: text(query.summarize_column_by),
  };
}
