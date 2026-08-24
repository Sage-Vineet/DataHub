/**
 * Asking QuickBooks for a report.
 *
 * The only part of the reports surface that talks to Intuit, kept to one file
 * so everything else is testable without a network. It is a bearer-token GET
 * and nothing more — deliberately not the OAuth dance, which needs a browser
 * redirect and a real Intuit login and stays on legacy until it can be
 * exercised against a sandbox realm.
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE
 * ------------------------------------
 * `baseUrl` is injectable, so the tests run against a local server and prove
 * the request is built correctly, the errors are classified correctly, and a
 * timeout is honoured. They do NOT prove Intuit accepts the request — nothing
 * short of a sandbox realm does. The exposure is small because the response is
 * passed through to the page as opaque data rather than parsed here, so a
 * surprise in its shape is the page's problem and not a silent mis-read.
 */

/** Where Intuit lives, per environment. */
export const QUICKBOOKS_BASE_URLS = {
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
} as const;

/**
 * The API version to ask for.
 *
 * Pinned rather than left to default. Intuit's default minor version advances,
 * and an advancing default means a report's shape can change without anything
 * here changing — which is a figure moving on a page with no commit to blame.
 */
export const DEFAULT_MINOR_VERSION = 75;

/** QuickBooks' name for each report, as the URL wants it. */
export const QB_REPORT_NAMES = {
  balance_sheet: "BalanceSheet",
  profit_and_loss: "ProfitAndLoss",
  cash_flow: "CashFlow",
  general_ledger: "GeneralLedger",
  account_list: "AccountList",
} as const;

/**
 * The entities that can be queried rather than reported.
 *
 * A different Intuit endpoint — `/query`, taking a SQL-like string — and a
 * different kind of answer: a list of records rather than a statement with
 * rows and columns. Same cache, because "what a source told us when asked" is
 * one idea however it was asked.
 */
export const QB_ENTITY_NAMES = {
  customers: "Customer",
  invoices: "Invoice",
  // The five the bank-activity ladder is built from. Transactions rather than
  // lists a page shows: they are queried, added up, and thrown away.
  accounts: "Account",
  deposits: "Deposit",
  purchases: "Purchase",
  transfers: "Transfer",
  journal_entries: "JournalEntry",
} as const;

export type QbEntityType = keyof typeof QB_ENTITY_NAMES;

/**
 * The entity lists that are CACHED, as against merely queried.
 *
 * `statement_extracts` holds these two under their own names, so the type must
 * stay a subset of `StatementType`. The transaction types above are added up
 * and thrown away, and caching them would be caching the raw material rather
 * than the answer — see migration 0017 on what this table will and will not
 * stretch to.
 */
export const QB_LIST_ENTITY_TYPES = ["customers", "invoices"] as const;

export type QbListEntityType = (typeof QB_LIST_ENTITY_TYPES)[number];

export type QbReportType = keyof typeof QB_REPORT_NAMES;

/** The token was rejected. The connection needs refreshing or remaking. */
export class QuickBooksAuthError extends Error {
  constructor(message = "QuickBooks rejected the access token.") {
    super(message);
    this.name = "QuickBooksAuthError";
  }
}

/** Intuit answered, but not with a report. */
export class QuickBooksRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QuickBooksRequestError";
  }
}

export interface FetchReportInput {
  realmId: string;
  accessToken: string;
  reportType: QbReportType;
  /** `start_date`, `end_date`, `accounting_method`, and so on. */
  params: Readonly<Record<string, string>>;
}

export interface QuickBooksReportClientOptions {
  baseUrl?: string;
  minorVersion?: number;
  /**
   * How long to wait. A report over several years genuinely takes tens of
   * seconds, and a timeout shorter than that turns a slow answer into a
   * permanent failure — but without ANY timeout a hung connection holds the
   * request open until the client gives up, and the user sees a spinner
   * forever rather than an error they can act on.
   */
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** What Intuit returned, and the URL it was asked. */
export interface FetchedReport {
  payload: Record<string, unknown>;
  /** The query as sent, so a surprising figure can be traced to the question. */
  params: Record<string, string>;
}

export class QuickBooksReportClient {
  private readonly baseUrl: string;
  private readonly minorVersion: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QuickBooksReportClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? QUICKBOOKS_BASE_URLS.production).replace(/\/+$/, "");
    this.minorVersion = options.minorVersion ?? DEFAULT_MINOR_VERSION;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchReport(input: FetchReportInput): Promise<FetchedReport> {
    const reportName = QB_REPORT_NAMES[input.reportType];
    const url = new URL(
      `/v3/company/${encodeURIComponent(input.realmId)}/reports/${reportName}`,
      this.baseUrl,
    );
    for (const [key, value] of Object.entries(input.params)) {
      // An empty parameter is not the same as an absent one: Intuit reads
      // `start_date=` as a malformed date rather than as "no start date".
      if (value !== "") url.searchParams.set(key, value);
    }
    url.searchParams.set("minorversion", String(this.minorVersion));

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      // Distinguished from every other failure because the fix is different:
      // this one is "reconnect QuickBooks", and reporting it as a generic
      // error sends somebody looking for a problem with the report.
      throw new QuickBooksAuthError(
        `QuickBooks rejected the access token (${response.status}). The connection needs reconnecting.`,
      );
    }

    if (!response.ok) {
      // Intuit's error body is JSON with a Fault, but not reliably — a gateway
      // in front of it answers HTML. Read as text and truncate, so a 500 does
      // not put a page of markup in a log line.
      const body = await response.text().catch(() => "");
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered ${response.status} for ${reportName}: ${body.slice(0, 500) || "(no body)"}`,
      );
    }

    const payload = (await response.json()) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered ${reportName} with something that is not a report.`,
      );
    }

    return { payload: payload as Record<string, unknown>, params: { ...input.params } };
  }

  /**
   * Ask for a list of entities.
   *
   * A POST with a `text/plain` body, which is how Intuit's query endpoint
   * takes its query — not a typo for JSON.
   *
   * `MAXRESULTS` is always sent. Intuit pages at 100 by default and silently
   * truncates, so a company with 400 invoices gets 100 and no indication that
   * 300 are missing — figures that are simply short, with nothing to notice.
   */
  async queryEntity(input: QueryEntityInput): Promise<FetchedReport> {
    const entity = QB_ENTITY_NAMES[input.entityType];
    const start = Math.max(1, Math.trunc(input.startPosition ?? 1));
    const max = Math.min(Math.max(1, Math.trunc(input.maxResults ?? 1000)), 1000);
    const where = input.where ? ` WHERE ${input.where}` : "";
    const query = `SELECT * FROM ${entity}${where} STARTPOSITION ${start} MAXRESULTS ${max}`;

    const url = new URL(`/v3/company/${encodeURIComponent(input.realmId)}/query`, this.baseUrl);
    url.searchParams.set("minorversion", String(this.minorVersion));

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/text",
        },
        body: query,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new QuickBooksAuthError(
        `QuickBooks rejected the access token (${response.status}). The connection needs reconnecting.`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered ${response.status} for ${entity}: ${body.slice(0, 500) || "(no body)"}`,
      );
    }

    const payload = (await response.json()) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered a ${entity} query with something that is not a result.`,
      );
    }

    return {
      payload: payload as Record<string, unknown>,
      // The query itself, so a surprising list can be traced to the question.
      params: { query, startposition: String(start), maxresults: String(max) },
    };
  }

  /**
   * Create or update one entity.
   *
   * A JSON POST to the entity's own endpoint. Intuit reads `Id` + `SyncToken`
   * as "update this one" and their absence as "create a new one", which is why
   * there is no separate update call.
   */
  async mutateEntity(input: MutateEntityInput): Promise<FetchedReport> {
    const entity = QB_ENTITY_NAMES[input.entityType].toLowerCase();
    const url = new URL(
      `/v3/company/${encodeURIComponent(input.realmId)}/${entity}`,
      this.baseUrl,
    );
    url.searchParams.set("minorversion", String(this.minorVersion));

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new QuickBooksAuthError(
        `QuickBooks rejected the access token (${response.status}). The connection needs reconnecting.`,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered ${response.status} writing ${entity}: ${body.slice(0, 500) || "(no body)"}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered a ${entity} write with something that is not JSON.`,
      );
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered a ${entity} write with something that is not a result.`,
      );
    }

    return { payload: payload as Record<string, unknown>, params: {} };
  }
}

/**
 * Write one entity back to QuickBooks.
 *
 * The same endpoint creates and updates: an update is a POST carrying `Id`
 * and `SyncToken`, and Intuit decides which it is from their presence. There
 * is no PUT.
 */
export interface MutateEntityInput {
  realmId: string;
  accessToken: string;
  entityType: QbEntityType;
  /** The entity as Intuit's own schema names it — `DisplayName`, not `name`. */
  payload: Record<string, unknown>;
}

/**
 * A value inside a QuickBooks query string.
 *
 * The query language takes single-quoted literals and has no parameters, so
 * the value goes into the string itself. Legacy pasted it in raw:
 *
 *   SELECT * FROM Invoice WHERE DocNumber = '${docNumber}'
 *
 * A document number containing a quote closes the literal and the rest is
 * read as query. That is an injection into a third party's API, against a
 * client's live accounting data, reachable from a URL path segment.
 *
 * Intuit's escape is a doubled quote, the SQL convention. Backslashes are
 * removed rather than escaped — they have no meaning in a document number and
 * no documented escape here, so accepting one means guessing.
 */
export function escapeQueryLiteral(value: string): string {
  return String(value).replace(/\\/g, "").replace(/'/g, "''");
}

export interface QueryEntityInput {
  realmId: string;
  accessToken: string;
  entityType: QbEntityType;
  /**
   * An optional WHERE clause, already escaped by the caller through
   * `escapeQueryLiteral`. Kept as a string rather than built here because the
   * shapes differ per caller and a half-built query language is worse than
   * none.
   */
  where?: string;
  startPosition?: number;
  maxResults?: number;
}

/**
 * What the reports service needs from a client.
 *
 * A port rather than the class, so the service can be tested without a server
 * at all and so a future client — a queued worker, say — drops in without
 * touching anything above it.
 */
export interface ReportFetcher {
  fetchReport(input: FetchReportInput): Promise<FetchedReport>;
  queryEntity(input: QueryEntityInput): Promise<FetchedReport>;
  /**
   * Create or update one entity.
   *
   * Optional on the port: every read path works without it, and a client that
   * cannot write should not have to pretend it can.
   */
  mutateEntity?(input: MutateEntityInput): Promise<FetchedReport>;
}
