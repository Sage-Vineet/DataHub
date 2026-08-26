import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError } from "../../shared/errors.js";
import type { AskInput, DocumentReader } from "../../shared/gemini.js";
import { BankStatementsService } from "./bank-statements.js";
import type { StatementsRepository } from "./ports.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";
import type { DocumentBytesPort } from "./tax-return.js";

/**
 * Building the bank reconciliation's grid from a company's statements.
 *
 * The grid arithmetic is tested exhaustively in the engine. What is left here
 * is the reading: which documents, how many model calls, and what happens when
 * one of a dozen statements cannot be read.
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

const januaryFor = (bank: string, account: string) => ({
  bankName: bank,
  accountName: "Acme Trading LLC",
  accountNumber: account,
  statementStartDate: "2024-01-01",
  statementEndDate: "2024-01-31",
  startingBalance: 10000,
  deposits: 5000,
  withdrawals: 3000,
  fees: 0,
  endingBalance: 12000,
});

function reader(
  answers: Record<string, unknown[] | Error> = {},
): DocumentReader & { asks: AskInput[] } {
  const asks: AskInput[] = [];
  let index = 0;
  const keys = Object.keys(answers);
  return {
    asks,
    ask: () => Promise.reject(new Error("not used")),
    askForJson: <T,>(input: AskInput): Promise<T> => {
      asks.push(input);
      const answer = answers[keys[index++] ?? ""] ?? [januaryFor("Wells Fargo", "8209360067")];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
  };
}

const bytes = (available: Record<string, boolean>): DocumentBytesPort => ({
  bytesFor: (documentId) =>
    Promise.resolve(
      available[documentId] === false
        ? null
        : { bytes: Buffer.from(documentId), mimeType: "application/pdf" },
    ),
});

function build(
  over: {
    statements?: StatementsRepository;
    docs?: Array<{ id: string; name: string | null }>;
    reader?: DocumentReader & { asks: AskInput[] };
    bytes?: DocumentBytesPort;
  } = {},
) {
  const statements = over.statements ?? new InMemoryStatementsRepository();
  const r = over.reader ?? reader();
  const docs = over.docs ?? [{ id: "doc-1", name: "Wells Fargo Jan.pdf" }];
  return {
    statements,
    reader: r,
    service: new BankStatementsService({
      statements,
      documents: { forCompany: () => Promise.resolve(docs) },
      bytes: over.bytes ?? bytes({}),
      reader: r,
    }),
  };
}

const OPTIONS = { sourceKey: "manual_upload_excel_pdf" };

describe("reading the statements", () => {
  it("asks the model once per document", async () => {
    const { service, reader: r } = build({
      docs: [
        { id: "doc-1", name: "Jan.pdf" },
        { id: "doc-2", name: "Feb.pdf" },
      ],
    });
    const grid = await service.grid(USER, COMPANY, OPTIONS);
    expect(r.asks).toHaveLength(2);
    expect(grid.documentCount).toBe(2);
    expect(grid.extractedCount).toBe(2);
  });

  it("does not ask again for a document it has already read", async () => {
    // Reading a dozen statements costs a dozen model calls and the better part
    // of a minute, and the answer does not change unless the document does.
    const { service, reader: r } = build();
    await service.grid(USER, COMPANY, OPTIONS);
    const second = await service.grid(USER, COMPANY, OPTIONS);
    expect(r.asks).toHaveLength(1);
    expect(second.banks).toHaveLength(1);
    expect(second.extractedCount).toBe(0);
  });

  it("costs ONE call when a statement is added, not a dozen", async () => {
    // Legacy cached the assembled grid keyed by a signature of the document
    // set, so adding one statement invalidated the lot and re-read every
    // document.
    const docs = [{ id: "doc-1", name: "Jan.pdf" }];
    const statements = new InMemoryStatementsRepository();
    const r = reader();
    const make = () =>
      new BankStatementsService({
        statements,
        documents: { forCompany: () => Promise.resolve(docs) },
        bytes: bytes({}),
        reader: r,
      });

    await make().grid(USER, COMPANY, OPTIONS);
    docs.push({ id: "doc-2", name: "Feb.pdf" });
    await make().grid(USER, COMPANY, OPTIONS);
    expect(r.asks).toHaveLength(2);
  });

  it("re-reads everything when told to", async () => {
    const { service, reader: r } = build();
    await service.grid(USER, COMPANY, OPTIONS);
    await service.grid(USER, COMPANY, { ...OPTIONS, force: true });
    expect(r.asks).toHaveLength(2);
  });
});

describe("what a stored extract can look like", () => {
  /**
   * Two shapes are on file. Today's writer stores `{ statements: [...] }`; an
   * older one stored the array itself. Reading only the current shape empties
   * the grid for every company whose statements were extracted before the
   * change — silently, because an empty grid is what a company with no
   * statements looks like.
   */
  const gridAfterReshaping = async (reshape: (stored: unknown) => unknown) => {
    // Written by the service, so the row matches on identity exactly as a real
    // one does, then reshaped in place — which is what an older extraction
    // left behind.
    const statements = new InMemoryStatementsRepository();
    const first = build({ statements });
    await first.service.grid(USER, COMPANY, OPTIONS);

    const row = (await statements.list(COMPANY, { statementType: "bank_reconciliation" }))[0]!;
    (row as { payload: unknown }).payload = reshape(row.payload);

    const second = build({ statements });
    return { grid: await second.service.grid(USER, COMPANY, OPTIONS), asks: second.reader.asks };
  };

  it("reads today's shape", async () => {
    const { grid, asks } = await gridAfterReshaping((stored) => stored);
    expect(asks).toHaveLength(0); // served from the row, not re-read
    expect(grid.banks).toHaveLength(1);
  });

  it("reads the older shape, which stored the array itself", async () => {
    const { grid, asks } = await gridAfterReshaping(
      (stored) => (stored as { statements: unknown[] }).statements,
    );
    expect(asks).toHaveLength(0);
    expect(grid.banks).toHaveLength(1);
  });

  it("treats a row it cannot make sense of as holding nothing", async () => {
    // Rather than throwing, which takes the grid off the page for one bad row.
    const { grid } = await gridAfterReshaping(() => ({ statements: "not a list" }));
    expect(grid.banks).toEqual([]);
  });
});

describe("when one statement cannot be read", () => {
  it("keeps the rest on the page", async () => {
    // One unreadable statement should not take eleven readable ones off the
    // page.
    const { service } = build({
      docs: [
        { id: "doc-1", name: "Jan.pdf" },
        { id: "doc-2", name: "Broken.pdf" },
      ],
      bytes: bytes({ "doc-2": false }),
    });
    const grid = await service.grid(USER, COMPANY, OPTIONS);
    expect(grid.banks).toHaveLength(1);
  });

  it("keeps the rest when the model refuses one", async () => {
    const { service } = build({
      docs: [
        { id: "doc-1", name: "Jan.pdf" },
        { id: "doc-2", name: "Photo.pdf" },
      ],
      reader: reader({ a: [januaryFor("Wells Fargo", "0067")], b: new Error("blocked") }),
    });
    const grid = await service.grid(USER, COMPANY, OPTIONS);
    expect(grid.banks).toHaveLength(1);
  });

  it("says how many it found against how many it read", async () => {
    // A short grid can then be explained rather than read as a company with no
    // bank activity.
    const { service } = build({
      docs: [
        { id: "doc-1", name: "Jan.pdf" },
        { id: "doc-2", name: "Broken.pdf" },
      ],
      bytes: bytes({ "doc-2": false }),
    });
    const grid = await service.grid(USER, COMPANY, OPTIONS);
    expect(grid.documentCount).toBe(2);
    expect(grid.extractedCount).toBe(1);
  });

  it("answers an empty grid for a company with no statements", async () => {
    const { service } = build({ docs: [] });
    const grid = await service.grid(USER, COMPANY, OPTIONS);
    expect(grid).toMatchObject({ banks: [], months: [], totals: [], documentCount: 0 });
  });
});

describe("what it builds", () => {
  it("reads a stored extraction back into the grid", async () => {
    const { service, statements } = build();
    await service.grid(USER, COMPANY, OPTIONS);
    const [stored] = await statements.list(COMPANY, { statementType: "bank_reconciliation" });
    expect((stored!.payload as { statements: unknown[] }).statements).toHaveLength(1);

    const again = await service.grid(USER, COMPANY, OPTIONS);
    expect(again.banks[0]!.accounts[0]!.months[0]!.endingBalance).toBe(12000);
  });

  it("narrows to a year, recomputing the totals", async () => {
    const { service } = build({
      reader: reader({
        a: [
          januaryFor("Wells Fargo", "0067"),
          {
            ...januaryFor("Wells Fargo", "0067"),
            statementStartDate: "2023-06-01",
            statementEndDate: "2023-06-30",
            endingBalance: 999,
          },
        ],
      }),
    });
    const grid = await service.grid(USER, COMPANY, { ...OPTIONS, fiscalYear: 2024 });
    expect(grid.months).toEqual(["Jan-2024"]);
    expect(grid.banks[0]!.accounts[0]!.totals.endingBalance).toBe(12000);
  });

  it("keeps two accounts at one bank as two rows", async () => {
    const { service } = build({
      reader: reader({
        a: [januaryFor("Wells Fargo", "8209360067"), januaryFor("Wells Fargo", "8209369911")],
      }),
    });
    const grid = await service.grid(USER, COMPANY, OPTIONS);
    expect(grid.banks.map((b) => b.bank_name).sort()).toEqual([
      "Wells Fargo (0067)",
      "Wells Fargo (9911)",
    ]);
  });
});

describe("who may ask", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service, reader: r } = build();
    await expect(
      service.grid(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", OPTIONS),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(r.asks).toEqual([]);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.grid(USER, "", OPTIONS)).rejects.toThrow(/clientId/);
  });
});

describe("the bank balances the balance sheet states", () => {
  const REPLY = {
    year: 2024,
    bankAccounts: [
      { name: "Wells Fargo Business Checking", accountNumber: "0067", amount: "56,671.51" },
      { name: "Chase Savings", accountNumber: "9911", amount: 12000 },
      { name: "Total Bank Accounts", accountNumber: "", amount: 68671.51 },
      { name: "", accountNumber: "", amount: 999 },
    ],
  };

  function withBalanceSheet(
    over: { reply?: unknown; docs?: Array<{ id: string; name: string | null }> } = {},
  ) {
    const statements = new InMemoryStatementsRepository();
    const r = reader({ a: over.reply === undefined ? (REPLY as never) : (over.reply as never) });
    const docs = over.docs ?? [{ id: "bs-1", name: "Balance Sheet 2024.pdf" }];
    return {
      statements,
      reader: r,
      service: new BankStatementsService({
        statements,
        documents: { forCompany: () => Promise.resolve([]) },
        balanceSheetDocuments: {
          forVersion: () => Promise.resolve([]),
          latest: () => Promise.resolve(docs[0] ?? null),
        },
        bytes: bytes({}),
        reader: r,
      }),
    };
  }

  it("reads the accounts and the year", async () => {
    const { service } = withBalanceSheet();
    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.year).toBe(2024);
    expect(result.bankAccounts.map((a) => a.name)).toEqual([
      "Wells Fargo Business Checking",
      "Chase Savings",
    ]);
  });

  it("reads an amount that carries a comma", async () => {
    // `parseFloat("56,671.51") || 0` is 56 — not zero, WORSE than zero: a
    // plausible-looking figure three orders of magnitude out.
    const { service } = withBalanceSheet();
    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.bankAccounts[0]!.amount).toBe(56671.51);
  });

  it("drops a total, which would double count the cash", async () => {
    const { service } = withBalanceSheet();
    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.bankAccounts.some((a) => /total/i.test(a.name))).toBe(false);
  });

  it("drops a nameless row", async () => {
    const { service } = withBalanceSheet();
    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.bankAccounts).toHaveLength(2);
  });

  it("names the document it read", async () => {
    const { service } = withBalanceSheet();
    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.documentName).toBe("Balance Sheet 2024.pdf");
    expect(result.source).toBe("extracted");
  });

  it("refuses a year that could not be one", async () => {
    const { service } = withBalanceSheet({ reply: { year: 20244, bankAccounts: [] } });
    expect((await service.balanceSheetBalances(USER, COMPANY)).year).toBeNull();
  });

  it("says so when no balance sheet is on file", async () => {
    const { service } = withBalanceSheet({ docs: [] });
    await expect(service.balanceSheetBalances(USER, COMPANY)).rejects.toThrow(/balance sheet/i);
  });

  it("does not treat a dashboard extraction as an answer", async () => {
    // A balance sheet extracted for the DASHBOARD holds a row tree and no
    // account list. Reading that as "already read" answers with no accounts
    // for a company that has them.
    const { service, statements } = withBalanceSheet();
    await statements.save({
      companyId: COMPANY,
      provenance: { from: "document", documentId: "bs-1" },
      statementType: "balance_sheet",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      payload: { rows: [{ name: "Total Assets", amount: 1 }] },
      extractedBy: null,
    });

    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.source).toBe("extracted");
    expect(result.bankAccounts).toHaveLength(2);
  });

  it("refuses a company the caller cannot reach", async () => {
    const { service } = withBalanceSheet();
    await expect(
      service.balanceSheetBalances(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = withBalanceSheet();
    await expect(service.balanceSheetBalances(USER, "")).rejects.toThrow(/clientId/);
  });

  it("says so when this deployment cannot look a balance sheet up at all", async () => {
    // Configured without the port. A 400 naming the configuration beats a
    // TypeError, which reads as a fault in the reconciliation.
    const statements = new InMemoryStatementsRepository();
    const service = new BankStatementsService({
      statements,
      documents: { forCompany: () => Promise.resolve([]) },
      bytes: bytes({}),
      reader: reader({}),
    });
    await expect(service.balanceSheetBalances(USER, COMPANY)).rejects.toThrow(/not available/i);
  });

  it("says so when the balance sheet has no file behind it", async () => {
    const statements = new InMemoryStatementsRepository();
    const service = new BankStatementsService({
      statements,
      documents: { forCompany: () => Promise.resolve([]) },
      balanceSheetDocuments: {
        forVersion: () => Promise.resolve([]),
        latest: () => Promise.resolve({ id: "bs-missing", name: "Gone.pdf" }),
      },
      bytes: { bytesFor: () => Promise.resolve(null) },
      reader: reader({}),
    });
    await expect(service.balanceSheetBalances(USER, COMPANY)).rejects.toThrow(/no file stored/i);
  });

  it("prefers the balance sheet a version links over the company's latest", async () => {
    // Opening a six-month-old report version and being shown last week's
    // upload is a different company's-worth of numbers, with nothing on
    // screen to say so.
    const statements = new InMemoryStatementsRepository();
    const r = reader({ a: { year: 2023, bankAccounts: [] } as never });
    const service = new BankStatementsService({
      statements,
      documents: { forCompany: () => Promise.resolve([]) },
      balanceSheetDocuments: {
        forVersion: () => Promise.resolve([{ id: "linked", name: "Linked BS.pdf" }]),
        latest: () => Promise.resolve({ id: "latest", name: "Latest BS.pdf" }),
      },
      bytes: bytes({}),
      reader: r,
    });

    const result = await service.balanceSheetBalances(USER, COMPANY, {
      keyReportVersionId: "v1",
    });
    expect(result.documentId).toBe("linked");
  });

  it("serves a stored account list rather than reading the document again", async () => {
    const { service, statements, reader: r } = withBalanceSheet();
    await statements.save({
      companyId: COMPANY,
      provenance: { from: "document", documentId: "bs-1" },
      statementType: "balance_sheet",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      payload: { year: 2024, bankAccounts: [{ name: "Stored Bank", accountNumber: "1", amount: 5 }] },
      extractedBy: null,
    });

    const result = await service.balanceSheetBalances(USER, COMPANY);
    expect(result.source).toBe("stored");
    expect(result.bankAccounts.map((a) => a.name)).toEqual(["Stored Bank"]);
    expect(r.asks).toEqual([]);
  });

  it("reads it again when the caller asks for a refresh", async () => {
    const { service, statements, reader: r } = withBalanceSheet();
    await statements.save({
      companyId: COMPANY,
      provenance: { from: "document", documentId: "bs-1" },
      statementType: "balance_sheet",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      payload: { year: 2024, bankAccounts: [{ name: "Stale", accountNumber: "1", amount: 5 }] },
      extractedBy: null,
    });

    const result = await service.balanceSheetBalances(USER, COMPANY, { force: true });
    expect(result.source).toBe("extracted");
    expect(r.asks).toHaveLength(1);
  });
});

describe("a balance sheet the model barely read", () => {
  // None of these should throw: an exception takes the whole reconciliation
  // off the page for one ragged row.
  const service = () =>
    new BankStatementsService({
      statements: new InMemoryStatementsRepository(),
      documents: { forCompany: () => Promise.resolve([]) },
      balanceSheetDocuments: {
        forVersion: () => Promise.resolve([]),
        latest: () => Promise.resolve({ id: "bs-1", name: "BS.pdf" }),
      },
      bytes: bytes({}),
      reader: reader({}),
    });

  const read = async (reply: unknown) => {
    const statements = new InMemoryStatementsRepository();
    const r = reader({ a: reply as never });
    const built = new BankStatementsService({
      statements,
      documents: { forCompany: () => Promise.resolve([]) },
      balanceSheetDocuments: {
        forVersion: () => Promise.resolve([]),
        latest: () => Promise.resolve({ id: "bs-1", name: "BS.pdf" }),
      },
      bytes: bytes({}),
      reader: r,
    });
    return built.balanceSheetBalances(USER, COMPANY);
  };

  it("copes with a reply that is not an object at all", async () => {
    expect(await read(null)).toMatchObject({ year: null, bankAccounts: [] });
    expect(await read("I could not read it")).toMatchObject({ bankAccounts: [] });
  });

  it("copes with an account list that is not a list", async () => {
    expect((await read({ year: 2024, bankAccounts: "none" })).bankAccounts).toEqual([]);
  });

  it("copes with an entry that is not an object", async () => {
    const result = await read({ year: 2024, bankAccounts: [null, "Chase", 42] });
    expect(result.bankAccounts).toEqual([]);
  });

  it("reads an account with no number and an unreadable amount", async () => {
    // The name is what makes it an account. A missing number is common and a
    // missing amount is nothing, not a reason to drop the row.
    const result = await read({ bankAccounts: [{ name: "Chase Savings", amount: "n/a" }] });
    expect(result.bankAccounts).toEqual([
      { name: "Chase Savings", accountNumber: "", amount: 0 },
    ]);
    expect(result.year).toBeNull();
    expect(service()).toBeDefined();
  });
});
