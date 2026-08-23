import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { InMemoryStatementsRepository } from "../../statements/repository.memory.js";
import type { StatementsRepository } from "../../statements/ports.js";
import type { ConnectionRecord, QuickBooksRepository } from "../ports.js";
import { QuickBooksAuthError, QuickBooksRequestError, type ReportFetcher } from "./client.js";
import { QUICKBOOKS_SOURCE_KEY, QuickBooksReportsService, fiscalYearOf } from "./service.js";

/**
 * Serving a QuickBooks report.
 *
 * Legacy had this sequence five times and the copies had drifted. The tests
 * are about the order it happens in, because each step exists to stop a
 * different way of showing somebody the wrong figures.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const USER: SessionUser = {
  id: "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu",
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const CONNECTED: ConnectionRecord = {
  id: "qqqqqqqq-qqqq-4qqq-8qqq-qqqqqqqqqqqq",
  companyId: COMPANY,
  realmId: "realm-1",
  realmCompanyName: "Acme",
  environment: "production",
  isConnected: true,
  connectedAt: "2024-01-01T00:00:00.000Z",
  disconnectedAt: null,
  lastSyncedAt: null,
  tokenExpiresAt: null,
  connectedBy: USER.id,
};

/** A connection repository that answers whatever a test set up. */
function connections(over: Partial<{
  record: ConnectionRecord | null;
  accessToken: string | null;
}> = {}): QuickBooksRepository {
  const record = over.record === undefined ? CONNECTED : over.record;
  const accessToken = over.accessToken === undefined ? "token-1" : over.accessToken;
  return {
    get: () => Promise.resolve(record),
    getByRealm: () => Promise.resolve(record),
    save: () => Promise.reject(new Error("not used")),
    disconnect: () => Promise.resolve(true),
    recordSync: () => Promise.resolve(),
    tokens: () =>
      Promise.resolve(accessToken === null ? null : { accessToken, refreshToken: null, tokenExpiresAt: null }),
  };
}

/** A fetcher that records what it was asked. */
function fetcher(
  answer: Record<string, unknown> | Error = { Header: { ReportBasis: "Accrual" }, Rows: {} },
): ReportFetcher & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    fetchReport: (input) => {
      calls.push(input);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ payload: answer, params: { ...input.params } });
    },
    queryEntity: (input) => {
      calls.push(input);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ payload: answer, params: {} });
    },
  };
}

function build(over: {
  statements?: StatementsRepository;
  connections?: QuickBooksRepository;
  fetcher?: ReportFetcher & { calls: unknown[] };
} = {}) {
  const statements = over.statements ?? new InMemoryStatementsRepository();
  const conn = over.connections ?? connections();
  const fetch = over.fetcher ?? fetcher();
  return {
    statements,
    fetcher: fetch,
    service: new QuickBooksReportsService({ statements, connections: conn, fetcher: fetch }),
  };
}

/** Put a report in the cache, as a sync would have. */
const cache = (
  statements: StatementsRepository,
  over: Record<string, unknown> = {},
) =>
  statements.save({
    companyId: COMPANY,
    provenance: { from: "pull", reportParams: { accounting_method: "Accrual" }, variant: "Accrual" },
    statementType: "balance_sheet" as never,
    sourceKey: QUICKBOOKS_SOURCE_KEY,
    periodStart: "2024-01-01",
    periodEnd: "2024-12-31",
    asOfDate: "2024-12-31",
    fiscalYear: 2024,
    payload: { Header: { ReportBasis: "Accrual" }, Rows: { cached: true } },
    extractedBy: null,
    ...over,
  });

const QUERY = {
  start_date: "2024-01-01",
  end_date: "2024-12-31",
  accounting_method: "Accrual",
};

describe("serving from the cache", () => {
  it("serves an exact match without asking QuickBooks", async () => {
    // Asking again for something already held is a slow answer for no gain,
    // and Intuit rate-limits.
    const { service, statements, fetcher: f } = build();
    await cache(statements);

    const served = await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    expect(served.source).toBe("cached_snapshot");
    expect(served.data).toEqual({ Header: { ReportBasis: "Accrual" }, Rows: { cached: true } });
    expect(f.calls).toHaveLength(0);
  });

  it("goes live when the cache is on a different basis", async () => {
    // A cash-basis balance sheet looks exactly like an accrual one — same
    // shape, same accounts, different numbers — so serving the wrong one is
    // invisible.
    const { service, statements, fetcher: f } = build();
    await cache(statements);

    const served = await service.serve(USER, COMPANY, "balance_sheet", {
      ...QUERY,
      accounting_method: "Cash",
    });
    expect(served.source).toBe("live_fetch");
    expect(f.calls).toHaveLength(1);
  });
});

describe("going live", () => {
  it("asks for the realm on the connection", async () => {
    const { service, fetcher: f } = build();
    await service.serve(USER, COMPANY, "profit_and_loss", QUERY);
    expect((f.calls as Array<{ realmId: string; accessToken: string }>)[0]).toMatchObject(
      { realmId: "realm-1", accessToken: "token-1" },
    );
  });

  it("keeps what comes back, so the next request is a cache hit", async () => {
    const { service, fetcher: f } = build();
    await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    const second = await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    expect(second.source).toBe("cached_snapshot");
    expect(f.calls).toHaveLength(1);
  });

  it("keeps the two bases as two reports rather than overwriting", async () => {
    // The defect the pull key's variant exists to prevent: one key for both
    // bases means the second pull replaces the first, and the page then shows
    // whichever was fetched most recently with nothing to say which.
    const { service, statements } = build();
    await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    await service.serve(USER, COMPANY, "balance_sheet", { ...QUERY, accounting_method: "Cash" });

    const held = await statements.list(COMPANY, { statementType: "balance_sheet" });
    expect(held).toHaveLength(2);
  });

  it("records the question it asked", async () => {
    // So a surprising figure can be traced to the question that produced it.
    const { service, statements } = build();
    await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    const [held] = await statements.list(COMPANY, { statementType: "balance_sheet" });
    expect(held!.reportParams).toEqual({
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      as_of_date: "2024-12-31",
      accounting_method: "Accrual",
    });
  });

  it("files it under the year the period closes in", async () => {
    const { service, statements } = build();
    await service.serve(USER, COMPANY, "balance_sheet", {
      start_date: "2023-04-01",
      end_date: "2024-03-31",
    });
    const [held] = await statements.list(COMPANY, { statementType: "balance_sheet" });
    expect(held!.fiscalYear).toBe(2024);
  });
});

describe("when the live fetch does not work", () => {
  it("falls back to a wider cached period, and says so", async () => {
    // A demo or a client review with QuickBooks unreachable still shows
    // figures — but only when the response says they are from a different
    // period than the one asked for.
    const { service, statements } = build({
      fetcher: fetcher(new QuickBooksRequestError(503, "unavailable")),
    });
    await cache(statements);

    const served = await service.serve(USER, COMPANY, "balance_sheet", {
      start_date: "2024-03-01",
      end_date: "2024-06-30",
      accounting_method: "Accrual",
    });
    expect(served.source).toBe("cached_snapshot");
    expect(served.coverageFallback).toBe(true);
    expect(served.note).toContain("2024-01-01");
    expect(served.note).toContain("2024-12-31");
  });

  it("does NOT fall back when the token was rejected", async () => {
    // Serving a cached report there leaves somebody looking at figures with no
    // indication their connection has expired — and they would keep looking at
    // the same figures for as long as it stayed expired.
    const { service, statements } = build({
      fetcher: fetcher(new QuickBooksAuthError()),
    });
    await cache(statements);

    await expect(
      service.serve(USER, COMPANY, "balance_sheet", {
        start_date: "2024-03-01",
        end_date: "2024-06-30",
      }),
    ).rejects.toBeInstanceOf(QuickBooksAuthError);
  });

  it("falls back when the connection says connected but the token cannot be read", async () => {
    // The sealed column could not be opened. A cached report is the better
    // answer; the connection needs remaking either way.
    const { service, statements } = build({
      connections: connections({ accessToken: null }),
    });
    await cache(statements);
    const served = await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    expect(served.source).toBe("cached_snapshot");
  });

  it("refuses a cached period that does not reach the one asked for", async () => {
    // A narrower stored report does not contain the requested figures, so
    // serving it would silently answer a smaller question.
    const { service, statements } = build({
      fetcher: fetcher(new QuickBooksRequestError(503, "unavailable")),
    });
    await cache(statements);

    await expect(
      service.serve(USER, COMPANY, "balance_sheet", {
        start_date: "2020-01-01",
        end_date: "2024-12-31",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("when QuickBooks is disconnected", () => {
  const disconnected = () =>
    build({ connections: connections({ record: { ...CONNECTED, isConnected: false } }) });

  it("serves the cache without trying to fetch", async () => {
    const { service, statements, fetcher: f } = disconnected();
    await cache(statements);
    const served = await service.serve(USER, COMPANY, "balance_sheet", QUERY);
    expect(served.source).toBe("cached_snapshot");
    expect(served.disconnected).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("says it is disconnected rather than telling somebody to run a sync", async () => {
    // "Reconnect QuickBooks" and "run a sync" are different actions, and one
    // message covering both sends half the readers to the wrong one.
    const { service } = disconnected();
    const error = await service
      .serve(USER, COMPANY, "balance_sheet", QUERY)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error!.message).toMatch(/disconnected/i);
  });

  it("tells a connected company to run a sync", async () => {
    const { service } = build({ fetcher: fetcher(new QuickBooksRequestError(500, "boom")) });
    const error = await service
      .serve(USER, COMPANY, "balance_sheet", QUERY)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error!.message).toMatch(/run a quickbooks sync/i);
  });

  it("treats a company with no connection at all as disconnected", async () => {
    const { service } = build({ connections: connections({ record: null }) });
    await expect(service.serve(USER, COMPANY, "balance_sheet", QUERY)).rejects.toThrow(
      /disconnected/i,
    );
  });
});

describe("who may ask", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service } = build();
    await expect(
      service.serve(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "balance_sheet", QUERY),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request with no company", async () => {
    const { service } = build();
    await expect(service.serve(USER, "", "balance_sheet", QUERY)).rejects.toThrow(/clientId/);
  });
});

describe("the year a report belongs to", () => {
  it("is the year the period closes in", () => {
    // A December-to-January span sorts with the year it completes, not the one
    // it opens.
    expect(
      fiscalYearOf({
        startDate: "2023-04-01",
        endDate: "2024-03-31",
        asOfDate: null,
        accountingMethod: null,
      }),
    ).toBe(2024);
  });

  it("falls back through as-of and start", () => {
    expect(
      fiscalYearOf({ startDate: null, endDate: null, asOfDate: "2022-12-31", accountingMethod: null }),
    ).toBe(2022);
    expect(
      fiscalYearOf({ startDate: "2021-01-01", endDate: null, asOfDate: null, accountingMethod: null }),
    ).toBe(2021);
  });

  it("is nothing when there is no date at all", () => {
    // The honest answer for an account list, which has no period.
    expect(
      fiscalYearOf({ startDate: null, endDate: null, asOfDate: null, accountingMethod: null }),
    ).toBeNull();
  });

  it("is nothing rather than NaN for a date it cannot read", () => {
    expect(
      fiscalYearOf({ startDate: null, endDate: "soon", asOfDate: null, accountingMethod: null }),
    ).toBeNull();
  });
});

describe("fetching a general ledger for the reconciliation", () => {
  /** A general ledger as QuickBooks shapes one. */
  const LEDGER = {
    Columns: {
      Column: [
        { ColTitle: "Date", ColType: "tx_date" },
        { ColTitle: "Transaction Type", ColType: "txn_type" },
        { ColTitle: "Name", ColType: "name" },
        { ColTitle: "Amount", ColType: "subt_nat_amount" },
        { ColTitle: "Balance", ColType: "rbal_nat_amount" },
      ],
    },
    Rows: {
      Row: [
        {
          type: "Section",
          Header: { ColData: [{ value: "Motor Expenses" }] },
          Rows: {
            Row: [
              {
                type: "Data",
                ColData: [
                  { value: "2024-01-15" },
                  { value: "Expense" },
                  { value: "Shell" },
                  { value: "-50.00" },
                  { value: "-50.00" },
                ],
              },
            ],
          },
          Summary: { ColData: [{ value: "Total" }, { value: "-50.00" }] },
        },
      ],
    },
  };

  function withLedgerStore() {
    const written: Array<{ companyId: string; rows: readonly unknown[] }> = [];
    const built = build({ fetcher: fetcher(LEDGER) });
    const service = new QuickBooksReportsService({
      statements: built.statements,
      connections: connections(),
      fetcher: built.fetcher,
      ledgerTransactions: {
        replaceBookTransactions: (companyId, rows) => {
          written.push({ companyId, rows });
          return Promise.resolve(rows.length);
        },
      },
    });
    return { service, written, statements: built.statements };
  }

  it("keeps the report AND the transactions", async () => {
    // Two destinations for one fetch, because they answer different questions:
    // what QuickBooks said, and which transactions the books contain.
    const { service, written, statements } = withLedgerStore();
    const served = await service.syncGeneralLedger(USER, COMPANY, QUERY);

    expect(served.totalInserted).toBe(1);
    expect(written[0]!.rows).toEqual([
      { date: "2024-01-15", name: "Shell", transactionType: "Expense", amount: -50 },
    ]);
    expect(await statements.list(COMPANY, { statementType: "general_ledger" })).toHaveLength(1);
  });

  it("reads the amount, not the running balance", async () => {
    // Positional reading took whichever column happened to be at the index.
    const { service, written } = withLedgerStore();
    await service.syncGeneralLedger(USER, COMPANY, QUERY);
    expect((written[0]!.rows[0] as { amount: number }).amount).toBe(-50);
  });

  it("replaces rather than accumulating", async () => {
    // Merging two fetches of overlapping periods doubles every transaction in
    // the overlap, which then reads as a duplicated payment.
    const { service, written } = withLedgerStore();
    await service.syncGeneralLedger(USER, COMPANY, QUERY);
    await service.syncGeneralLedger(USER, COMPANY, { ...QUERY, accounting_method: "Cash" });
    expect(written).toHaveLength(2);
    expect(written[1]!.rows).toHaveLength(1);
  });

  it("says so when there is nowhere to put the transactions", async () => {
    const { service } = build({ fetcher: fetcher(LEDGER) });
    await expect(service.syncGeneralLedger(USER, COMPANY, QUERY)).rejects.toThrow(
      /not available in this configuration/,
    );
  });

  it("refuses a company the caller cannot reach, before fetching", async () => {
    const { service, written } = withLedgerStore();
    await expect(
      service.syncGeneralLedger(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", QUERY),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(written).toEqual([]);
  });
});
