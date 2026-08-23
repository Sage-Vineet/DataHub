import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { InMemoryStatementsRepository } from "../../statements/repository.memory.js";
import type { StatementsRepository } from "../../statements/ports.js";
import type { ConnectionRecord, QuickBooksRepository } from "../ports.js";
import {
  QuickBooksAuthError,
  QuickBooksRequestError,
  escapeQueryLiteral,
  type QueryEntityInput,
  type ReportFetcher,
} from "./client.js";
import { QuickBooksEntitiesService } from "./entities.js";
import { QUICKBOOKS_SOURCE_KEY } from "./service.js";

/**
 * Customers and invoices.
 *
 * Lists rather than reports, which changes what a cache hit means: there is no
 * period to match, so freshness is a clock. Legacy went live only when the
 * cache came back EMPTY, which is wrong in both directions — a company with
 * genuinely no invoices called Intuit on every page load, and one whose list
 * was stale never refetched at all.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/**
 * Close to the in-memory repository's own clock.
 *
 * That fake stamps `extractedAt` from a monotonic counter starting at
 * 2024-01-01 rather than from a wall clock, so "newest" is well defined in a
 * test. Freshness here is measured against that stamp, so the test's clock has
 * to sit beside it — a `now` a year later makes every cache stale and the
 * freshness tests pass for the wrong reason.
 */
const NOW = new Date("2024-01-01T00:05:00.000Z");

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

function connections(
  over: Partial<{ record: ConnectionRecord | null; accessToken: string | null }> = {},
): QuickBooksRepository {
  const record = over.record === undefined ? CONNECTED : over.record;
  const accessToken = over.accessToken === undefined ? "token-1" : over.accessToken;
  return {
    get: () => Promise.resolve(record),
    getByRealm: () => Promise.resolve(record),
    save: () => Promise.reject(new Error("not used")),
    disconnect: () => Promise.resolve(true),
    recordSync: () => Promise.resolve(),
    tokens: () =>
      Promise.resolve(
        accessToken === null ? null : { accessToken, refreshToken: null, tokenExpiresAt: null },
      ),
  };
}

function fetcher(
  answer: Record<string, unknown> | Error = { QueryResponse: { Customer: [{ Id: "1" }] } },
): ReportFetcher & { queries: QueryEntityInput[] } {
  const queries: QueryEntityInput[] = [];
  return {
    queries,
    fetchReport: () => Promise.reject(new Error("not used")),
    queryEntity: (input) => {
      queries.push(input);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ payload: answer, params: { query: "SELECT ..." } });
    },
  };
}

function build(
  over: {
    statements?: StatementsRepository;
    connections?: QuickBooksRepository;
    fetcher?: ReportFetcher & { queries: QueryEntityInput[] };
  } = {},
) {
  const statements = over.statements ?? new InMemoryStatementsRepository();
  const f = over.fetcher ?? fetcher();
  return {
    statements,
    fetcher: f,
    service: new QuickBooksEntitiesService({
      statements,
      connections: over.connections ?? connections(),
      fetcher: f,
    }),
  };
}

/** Put a list in the cache, extracted at a given time. */
const cache = (statements: StatementsRepository, statementType: string) =>
  statements.save({
    companyId: COMPANY,
    provenance: { from: "pull", reportParams: {}, variant: null },
    statementType: statementType as never,
    sourceKey: QUICKBOOKS_SOURCE_KEY,
    periodStart: null,
    periodEnd: null,
    asOfDate: null,
    fiscalYear: null,
    payload: { QueryResponse: { Customer: [{ Id: "cached" }] } },
    extractedBy: null,
  });

describe("escaping a value into a query", () => {
  it("doubles a quote rather than letting it close the literal", () => {
    // Legacy pasted the path segment straight in:
    //   SELECT * FROM Invoice WHERE DocNumber = '${docNumber}'
    // A number containing a quote closes the literal and the rest is read as
    // query — an injection into a third party's API, against a client's live
    // accounting data, reachable from a URL path segment.
    expect(escapeQueryLiteral("INV-1' OR '1'='1")).toBe("INV-1'' OR ''1''=''1");
  });

  it("removes a backslash rather than guessing at an escape", () => {
    // It has no meaning in a document number and no documented escape here,
    // so accepting one means guessing what Intuit does with it.
    expect(escapeQueryLiteral("INV\\-1")).toBe("INV-1");
  });

  it("leaves an ordinary value alone", () => {
    expect(escapeQueryLiteral("INV-2024-001")).toBe("INV-2024-001");
  });
});

describe("serving a list", () => {
  it("fetches when nothing is cached, and keeps what comes back", async () => {
    const { service, statements, fetcher: f } = build();
    const served = await service.list(USER, COMPANY, "customers", NOW);
    expect(served.source).toBe("live_fetch");
    expect(f.queries[0]).toMatchObject({ realmId: "realm-1", entityType: "customers" });

    const held = await statements.list(COMPANY, { statementType: "customers" });
    expect(held).toHaveLength(1);
  });

  it("serves a fresh cache without asking Intuit", async () => {
    const { service, statements, fetcher: f } = build();
    await cache(statements, "customers");
    const served = await service.list(USER, COMPANY, "customers", NOW);
    expect(served.source).toBe("cached_snapshot");
    expect(f.queries).toHaveLength(0);
  });

  it("refetches a stale cache", async () => {
    // Freshness is a clock. Legacy refetched only when the cache came back
    // empty, so a list that had gone stale was never refreshed at all.
    const { service, statements, fetcher: f } = build();
    await cache(statements, "customers");
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const served = await service.list(USER, COMPANY, "customers", later);
    expect(served.source).toBe("live_fetch");
    expect(f.queries).toHaveLength(1);
  });

  it("serves an EMPTY cached list rather than refetching it", async () => {
    // The other half of the same defect: a company that genuinely has no
    // invoices called Intuit on every page load, which is exactly the
    // companies that need it least.
    const { service, statements, fetcher: f } = build();
    await statements.save({
      companyId: COMPANY,
      provenance: { from: "pull", reportParams: {}, variant: null },
      statementType: "invoices" as never,
      sourceKey: QUICKBOOKS_SOURCE_KEY,
      periodStart: null,
      periodEnd: null,
      asOfDate: null,
      fiscalYear: null,
      payload: { QueryResponse: {} },
      extractedBy: null,
    });

    const served = await service.list(USER, COMPANY, "invoices", NOW);
    expect(served.source).toBe("cached_snapshot");
    expect(f.queries).toHaveLength(0);
  });

  it("replaces rather than accumulating when fetched again", async () => {
    // A list has no period and no basis, so nothing distinguishes two pulls of
    // it. Accumulating would leave "latest" meaning whichever fetch happened
    // to finish last.
    const { service, statements } = build();
    await service.list(USER, COMPANY, "customers", NOW);
    await service.list(USER, COMPANY, "customers", new Date(NOW.getTime() + 3_600_000));
    expect(await statements.list(COMPANY, { statementType: "customers" })).toHaveLength(1);
  });

  it("serves the cache when disconnected, however old", async () => {
    const { service, statements, fetcher: f } = build({
      connections: connections({ record: { ...CONNECTED, isConnected: false } }),
    });
    await cache(statements, "customers");
    const served = await service.list(
      USER,
      COMPANY,
      "customers",
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(served.source).toBe("cached_snapshot");
    expect(served.disconnected).toBe(true);
    expect(f.queries).toHaveLength(0);
  });

  it("falls back to a stale cache when the fetch fails", async () => {
    const { service, statements } = build({
      fetcher: fetcher(new QuickBooksRequestError(503, "unavailable")),
    });
    await cache(statements, "customers");
    const served = await service.list(
      USER,
      COMPANY,
      "customers",
      new Date(NOW.getTime() + 3_600_000),
    );
    expect(served.source).toBe("cached_snapshot");
  });

  it("does NOT fall back when the token was rejected", async () => {
    const { service, statements } = build({ fetcher: fetcher(new QuickBooksAuthError()) });
    await cache(statements, "customers");
    await expect(
      service.list(USER, COMPANY, "customers", new Date(NOW.getTime() + 3_600_000)),
    ).rejects.toBeInstanceOf(QuickBooksAuthError);
  });

  it("says which problem it is when there is nothing at all", async () => {
    const { service } = build({ connections: connections({ record: null }) });
    await expect(service.list(USER, COMPANY, "customers", NOW)).rejects.toThrow(/disconnected/i);

    const { service: connected } = build({
      fetcher: fetcher(new QuickBooksRequestError(500, "boom")),
    });
    await expect(connected.list(USER, COMPANY, "customers", NOW)).rejects.toThrow(/run a quickbooks sync/i);
  });
});

describe("one invoice by its number", () => {
  const invoice = { QueryResponse: { Invoice: [{ Id: "42", DocNumber: "INV-1" }] } };

  it("escapes the number into the query", async () => {
    const { service, fetcher: f } = build({ fetcher: fetcher(invoice) });
    await service.invoiceByDocNumber(USER, COMPANY, "INV-1' OR '1'='1");
    expect(f.queries[0]!.where).toBe("DocNumber = 'INV-1'' OR ''1''=''1'");
  });

  it("unwraps the invoice from the query envelope", async () => {
    // The caller asked for one invoice; unwrapping here saves every caller
    // from knowing Intuit's response shape.
    const { service } = build({ fetcher: fetcher(invoice) });
    const served = await service.invoiceByDocNumber(USER, COMPANY, "INV-1");
    expect(served.data).toEqual({ Id: "42", DocNumber: "INV-1" });
    expect(served.source).toBe("live_fetch");
  });

  it("is always live, never from cache", async () => {
    // An invoice is looked up by number when somebody is about to act on it,
    // and a cached one is exactly the wrong thing to show then.
    const { service, statements, fetcher: f } = build({ fetcher: fetcher(invoice) });
    await cache(statements, "invoices");
    await service.invoiceByDocNumber(USER, COMPANY, "INV-1");
    expect(f.queries).toHaveLength(1);
  });

  it("404s a number that matches nothing", async () => {
    const { service } = build({ fetcher: fetcher({ QueryResponse: {} }) });
    await expect(service.invoiceByDocNumber(USER, COMPANY, "INV-9")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("refuses an empty number rather than querying for one", async () => {
    const { service, fetcher: f } = build({ fetcher: fetcher(invoice) });
    await expect(service.invoiceByDocNumber(USER, COMPANY, "   ")).rejects.toThrow(/document number/i);
    expect(f.queries).toHaveLength(0);
  });

  it("says QuickBooks is disconnected rather than looking anyway", async () => {
    const { service } = build({
      connections: connections({ record: { ...CONNECTED, isConnected: false } }),
      fetcher: fetcher(invoice),
    });
    await expect(service.invoiceByDocNumber(USER, COMPANY, "INV-1")).rejects.toThrow(
      /disconnected/i,
    );
  });

  it("says so when the stored token cannot be read", async () => {
    const { service } = build({
      connections: connections({ accessToken: null }),
      fetcher: fetcher(invoice),
    });
    await expect(service.invoiceByDocNumber(USER, COMPANY, "INV-1")).rejects.toBeInstanceOf(
      QuickBooksAuthError,
    );
  });
});

describe("who may ask", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service } = build();
    await expect(
      service.list(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "customers", NOW),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.invoiceByDocNumber(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "INV-1"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.list(USER, "", "customers", NOW)).rejects.toThrow(/clientId/);
  });
});
