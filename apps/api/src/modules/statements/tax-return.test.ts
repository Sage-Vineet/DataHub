import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { AskInput, DocumentReader } from "../../shared/gemini.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";
import type { StatementsRepository } from "./ports.js";
import {
  TaxReturnService,
  toTaxReturnFigures,
  toTaxReturnRows,
  type DocumentBytesPort,
  type TaxReturnDocumentPort,
} from "./tax-return.js";

/**
 * Reading a company's tax return.
 *
 * The version this replaces read its PDF from the server's filesystem, matched
 * by filename against the requested year, ignoring the company entirely. It
 * has never worked in a deployed environment — and if a PDF had ever appeared
 * in that directory it would have served one company's figures to all of them.
 *
 * So the first thing these tests are about is that a document can only be
 * reached through the company that owns it.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const USER: SessionUser = {
  id: "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu",
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const MODEL_REPLY = {
  year: 2023,
  formType: "1120-S",
  totalRevenue: "1,250,000.00",
  totalCostOfGoodsSold: "500,000",
  grossProfit: 750000,
  officerWages: 120000,
  depreciation: 45000,
  amortization: 5000,
  interestExpense: 30000,
  netIncome: 400000,
  reconcilingItems: [
    { label: "Meals and entertainment", value: "12,500" },
    { label: "", value: 999 },
    { label: "Nothing to see", value: 0 },
  ],
};

/** Documents belonging to each company, so a leak is a test failure. */
function documents(
  byCompany: Record<string, Array<{ id: string; name: string | null }>>,
): TaxReturnDocumentPort {
  return {
    forVersion: (companyId, versionId) =>
      Promise.resolve(versionId === "linked-version" ? (byCompany[companyId] ?? []) : []),
    latest: (companyId) => Promise.resolve((byCompany[companyId] ?? [])[0] ?? null),
  };
}

function bytes(available: Record<string, Buffer>): DocumentBytesPort {
  return {
    bytesFor: (documentId) =>
      Promise.resolve(
        available[documentId]
          ? { bytes: available[documentId]!, mimeType: "application/pdf" }
          : null,
      ),
  };
}

function reader(answer: unknown = MODEL_REPLY): DocumentReader & { asks: AskInput[] } {
  const asks: AskInput[] = [];
  return {
    asks,
    ask: () => Promise.reject(new Error("not used")),
    askForJson: <T,>(input: AskInput): Promise<T> => {
      asks.push(input);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
  };
}

function build(
  over: {
    statements?: StatementsRepository;
    documents?: TaxReturnDocumentPort;
    bytes?: DocumentBytesPort;
    reader?: DocumentReader & { asks: AskInput[] };
  } = {},
) {
  const statements = over.statements ?? new InMemoryStatementsRepository();
  const r = over.reader ?? reader();
  return {
    statements,
    reader: r,
    service: new TaxReturnService({
      statements,
      documents:
        over.documents ??
        documents({
          [COMPANY]: [{ id: "doc-ours", name: "Return 2023.pdf" }],
          [OTHER]: [{ id: "doc-theirs", name: "Their Return.pdf" }],
        }),
      bytes:
        over.bytes ??
        bytes({ "doc-ours": Buffer.from("ours"), "doc-theirs": Buffer.from("theirs") }),
      reader: r,
    }),
  };
}

describe("whose document it reads", () => {
  it("reads the company's own", async () => {
    const { service } = build();
    const result = await service.read(USER, COMPANY);
    expect(result.documentId).toBe("doc-ours");
    expect(result.documentName).toBe("Return 2023.pdf");
  });

  it("cannot be pointed at another company's, even with their version id", async () => {
    // The old lookup ignored the company entirely. Here the version is
    // resolved THROUGH the company, so a version id from elsewhere reaches
    // nothing belonging to elsewhere.
    const { service } = build();
    const result = await service.read(USER, COMPANY, { keyReportVersionId: "linked-version" });
    expect(result.documentId).toBe("doc-ours");
  });

  it("refuses a company the caller cannot reach", async () => {
    const { service, reader: r } = build();
    await expect(service.read(USER, OTHER)).rejects.toBeInstanceOf(ForbiddenError);
    // And does not read the document on the way to refusing.
    expect(r.asks).toEqual([]);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.read(USER, "")).rejects.toThrow(/clientId/);
  });

  it("says plainly when the company has no return on file", async () => {
    // Legacy answered `{ success: true, data: [], warning: … }` — a success,
    // with a warning nobody reads as a failure.
    const { service } = build({ documents: documents({}) });
    await expect(service.read(USER, COMPANY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("says which document has no file behind it", async () => {
    const { service } = build({ bytes: bytes({}) });
    await expect(service.read(USER, COMPANY)).rejects.toThrow(/Return 2023\.pdf/);
  });

  it("names it by id when the document has no name to give", async () => {
    // `documents.name` is nullable. `The tax return "" has no file stored
    // against it` names nothing anybody can go and look at; the id is ugly and
    // findable, which is the right trade in an error.
    const { service } = build({
      documents: documents({ [COMPANY]: [{ id: "doc-ours", name: null }] }),
      bytes: bytes({}),
    });
    await expect(service.read(USER, COMPANY)).rejects.toThrow(/doc-ours/);
  });
});

describe("asking the model", () => {
  it("sends the document and the prompt", async () => {
    const { service, reader: r } = build();
    await service.read(USER, COMPANY);
    expect(r.asks[0]!.document).toEqual({
      mimeType: "application/pdf",
      data: Buffer.from("ours").toString("base64"),
    });
    expect(r.asks[0]!.prompt).toContain("tax return");
  });

  it("does not ask again once it has an answer for that document", async () => {
    // Not a performance cache: asking a model to read a scanned form takes
    // tens of seconds and costs money per call, and the answer does not change
    // unless the document does.
    const { service, reader: r } = build();
    await service.read(USER, COMPANY);
    const second = await service.read(USER, COMPANY);
    expect(r.asks).toHaveLength(1);
    expect(second.source).toBe("stored");
  });

  it("asks again when told to", async () => {
    const { service, reader: r } = build();
    await service.read(USER, COMPANY);
    const forced = await service.read(USER, COMPANY, { force: true });
    expect(r.asks).toHaveLength(2);
    expect(forced.source).toBe("extracted");
  });

  it("keys what it stored by DOCUMENT, so another company cannot reach it", async () => {
    // Legacy kept a JSON file in the source tree keyed by filesystem path,
    // which is shared across every company that process serves.
    const { service, statements } = build();
    await service.read(USER, COMPANY);
    expect(await statements.list(OTHER, { statementType: "tax_return" })).toEqual([]);
  });
});

describe("reading the model's figures", () => {
  it("reads money the way a model writes it", async () => {
    // `Number("1,250,000.00") || 0` is 0 — a company with no revenue.
    const { service } = build();
    const { figures } = await service.read(USER, COMPANY);
    expect(figures.totalRevenue).toBe(1250000);
    expect(figures.totalCostOfGoodsSold).toBe(500000);
  });

  it("derives everything else so the nine reconcile", () => {
    // 750000 − 120000 − 45000 − 5000 − 30000 − 400000
    const figures = toTaxReturnFigures(MODEL_REPLY);
    expect(figures.allOtherExpenses).toBe(150000);
  });

  it("keeps only the reconciling items that mean something", () => {
    // A nameless item cannot be matched against anything on the books, and a
    // zero difference is not a difference.
    const figures = toTaxReturnFigures(MODEL_REPLY);
    expect(figures.reconcilingItems).toEqual([
      { label: "Meals and entertainment", value: 12500 },
    ]);
  });

  it("keeps a ragged reconciling list from taking the page down", () => {
    /**
     * The model writes this list freely, and every shape below has been seen:
     * a null in the array, an entry that is a bare string, a label with no
     * value, a value that is not a number.
     *
     * None may throw — an exception here takes the whole tax reconciliation
     * off the page for one bad row — and none may become a row the reader
     * cannot act on. A nameless item cannot be matched against anything on the
     * books, and a zero difference is not a difference.
     */
    const figures = toTaxReturnFigures({
      reconcilingItems: [
        null,
        "Meals",
        { label: "  Meals and entertainment  ", value: "12,500" },
        { label: "Fines", value: "not a number" },
        { value: 900 },
        { label: "Zeroed", value: 0 },
        { label: "Real", value: 400 },
      ],
    });

    expect(figures.reconcilingItems).toEqual([
      { label: "Meals and entertainment", value: 12500 },
      { label: "Real", value: 400 },
    ]);
  });

  it("refuses a year that cannot be a tax year", () => {
    // Filing figures under a misread year hides them from every year selector.
    expect(toTaxReturnFigures({ year: 20233 }).year).toBeNull();
    expect(toTaxReturnFigures({ year: "not a year" }).year).toBeNull();
    expect(toTaxReturnFigures({}).year).toBeNull();
  });

  it("names a form type when the model does not", () => {
    // So the page shows something a person can correct rather than a blank.
    expect(toTaxReturnFigures({}).formType).toBe("1120-S");
    expect(toTaxReturnFigures({ formType: " 1065 " }).formType).toBe("1065");
  });

  it("reads a missing figure as zero rather than as NaN", () => {
    const figures = toTaxReturnFigures({ totalRevenue: "n/a" });
    expect(figures.totalRevenue).toBe(0);
    expect(Number.isNaN(figures.allOtherExpenses)).toBe(false);
  });

  it("copes with a reply that is not an object at all", () => {
    expect(toTaxReturnFigures(null).totalRevenue).toBe(0);
    expect(toTaxReturnFigures("nonsense").reconcilingItems).toEqual([]);
  });

  it("re-reads a stored row through the same coercion", async () => {
    // A row written by an older extraction answers in today's shape rather
    // than whatever it happened to store.
    const { service, statements } = build();
    await statements.save({
      companyId: COMPANY,
      provenance: { from: "document", documentId: "doc-ours" },
      statementType: "tax_return",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: null,
      fiscalYear: 2023,
      payload: { totalRevenue: "1,000", grossProfit: 500, netIncome: 100 },
      extractedBy: null,
    });

    const { figures } = await service.read(USER, COMPANY);
    expect(figures.totalRevenue).toBe(1000);
    expect(figures.allOtherExpenses).toBe(400);
  });
});

describe("the page's rows", () => {
  it("renders the nine labels in order", () => {
    const rows = toTaxReturnRows(toTaxReturnFigures(MODEL_REPLY));
    expect(rows.map((r) => r.label)).toEqual([
      "Total Revenue",
      "Total Cost of Goods Sold",
      "Gross Profit",
      "Officer Wages",
      "Depreciation Expense",
      "Amortization Expense",
      "Total Interest Expense",
      "All Other Expenses",
      "Net Income",
    ]);
  });

  it("carries the figures across", () => {
    const rows = toTaxReturnRows(toTaxReturnFigures(MODEL_REPLY));
    expect(rows.find((r) => r.label === "Total Revenue")!.taxReturn).toBe(1250000);
    expect(rows.find((r) => r.label === "All Other Expenses")!.taxReturn).toBe(150000);
  });

  it("matches the label set `/quickbooks-pl` answers, so the two align", () => {
    // The page sets them side by side. A label in one and not the other leaves
    // a row with one half filled and nothing saying why.
    const rows = toTaxReturnRows(toTaxReturnFigures({}));
    expect(rows).toHaveLength(9);
  });
});
