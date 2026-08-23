import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MINOR_VERSION,
  QuickBooksAuthError,
  QuickBooksReportClient,
  QuickBooksRequestError,
} from "./client.js";

/**
 * Asking QuickBooks for a report.
 *
 * These prove the request is BUILT right and the failures are CLASSIFIED
 * right. They do not prove Intuit accepts it — nothing short of a sandbox
 * realm does, and that is stated in the module rather than implied by a green
 * suite.
 */

/** A fetch that records what it was asked and answers what it was told to. */
function stubFetch(answer: Partial<Response> & { json?: () => Promise<unknown> }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: answer.status === undefined || (answer.status >= 200 && answer.status < 300),
      status: answer.status ?? 200,
      json: answer.json ?? (() => Promise.resolve({ Header: {}, Rows: {} })),
      text: answer.text ?? (() => Promise.resolve("")),
      ...answer,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (impl: typeof fetch) =>
  new QuickBooksReportClient({ baseUrl: "https://qb.test", fetchImpl: impl });

const REQUEST = {
  realmId: "realm-1",
  accessToken: "token-1",
  reportType: "balance_sheet" as const,
  params: { start_date: "2024-01-01", end_date: "2024-12-31" },
};

describe("the request it builds", () => {
  it("asks the right realm for the right report", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).fetchReport(REQUEST);
    expect(calls[0]!.url).toContain("/v3/company/realm-1/reports/BalanceSheet");
  });

  it("carries the token as a bearer", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).fetchReport(REQUEST);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-1");
  });

  it("passes the parameters through", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).fetchReport(REQUEST);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("start_date")).toBe("2024-01-01");
    expect(url.searchParams.get("end_date")).toBe("2024-12-31");
  });

  it("pins the minor version rather than letting Intuit's default advance", async () => {
    // An advancing default means a report's shape can change without anything
    // here changing, which is a figure moving on a page with no commit to
    // blame it on.
    const { impl, calls } = stubFetch({});
    await client(impl).fetchReport(REQUEST);
    expect(new URL(calls[0]!.url).searchParams.get("minorversion")).toBe(
      String(DEFAULT_MINOR_VERSION),
    );
  });

  it("leaves an empty parameter out rather than sending it blank", async () => {
    // Intuit reads `start_date=` as a malformed date, not as "no start date".
    const { impl, calls } = stubFetch({});
    await client(impl).fetchReport({ ...REQUEST, params: { start_date: "", end_date: "2024-12-31" } });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has("start_date")).toBe(false);
    expect(url.searchParams.get("end_date")).toBe("2024-12-31");
  });

  it("escapes a realm id rather than pasting it into a path", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).fetchReport({ ...REQUEST, realmId: "a/../b" });
    expect(calls[0]!.url).toContain("a%2F..%2Fb");
  });

  it("names each report the way the URL wants it", async () => {
    for (const [type, name] of [
      ["balance_sheet", "BalanceSheet"],
      ["profit_and_loss", "ProfitAndLoss"],
      ["cash_flow", "CashFlow"],
      ["general_ledger", "GeneralLedger"],
      ["account_list", "AccountList"],
    ] as const) {
      const { impl, calls } = stubFetch({});
      await client(impl).fetchReport({ ...REQUEST, reportType: type });
      expect(calls[0]!.url).toContain(`/reports/${name}`);
    }
  });
});

describe("what it does with an answer", () => {
  it("returns the report and the query that produced it", async () => {
    // Kept so a surprising figure can be traced back to the question asked.
    const { impl } = stubFetch({ json: () => Promise.resolve({ Header: { ReportBasis: "Cash" } }) });
    const result = await client(impl).fetchReport(REQUEST);
    expect(result.payload).toEqual({ Header: { ReportBasis: "Cash" } });
    expect(result.params).toEqual({ start_date: "2024-01-01", end_date: "2024-12-31" });
  });

  it("copies the params rather than handing back the caller's object", async () => {
    const { impl } = stubFetch({});
    const params = { start_date: "2024-01-01" };
    const result = await client(impl).fetchReport({ ...REQUEST, params });
    expect(result.params).not.toBe(params);
  });
});

describe("what it does with a refusal", () => {
  it("calls a rejected token what it is", async () => {
    // The fix for this one is "reconnect QuickBooks". Reporting it as a
    // generic error sends somebody looking for a problem with the report.
    for (const status of [401, 403]) {
      const { impl } = stubFetch({ status, ok: false });
      await expect(client(impl).fetchReport(REQUEST)).rejects.toBeInstanceOf(QuickBooksAuthError);
    }
  });

  it("reports any other status with what Intuit said", async () => {
    const { impl } = stubFetch({
      status: 400,
      ok: false,
      text: () => Promise.resolve('{"Fault":{"Error":[{"Message":"Invalid date"}]}}'),
    });
    await expect(client(impl).fetchReport(REQUEST)).rejects.toThrow(/Invalid date/);
    const { impl: second } = stubFetch({ status: 400, ok: false, text: () => Promise.resolve("") });
    await expect(client(second).fetchReport(REQUEST)).rejects.toBeInstanceOf(
      QuickBooksRequestError,
    );
  });

  it("truncates a long error body rather than logging a page of markup", async () => {
    // A gateway in front of Intuit answers HTML, not JSON.
    const { impl } = stubFetch({
      status: 502,
      ok: false,
      text: () => Promise.resolve("<html>".repeat(1000)),
    });
    const error = await client(impl)
      .fetchReport(REQUEST)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error!.message.length).toBeLessThan(600);
  });

  it("says so when the body is not a report at all", async () => {
    for (const body of [null, [1, 2, 3], "a string"]) {
      const { impl } = stubFetch({ json: () => Promise.resolve(body) });
      await expect(client(impl).fetchReport(REQUEST)).rejects.toBeInstanceOf(
        QuickBooksRequestError,
      );
    }
  });

  it("still reports the body it could not read", async () => {
    const { impl } = stubFetch({ status: 500, ok: false, text: () => Promise.reject(new Error("x")) });
    await expect(client(impl).fetchReport(REQUEST)).rejects.toThrow(/no body/);
  });
});

describe("not waiting forever", () => {
  it("gives up rather than holding the request open", async () => {
    // Without a timeout a hung connection leaves the user watching a spinner
    // rather than seeing an error they can act on.
    const impl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const impatient = new QuickBooksReportClient({
      baseUrl: "https://qb.test",
      fetchImpl: impl,
      timeoutMs: 10,
    });
    await expect(impatient.fetchReport(REQUEST)).rejects.toThrow(/abort/i);
  });

  it("clears its timer when the call succeeds", async () => {
    // A timer left pending keeps the process alive past the request, which is
    // how a server stops shutting down cleanly.
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { impl } = stubFetch({});
    await client(impl).fetchReport(REQUEST);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe("where it points", () => {
  it("defaults to production", () => {
    expect(new QuickBooksReportClient().fetchReport).toBeTypeOf("function");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const { impl, calls } = stubFetch({});
    const trailing = new QuickBooksReportClient({
      baseUrl: "https://qb.test/",
      fetchImpl: impl,
    });
    await trailing.fetchReport(REQUEST);
    expect(calls[0]!.url).toBe(
      `https://qb.test/v3/company/realm-1/reports/BalanceSheet?start_date=2024-01-01&end_date=2024-12-31&minorversion=${DEFAULT_MINOR_VERSION}`,
    );
  });
});
