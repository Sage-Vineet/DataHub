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
