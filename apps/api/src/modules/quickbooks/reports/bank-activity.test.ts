import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { InMemoryStatementsRepository } from "../../statements/repository.memory.js";
import { InMemoryQuickBooksRepository } from "../repository.memory.js";
import type { FetchReportInput, QueryEntityInput, ReportFetcher } from "./client.js";
import {
  QuickBooksBankActivityService,
  amountOf,
  readBankRows,
  requireIsoDate,
  toAccountingMethod,
  toMovements,
} from "./bank-activity.js";

const COMPANY = randomUUID();
const OTHER = randomUUID();
const REALM = "4620816365000000000";

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const RANGE = { startDate: "2026-01-01", endDate: "2026-02-28", accountingMethod: "Accrual" };

const ref = (id: string) => ({ value: id });

/** A balance sheet naming one bank account and its balance. */
const balanceSheet = (name: string, amount: number) => ({
  Rows: {
    Row: [
      {
        Rows: {
          Row: [{ ColData: [{ value: name }, { value: String(amount) }] }],
        },
      },
    ],
  },
});

interface Queries {
  Account?: unknown[];
  Deposit?: unknown[];
  Purchase?: unknown[];
  Transfer?: unknown[];
  JournalEntry?: unknown[];
}

function fetcher(
  queries: Queries,
  reports: Record<string, unknown> = {},
): ReportFetcher & { asked: string[]; pages: QueryEntityInput[] } {
  const asked: string[] = [];
  const pages: QueryEntityInput[] = [];
  const NAMES: Record<string, keyof Queries> = {
    accounts: "Account",
    deposits: "Deposit",
    purchases: "Purchase",
    transfers: "Transfer",
    journal_entries: "JournalEntry",
  };

  return {
    asked,
    pages,
    queryEntity: (input: QueryEntityInput) => {
      pages.push(input);
      const name = NAMES[input.entityType]!;
      const all = (queries[name] ?? []) as unknown[];
      const start = (input.startPosition ?? 1) - 1;
      const page = all.slice(start, start + (input.maxResults ?? 1000));
      return Promise.resolve({
        payload: { QueryResponse: { [name]: page } },
        params: {},
      });
    },
    fetchReport: (input: FetchReportInput) => {
      const key =
        input.reportType === "balance_sheet"
          ? `balance_sheet:${input.params.start_date?.slice(0, 7)}`
          : input.reportType;
      asked.push(key);
      const found = reports[key];
      if (found instanceof Error) return Promise.reject(found);
      return Promise.resolve({
        payload: (found ?? { Rows: { Row: [] } }) as Record<string, unknown>,
        params: input.params,
      });
    },
  };
}

async function build(queries: Queries = {}, reports: Record<string, unknown> = {}) {
  const connections = new InMemoryQuickBooksRepository();
  await connections.save({
    companyId: COMPANY,
    realmId: REALM,
    realmCompanyName: "Acme Books",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    environment: "production",
    oauthClientId: "client",
    redirectUri: "https://example.test/cb",
    connectedBy: USER.id,
  });
  const statements = new InMemoryStatementsRepository();
  const fake = fetcher(queries, reports);
  return {
    connections,
    statements,
    fetcher: fake,
    service: new QuickBooksBankActivityService({ connections, fetcher: fake, statements }),
  };
}

describe("the range a caller asks for", () => {
  it("takes a date QuickBooks writes", () => {
    expect(requireIsoDate("2026-01-31", "start_date")).toBe("2026-01-31");
  });

  it("refuses anything that is not one", () => {
    // Legacy pasted both dates straight into the QuickBooks query language.
    // Same class of hole as the document-number injection: a caller-controlled
    // string inside a quoted literal, against a client's live accounting data.
    expect(() => requireIsoDate("2026-01-31' OR '1'='1", "start_date")).toThrow(BadRequestError);
    expect(() => requireIsoDate("", "start_date")).toThrow(/start_date/);
    expect(() => requireIsoDate(undefined, "end_date")).toThrow(/end_date/);
  });

  it("refuses a date that matches the shape but is not real", () => {
    // QuickBooks answers a nonsense range with an empty report rather than an
    // error, which reads as a company with no transactions at all.
    expect(() => requireIsoDate("2026-02-31", "end_date")).toThrow(/not a real date/);
    expect(() => requireIsoDate("2026-13-01", "end_date")).toThrow(/not a real date/);
  });

  it("takes only the two accounting bases QuickBooks has", () => {
    expect(toAccountingMethod("Cash")).toBe("Cash");
    expect(toAccountingMethod("cash")).toBe("Cash");
    expect(toAccountingMethod("Accrual")).toBe("Accrual");
    expect(toAccountingMethod("whatever the caller sent")).toBe("Accrual");
    expect(toAccountingMethod(undefined)).toBe("Accrual");
  });
});

describe("reading an amount", () => {
  it("takes a number as it stands", () => {
    expect(amountOf(1234.56)).toBe(1234.56);
    expect(amountOf(-40)).toBe(-40);
  });

  it("reads one written with separators", () => {
    // `parseFloat("1,234.56")` is 1 — it stops at the comma and reports
    // success, so an account holding twelve hundred pounds reads as one.
    expect(amountOf("1,234.56")).toBe(1234.56);
    expect(amountOf("$56,671.51")).toBe(56671.51);
  });

  it("treats what it cannot read as nothing", () => {
    expect(amountOf(undefined)).toBe(0);
    expect(amountOf("n/a")).toBe(0);
    expect(amountOf(Number.NaN)).toBe(0);
    expect(amountOf(Number.POSITIVE_INFINITY)).toBe(0);
    // Strips to "1-2", which is not a number however hard it looks like one.
    expect(amountOf("1-2-3")).toBe(0);
  });
});

describe("turning transactions into movements", () => {
  const bankIds = new Set(["35", "36"]);

  it("reads a deposit into the account it landed in", () => {
    const movements = toMovements(
      {
        deposits: [
          { TxnDate: "2026-01-15", DepositToAccountRef: ref("35"), TotalAmt: 500 },
        ],
        purchases: [],
        transfers: [],
        journals: [],
      },
      bankIds,
    );
    expect(movements).toEqual([
      { accountId: "35", month: "2026-01", deposits: 500, withdrawals: 0, intercompany: false },
    ]);
  });

  it("reads a purchase as a withdrawal, absolutely", () => {
    const movements = toMovements(
      {
        deposits: [],
        purchases: [{ TxnDate: "2026-01-15", AccountRef: ref("35"), TotalAmt: -120 }],
        transfers: [],
        journals: [],
      },
      bankIds,
    );
    expect(movements[0]!.withdrawals).toBe(120);
  });

  it("moves a transfer out of one account and into the other", () => {
    const movements = toMovements(
      {
        deposits: [],
        purchases: [],
        transfers: [
          {
            TxnDate: "2026-01-20",
            FromAccountRef: ref("35"),
            ToAccountRef: ref("36"),
            Amount: 1_000,
          },
        ],
        journals: [],
      },
      bankIds,
    );
    expect(movements).toEqual([
      { accountId: "35", month: "2026-01", deposits: 0, withdrawals: 1_000, intercompany: true },
      { accountId: "36", month: "2026-01", deposits: 1_000, withdrawals: 0, intercompany: true },
    ]);
  });

  it("calls it intercompany only when both ends are the company's own", () => {
    // Money moved between pockets, as against earned or spent. A transfer to
    // an account that is not the company's is a real outflow.
    const movements = toMovements(
      {
        deposits: [],
        purchases: [],
        transfers: [
          {
            TxnDate: "2026-01-20",
            FromAccountRef: ref("35"),
            ToAccountRef: ref("99"),
            Amount: 400,
          },
        ],
        journals: [],
      },
      bankIds,
    );
    expect(movements.every((m) => !m.intercompany)).toBe(true);
  });

  it("reads a journal line against a bank account by its posting type", () => {
    const movements = toMovements(
      {
        deposits: [],
        purchases: [],
        transfers: [],
        journals: [
          {
            TxnDate: "2026-02-01",
            Line: [
              {
                Amount: 250,
                JournalEntryLineDetail: { AccountRef: ref("35"), PostingType: "Debit" },
              },
              {
                Amount: 250,
                JournalEntryLineDetail: { AccountRef: ref("36"), PostingType: "Credit" },
              },
            ],
          },
        ],
      },
      bankIds,
    );
    expect(movements).toEqual([
      { accountId: "35", month: "2026-02", deposits: 250, withdrawals: 0, intercompany: false },
      { accountId: "36", month: "2026-02", deposits: 0, withdrawals: 250, intercompany: false },
    ]);
  });

  it("skips a journal line that does not say which way it posts", () => {
    // Legacy's `if (Debit) deposits else withdrawals` took money OUT of the
    // account for every line that failed to say.
    const movements = toMovements(
      {
        deposits: [],
        purchases: [],
        transfers: [],
        journals: [
          { TxnDate: "2026-02-01", Line: [{ Amount: 250, JournalEntryLineDetail: { AccountRef: ref("35") } }] },
        ],
      },
      bankIds,
    );
    expect(movements).toEqual([]);
  });

  it("ignores journal lines against accounts that are not banks", () => {
    const movements = toMovements(
      {
        deposits: [],
        purchases: [],
        transfers: [],
        journals: [
          {
            TxnDate: "2026-02-01",
            Line: [
              {
                Amount: 250,
                JournalEntryLineDetail: { AccountRef: ref("77"), PostingType: "Debit" },
              },
            ],
          },
        ],
      },
      bankIds,
    );
    expect(movements).toEqual([]);
  });

  it("drops a transaction with no readable date or account", () => {
    const movements = toMovements(
      {
        deposits: [
          { TxnDate: "not a date", DepositToAccountRef: ref("35"), TotalAmt: 1 },
          { TxnDate: "2026-01-15", TotalAmt: 1 },
        ],
        purchases: [{ TxnDate: "2026-01-15", TotalAmt: 1 }],
        transfers: [{ TxnDate: "", Amount: 1 }],
        journals: [{ TxnDate: "", Line: [] }],
      },
      bankIds,
    );
    expect(movements).toEqual([]);
  });
});

describe("a QuickBooks answer with pieces missing", () => {
  // Intuit omits optional fields rather than sending nulls, and a company's
  // chart routinely has accounts with no number. None of these should throw:
  // an exception here takes out the whole reconciliation for one ragged row.
  const bankIds = new Set(["35"]);

  it("reads an account that names almost nothing", () => {
    const rows = readBankRows(balanceSheet("", 0), [
      { id: "", name: "", accountNumber: "", currentBalance: 0 },
    ]);
    expect(rows).toEqual([["", 0]]);
  });

  it("skips rows that are not rows", () => {
    expect(
      readBankRows({ Rows: { Row: [null, "a string", 42, { ColData: [] }] } }, []),
    ).toEqual([]);
  });

  it("copes with a cell that carries no value", () => {
    expect(readBankRows({ Rows: { Row: [{ ColData: [{}, {}] }] } }, [])).toEqual([]);
  });

  it("skips transactions with no date, no refs and no lines", () => {
    expect(
      toMovements(
        {
          deposits: [{}],
          purchases: [{}],
          transfers: [{}],
          journals: [{}, { TxnDate: "2026-01-01" }, { TxnDate: "2026-01-01", Line: "no" }],
        },
        bankIds,
      ),
    ).toEqual([]);
  });

  it("skips a journal line whose detail is not an object", () => {
    expect(
      toMovements(
        {
          deposits: [],
          purchases: [],
          transfers: [],
          journals: [
            {
              TxnDate: "2026-01-01",
              Line: [{ Amount: 1 }, { Amount: 1, JournalEntryLineDetail: null }],
            },
          ],
        },
        bankIds,
      ),
    ).toEqual([]);
  });

  it("reads a ref carrying no value as no account", () => {
    expect(
      toMovements(
        { deposits: [{ TxnDate: "2026-01-01", DepositToAccountRef: {}, TotalAmt: 1 }], purchases: [], transfers: [], journals: [] },
        bankIds,
      ),
    ).toEqual([]);
  });

  it("reads a ref that is not an object as no account", () => {
    expect(
      toMovements(
        { deposits: [{ TxnDate: "2026-01-01", DepositToAccountRef: "35", TotalAmt: 1 }], purchases: [], transfers: [], journals: [] },
        bankIds,
      ),
    ).toEqual([]);
  });
});

describe("reading a balance sheet's bank rows", () => {
  const accounts = [
    { id: "35", name: "Wells Fargo Checking", accountNumber: "0067", currentBalance: 0 },
  ];

  it("matches a row to the account it names", () => {
    expect(readBankRows(balanceSheet("Wells Fargo Checking", 56_671.51), accounts)).toEqual([
      ["35", 56_671.51],
    ]);
  });

  it("matches regardless of spacing or case", () => {
    expect(readBankRows(balanceSheet("  wells   fargo  checking ", 100), accounts)).toEqual([
      ["35", 100],
    ]);
  });

  it("skips a row naming no account of the company's", () => {
    // The section holds sub-totals and other assets. A "Total Bank Accounts"
    // row taken for an account doubles the cash.
    expect(readBankRows(balanceSheet("Total Bank Accounts", 99_999), accounts)).toEqual([]);
  });

  it("copes with a report that has no rows at all", () => {
    expect(readBankRows({}, accounts)).toEqual([]);
    expect(readBankRows(null, accounts)).toEqual([]);
  });
});

describe("the ladder over HTTP-less plumbing", () => {
  const ACCOUNTS = [
    { Id: "35", Name: "Operating", AcctNum: "0067", CurrentBalance: 5_000 },
    { Id: "36", Name: "Savings", AcctNum: "0099", CurrentBalance: 20_000 },
  ];

  it("copes with an answer that carries no records at all", async () => {
    // An empty QueryResponse, and one with no QueryResponse. Both are answers
    // QuickBooks gives, and neither is an error.
    const { statements, connections } = await build();
    const service = new QuickBooksBankActivityService({
      connections,
      statements,
      fetcher: {
        queryEntity: () => Promise.resolve({ payload: {}, params: {} }),
        fetchReport: () => Promise.resolve({ payload: { Rows: { Row: [] } }, params: {} }),
      },
    });
    expect((await service.ladders(USER, COMPANY, RANGE)).accounts).toEqual([]);
  });

  it("copes with a records field that is not a list", async () => {
    const { statements, connections } = await build();
    const service = new QuickBooksBankActivityService({
      connections,
      statements,
      fetcher: {
        queryEntity: () => Promise.resolve({ payload: { QueryResponse: { Account: "no" } }, params: {} }),
        fetchReport: () => Promise.resolve({ payload: { Rows: { Row: [] } }, params: {} }),
      },
    });
    expect((await service.ladders(USER, COMPANY, RANGE)).accounts).toEqual([]);
  });

  it("names an account the chart left blank rather than dropping it", async () => {
    const { service } = await build({ Account: [{ Name: "Nameless" }] });
    const result = await service.ladders(USER, COMPANY, RANGE);
    expect(result.accounts[0]).toMatchObject({
      accountId: "",
      accountName: "Nameless",
      accountNumber: "",
      currentBalance: 0,
    });
  });

  it("builds one ladder per bank account", async () => {
    const { service } = await build({ Account: ACCOUNTS });
    const result = await service.ladders(USER, COMPANY, RANGE);

    expect(result.accounts.map((a) => a.accountId)).toEqual(["35", "36"]);
    expect(result.months).toEqual(["2026-01", "2026-02"]);
    expect(result.truncated).toEqual([]);
  });

  it("anchors the ladder to the month's stated balance", async () => {
    const { service } = await build(
      {
        Account: [ACCOUNTS[0]],
        Deposit: [{ TxnDate: "2026-01-10", DepositToAccountRef: ref("35"), TotalAmt: 800 }],
      },
      { "balance_sheet:2026-01": balanceSheet("Operating", 3_800) },
    );
    const result = await service.ladders(USER, COMPANY, RANGE);
    const rows = result.accounts[0]!.monthlyData;

    expect(result.accounts[0]!.openingBalanceSource).toBe("balance_sheet");
    expect(rows[0]!.startingBalance).toBe(3_000);
    expect(rows[0]!.endingBalance).toBe(3_800);
    expect(rows[0]!.variance).toBe(0);
  });

  it("asks for one balance sheet per month", async () => {
    // A balance sheet states a POSITION rather than a movement, so
    // `summarize_column_by=Month` on it answers a different question.
    const { service, fetcher: fake } = await build({ Account: [ACCOUNTS[0]] });
    await service.ladders(USER, COMPANY, RANGE);
    expect(fake.asked).toContain("balance_sheet:2026-01");
    expect(fake.asked).toContain("balance_sheet:2026-02");
  });

  it("leaves a month whose balance sheet failed absent rather than zero", async () => {
    // A zero is a bank account holding nothing, and the ladder would then
    // report a variance the size of the whole balance.
    const { service } = await build(
      { Account: [ACCOUNTS[0]] },
      {
        "balance_sheet:2026-01": balanceSheet("Operating", 3_000),
        "balance_sheet:2026-02": new Error("Intuit is having a moment"),
      },
    );
    const rows = (await service.ladders(USER, COMPANY, RANGE)).accounts[0]!.monthlyData;
    expect(rows[0]!.perBalanceSheet).toBe(3_000);
    expect(rows[1]!.perBalanceSheet).toBeNull();
    expect(rows[1]!.variance).toBeNull();
  });

  it("pages a query rather than taking the first thousand", async () => {
    // Legacy asked for MAXRESULTS 1000 once. A company with more got the first
    // thousand and no indication the rest existed — a ladder that is simply,
    // quietly short.
    const deposits = Array.from({ length: 1_400 }, (_, i) => ({
      TxnDate: "2026-01-10",
      DepositToAccountRef: ref("35"),
      TotalAmt: 1,
      Id: String(i),
    }));
    const { service, fetcher: fake } = await build({ Account: [ACCOUNTS[0]], Deposit: deposits });
    const rows = (await service.ladders(USER, COMPANY, RANGE)).accounts[0]!.monthlyData;

    expect(rows[0]!.deposits).toBe(1_400);
    expect(fake.pages.filter((p) => p.entityType === "deposits")).toHaveLength(2);
  });

  it("says so when a query hits the page ceiling", async () => {
    const deposits = Array.from({ length: 21_000 }, (_, i) => ({
      TxnDate: "2026-01-10",
      DepositToAccountRef: ref("35"),
      TotalAmt: 1,
      Id: String(i),
    }));
    const { service } = await build({ Account: [ACCOUNTS[0]], Deposit: deposits });
    const result = await service.ladders(USER, COMPANY, RANGE);

    // Truncated and admitting it is a different thing from truncated silently.
    expect(result.truncated).toEqual(["Deposit"]);
  });

  it("reads the monthly P&L totals alongside the ladder", async () => {
    const { service } = await build(
      { Account: [ACCOUNTS[0]] },
      {
        profit_and_loss: {
          Columns: {
            Column: [
              { ColTitle: "", ColType: "" },
              { ColTitle: "Jan 2026", ColType: "" },
              { ColTitle: "Total", ColType: "" },
            ],
          },
          Rows: {
            Row: [
              {
                type: "Section",
                Header: { ColData: [{ value: "Income" }] },
                Rows: {
                  Row: [
                    {
                      type: "Data",
                      ColData: [{ value: "Sales" }, { value: "10,000.00" }, { value: "10000" }],
                    },
                  ],
                },
              },
              {
                type: "Section",
                // Legacy matched `/^(expenses?|total expenses?)$/i`, which
                // misses this — for a chart using it, expenses came back empty
                // with nothing on the page to say why.
                Header: { ColData: [{ value: "Operating Expenses" }] },
                Rows: {
                  Row: [
                    {
                      type: "Data",
                      ColData: [{ value: "Rent" }, { value: "2,500.00" }, { value: "2500" }],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    );
    const result = await service.ladders(USER, COMPANY, RANGE);
    expect(result.plFinancials.totalIncome["2026-01"]).toBe(10_000);
    expect(result.plFinancials.totalExpenses["2026-01"]).toBe(2_500);
  });

  it("still answers when the P&L will not fetch", async () => {
    // The ladder is the answer; the P&L columns sit alongside it.
    const { service } = await build(
      { Account: [ACCOUNTS[0]] },
      { profit_and_loss: new Error("nope") },
    );
    const result = await service.ladders(USER, COMPANY, RANGE);
    expect(result.plFinancials).toEqual({ totalIncome: {}, totalExpenses: {} });
    expect(result.accounts).toHaveLength(1);
  });

  it("saves the answer so the page can restore it without a connection", async () => {
    const { service, statements } = await build({ Account: [ACCOUNTS[0]] });
    await service.ladders(USER, COMPANY, RANGE);

    const saved = await statements.latest(COMPANY, "bank_reconciliation", { provenance: "pull" });
    expect(saved?.periodStart).toBe("2026-01-01");
    expect(saved?.periodEnd).toBe("2026-02-28");
    expect(saved?.reportParams).toMatchObject({ accountingMethod: "Accrual" });
    expect(saved?.payload.months).toEqual(["2026-01", "2026-02"]);
  });

  it("keeps the two accounting bases apart", async () => {
    // The same range on a cash basis and an accrual one are different answers.
    // Sharing an identity means the second replaces the first and the page
    // shows whichever was fetched last, with nothing to say which.
    const { service, statements } = await build({ Account: [ACCOUNTS[0]] });
    await service.ladders(USER, COMPANY, RANGE);
    await service.ladders(USER, COMPANY, { ...RANGE, accountingMethod: "Cash" });

    const all = await statements.list(COMPANY, { statementType: "bank_reconciliation" });
    expect(all).toHaveLength(2);
  });

  it("replaces rather than accumulating when the same range is fetched again", async () => {
    const { service, statements } = await build({ Account: [ACCOUNTS[0]] });
    await service.ladders(USER, COMPANY, RANGE);
    await service.ladders(USER, COMPANY, RANGE);

    const all = await statements.list(COMPANY, { statementType: "bank_reconciliation" });
    expect(all).toHaveLength(1);
  });

  it("refuses a company the caller cannot reach", async () => {
    const { service } = await build();
    await expect(service.ladders(USER, OTHER, RANGE)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = await build();
    await expect(service.ladders(USER, "", RANGE)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("says the connection is missing rather than answering an empty ladder", async () => {
    const { service, connections } = await build({ Account: ACCOUNTS });
    await connections.disconnect(COMPANY);
    await expect(service.ladders(USER, COMPANY, RANGE)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("says so for a company that never connected at all", async () => {
    const { statements, fetcher: fake } = await build();
    const bare = new QuickBooksBankActivityService({
      connections: new InMemoryQuickBooksRepository(),
      fetcher: fake,
      statements,
    });
    await expect(bare.ladders(USER, COMPANY, RANGE)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("says so for a connection whose token cannot be read", async () => {
    // A sealed column that will not open reads as no token, and the fix is the
    // same: reconnect. Asking Intuit with an empty bearer would 401 and send
    // somebody looking for a fault in the report.
    const { statements, fetcher: fake } = await build();
    const connections = new InMemoryQuickBooksRepository();
    await connections.save({
      companyId: COMPANY,
      realmId: REALM,
      realmCompanyName: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      environment: "production",
      oauthClientId: null,
      redirectUri: null,
      connectedBy: null,
    });
    const service = new QuickBooksBankActivityService({ connections, fetcher: fake, statements });
    await expect(service.ladders(USER, COMPANY, RANGE)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("asks for no balance sheets at all when the company has no bank accounts", async () => {
    // One report per month for a company with nothing to reconcile is a dozen
    // round trips to answer with an empty grid.
    const { service, fetcher: fake } = await build({ Account: [] });
    const result = await service.ladders(USER, COMPANY, RANGE);
    expect(result.accounts).toEqual([]);
    expect(fake.asked.filter((a) => a.startsWith("balance_sheet"))).toEqual([]);
  });
});

describe("one account's ladder", () => {
  const ACCOUNTS = [
    { Id: "35", Name: "Operating", AcctNum: "0067", CurrentBalance: 5_000 },
    { Id: "36", Name: "Savings", AcctNum: "0099", CurrentBalance: 20_000 },
  ];

  it("answers the same figures the grid shows", async () => {
    // Legacy's single-account route used the account's CURRENT balance as the
    // opening and never fetched a balance sheet, so the drill-down and the
    // grid disagreed by however much the account had moved since.
    const { service } = await build(
      { Account: ACCOUNTS },
      { "balance_sheet:2026-01": balanceSheet("Savings", 20_500) },
    );
    const one = await service.oneLadder(USER, COMPANY, "36", RANGE);
    const all = await service.ladders(USER, COMPANY, RANGE);

    expect(one.account).toEqual({
      accountId: "36",
      bankName: "Savings",
      accountNumber: "0099",
    });
    expect(one.monthlyData).toEqual(all.accounts.find((a) => a.accountId === "36")!.monthlyData);
  });

  it("404s an account that is not on the company's chart", async () => {
    const { service } = await build({ Account: ACCOUNTS });
    await expect(service.oneLadder(USER, COMPANY, "999", RANGE)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("refuses a request naming no account", async () => {
    const { service } = await build({ Account: ACCOUNTS });
    await expect(service.oneLadder(USER, COMPANY, "", RANGE)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});
