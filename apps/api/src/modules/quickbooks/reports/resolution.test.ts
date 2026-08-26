import { describe, expect, it } from "vitest";
import {
  accountingMethodMatches,
  normaliseAccountingMethod,
  reportParamsOf,
  toReportQuery,
  verdictFor,
  type CachedReport,
  type ReportQuery,
} from "./resolution.js";

/**
 * Whether a cached QuickBooks report answers the question asked.
 *
 * Every test here is about one risk: serving a report that answers a DIFFERENT
 * question. A balance sheet on a cash basis looks exactly like one on an
 * accrual basis — same shape, same accounts, different numbers — and nothing
 * on screen says which. Legacy had this logic five times and it had already
 * drifted; only two of the five checked the basis at all.
 */

const query = (over: Partial<ReportQuery> = {}): ReportQuery => ({
  startDate: "2024-01-01",
  endDate: "2024-12-31",
  asOfDate: "2024-12-31",
  accountingMethod: "Accrual",
  summarizeColumnBy: null,
  ...over,
});

const cached = (over: Partial<CachedReport> = {}): CachedReport => ({
  periodStart: "2024-01-01",
  periodEnd: "2024-12-31",
  asOfDate: "2024-12-31",
  reportParams: { accounting_method: "Accrual" },
  payload: { Header: { ReportBasis: "Accrual" } },
  extractedAt: "2025-01-02T00:00:00.000Z",
  datasetVersionId: null,
  ...over,
});

describe("reading an accounting basis", () => {
  it("treats the spellings as one basis", () => {
    // QuickBooks answers "Cash"/"Accrual"; the SPA sends whatever is in the
    // dropdown. Comparing them raw makes every request a cache miss, and when
    // disconnected it rejects a cache that was perfectly correct.
    for (const raw of ["cash", "Cash", " CASH ", "cAsH"]) {
      expect(normaliseAccountingMethod(raw)).toBe("Cash");
    }
    expect(normaliseAccountingMethod("ACCRUAL")).toBe("Accrual");
  });

  it("says nothing when nothing was asked", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(normaliseAccountingMethod(raw)).toBeNull();
    }
  });

  it("keeps a basis it does not recognise rather than dropping it", () => {
    // Dropping it would read as "no preference" and serve either basis.
    expect(normaliseAccountingMethod("Modified Cash")).toBe("Modified Cash");
  });
});

describe("whether the cached report is on the right basis", () => {
  it("accepts one that matches on both sides", () => {
    expect(accountingMethodMatches("Accrual", cached())).toBe(true);
  });

  it("accepts anything when the caller did not ask", () => {
    expect(accountingMethodMatches(null, cached())).toBe(true);
    expect(accountingMethodMatches("", cached())).toBe(true);
  });

  it("refuses one pulled on a different basis", () => {
    expect(
      accountingMethodMatches("Cash", cached({ reportParams: { accounting_method: "Accrual" } })),
    ).toBe(false);
  });

  it("refuses one QuickBooks ANSWERED on a different basis", () => {
    // Asking for cash on a company configured for accrual returns an accrual
    // report with `ReportBasis: "Accrual"`. Trusting only our own request
    // would file it as cash, and every figure on screen would be wrong with
    // nothing to indicate it.
    expect(
      accountingMethodMatches("Cash", {
        reportParams: { accounting_method: "Cash" },
        payload: { Header: { ReportBasis: "Accrual" } },
      }),
    ).toBe(false);
  });

  it("treats an absent basis as unknown, not as wrong", () => {
    // A report pulled before the basis was recorded is not proof of a
    // mismatch, and refusing it would leave a disconnected company with
    // nothing at all.
    expect(accountingMethodMatches("Accrual", { reportParams: {}, payload: {} })).toBe(true);
  });

  it("compares case-insensitively on both sides", () => {
    expect(
      accountingMethodMatches("accrual", {
        reportParams: { accounting_method: "ACCRUAL" },
        payload: { Header: { ReportBasis: "accrual" } },
      }),
    ).toBe(true);
  });
});

describe("what the cache can do for a request", () => {
  it("serves an exact match", () => {
    expect(verdictFor(query(), cached())).toEqual({ kind: "exact" });
  });

  it("has nothing to say about nothing", () => {
    expect(verdictFor(query(), null)).toEqual({ kind: "no", because: "nothing-cached" });
  });

  it("refuses the wrong basis however well the dates line up", () => {
    // Order matters: a report on the wrong basis is wrong whatever its dates,
    // and checking dates first invites the reading that a close-enough period
    // excuses it.
    expect(verdictFor(query({ accountingMethod: "Cash" }), cached())).toEqual({
      kind: "no",
      because: "method-mismatch",
    });
  });

  it("offers a wider stored period, and says it is doing so", () => {
    // The requested figures are present inside a wider report, so serving it
    // beats nothing when disconnected — but only when SAID, which is why this
    // is its own verdict rather than a looser "exact".
    const verdict = verdictFor(
      query({ startDate: "2024-03-01", endDate: "2024-06-30", asOfDate: "2024-06-30" }),
      cached(),
    );
    expect(verdict).toEqual({
      kind: "covers",
      storedStart: "2024-01-01",
      storedEnd: "2024-12-31",
    });
  });

  it("refuses a stored period that starts after the one asked for", () => {
    expect(
      verdictFor(
        query({ startDate: "2023-01-01", endDate: "2024-12-31", asOfDate: "2024-12-31" }),
        cached(),
      ),
    ).toEqual({ kind: "no", because: "period-not-covered" });
  });

  it("refuses a stored period that ends before the one asked for", () => {
    expect(
      verdictFor(
        query({ startDate: "2024-01-01", endDate: "2025-06-30", asOfDate: "2025-06-30" }),
        cached(),
      ),
    ).toEqual({ kind: "no", because: "period-not-covered" });
  });

  it("takes the period from the columns, not from the params", () => {
    // The columns are what this code writes; the params are what was asked.
    // They agree for anything written here, and the params are the fallback
    // for a row that predates the columns.
    expect(
      verdictFor(
        query(),
        cached({
          periodStart: null,
          periodEnd: null,
          asOfDate: null,
          reportParams: {
            start_date: "2024-01-01",
            end_date: "2024-12-31",
            as_of_date: "2024-12-31",
            accounting_method: "Accrual",
          },
        }),
      ),
    ).toEqual({ kind: "exact" });
  });

  it("ignores a date the caller did not ask about", () => {
    // A general ledger has no as-of date, and requiring one to match would
    // make every general ledger a cache miss.
    expect(
      verdictFor(query({ asOfDate: null, startDate: null }), cached()),
    ).toEqual({ kind: "exact" });
  });

  it("counts an open-ended stored period as covering anything after it starts", () => {
    // An account list has no period at all. Treating "no end date" as "ends
    // before what you asked for" would refuse every one of them.
    expect(
      verdictFor(query(), cached({ periodStart: null, periodEnd: null, asOfDate: null })),
    ).toEqual({ kind: "covers", storedStart: null, storedEnd: null });
  });
});

describe("the cache key", () => {
  it("includes the basis", () => {
    // Without it, pulling the same period on both bases gives two reports one
    // key and the second replaces the first — so the page flips between cash
    // and accrual depending on which sync ran last, with nothing to explain it.
    expect(reportParamsOf(query({ accountingMethod: "Cash" }))).toEqual({
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      as_of_date: "2024-12-31",
      accounting_method: "Cash",
    });
  });

  it("normalises the basis, so two spellings are one key", () => {
    expect(reportParamsOf(query({ accountingMethod: "cash" })).accounting_method).toBe("Cash");
  });

  it("leaves out what was not asked, rather than storing empty strings", () => {
    expect(
      reportParamsOf({
        startDate: null,
        endDate: null,
        asOfDate: null,
        accountingMethod: null,
        summarizeColumnBy: null,
      }),
    ).toEqual({});
  });
});

describe("reading the query string", () => {
  it("takes the four parameters and trims them", () => {
    expect(
      toReportQuery({
        start_date: " 2024-01-01 ",
        end_date: "2024-12-31",
        as_of_date: "2024-12-31",
        accounting_method: " Cash ",
      }),
    ).toEqual({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      asOfDate: "2024-12-31",
      accountingMethod: "Cash",
      summarizeColumnBy: null,
    });
  });

  it("defaults the as-of date to the end of the period", () => {
    // Legacy did this on some routes and not others, which is why the same
    // balance sheet hit the cache when asked one way and missed when asked
    // another. A balance sheet is a moment, and the moment is the period end.
    expect(toReportQuery({ end_date: "2024-12-31" }).asOfDate).toBe("2024-12-31");
  });

  it("prefers an explicit as-of date to the period end", () => {
    expect(
      toReportQuery({ end_date: "2024-12-31", as_of_date: "2024-06-30" }).asOfDate,
    ).toBe("2024-06-30");
  });

  it("reads an empty query as asking for nothing in particular", () => {
    expect(toReportQuery({})).toEqual({
      startDate: null,
      endDate: null,
      asOfDate: null,
      accountingMethod: null,
      summarizeColumnBy: null,
    });
  });

  it("treats a blank parameter as absent", () => {
    expect(toReportQuery({ start_date: "   ", accounting_method: "" })).toEqual({
      startDate: null,
      endDate: null,
      asOfDate: null,
      accountingMethod: null,
      summarizeColumnBy: null,
    });
  });
});

describe("a report broken into months is a different report", () => {
  it("refuses an unsummarised cache for a monthly request", () => {
    // The shapes differ: one has twelve columns and the other has one, and the
    // code that renders one reads the other as a report with a single unnamed
    // column.
    expect(verdictFor(query({ summarizeColumnBy: "Month" }), cached())).toEqual({
      kind: "no",
      because: "summarisation-mismatch",
    });
  });

  it("refuses a monthly cache for an unsummarised request", () => {
    expect(
      verdictFor(
        query(),
        cached({ reportParams: { accounting_method: "Accrual", summarize_column_by: "Month" } }),
      ),
    ).toEqual({ kind: "no", because: "summarisation-mismatch" });
  });

  it("serves a monthly cache for a monthly request", () => {
    expect(
      verdictFor(
        query({ summarizeColumnBy: "Month" }),
        cached({ reportParams: { accounting_method: "Accrual", summarize_column_by: "Month" } }),
      ),
    ).toEqual({ kind: "exact" });
  });

  it("compares case-insensitively", () => {
    expect(
      verdictFor(
        query({ summarizeColumnBy: "month" }),
        cached({ reportParams: { accounting_method: "Accrual", summarize_column_by: "Month" } }),
      ),
    ).toEqual({ kind: "exact" });
  });

  it("puts the summarisation in the cache key", () => {
    expect(reportParamsOf(query({ summarizeColumnBy: "Month" })).summarize_column_by).toBe("Month");
    expect(reportParamsOf(query()).summarize_column_by).toBeUndefined();
  });

  it("reads it off the query string", () => {
    expect(toReportQuery({ summarize_column_by: "Month" }).summarizeColumnBy).toBe("Month");
  });
});
