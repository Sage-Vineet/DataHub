import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { DocumentReader } from "../../shared/gemini.js";
import { modelNumber } from "../../shared/model-json.js";
import { CATEGORY_OF_STATEMENT, type StatementExtract, type StatementsRepository } from "./ports.js";

/**
 * What a tax return says, beside what the books say.
 *
 * The Tax Reconciliation page sets nine figures from a return against the same
 * nine from the P&L. Reading them out of the return is a model's job: a 1120-S
 * is a scanned form, and no amount of parsing gets a number off it reliably.
 *
 * WHAT THIS REPLACES, AND WHY IT MATTERS
 * --------------------------------------
 * The version this replaces read its PDF from the SERVER'S FILESYSTEM:
 *
 *   const DEFAULT_PDF_PATH = process.env.GEMINI_PDF_TEST_PATH ||
 *     "C:\\Users\\adiko\\Downloads\\Example QoE Documents\\...\\Tax Return 2.pdf";
 *
 * It took `path.dirname` of that, listed the PDFs there, and picked the first
 * whose FILENAME contained the requested year. On Linux that dirname is `"."`,
 * the working directory, which holds no PDFs — so the route has always
 * answered `{ success: true, data: [], warning: "No tax return PDF found" }`.
 * A success, with a warning nobody reads as a failure.
 *
 * The lookup ignored `clientId` while the cache key included it. Had a PDF with
 * a year in its name ever appeared in that directory, every company asking for
 * that year would have received that document's figures, cached under their own
 * id.
 *
 * This reads the company's OWN tax return: the document a key-report version
 * files under `tax_return`, or the most recent one on file for the company.
 * Nothing else can be reached from here.
 */

/** The nine figures a return and a P&L are compared on. */
export interface TaxReturnFigures {
  year: number | null;
  formType: string;
  totalRevenue: number;
  totalCostOfGoodsSold: number;
  grossProfit: number;
  officerWages: number;
  depreciation: number;
  amortization: number;
  interestExpense: number;
  netIncome: number;
  /**
   * Derived, not read.
   *
   * Gross profit less the named costs less the profit itself is whatever is
   * left. Asking the model for it too would produce a figure that agrees with
   * that subtraction only by luck, and disagrees silently when it does not.
   */
  allOtherExpenses: number;
  /**
   * Schedule K reconciling items — the book-to-tax differences the return
   * itself lists. Free-form, because a return lists whatever it lists.
   */
  reconcilingItems: Array<{ label: string; value: number }>;
}

export interface TaxReturnResult {
  figures: TaxReturnFigures;
  /** The document it was read out of, so a reader can check a figure. */
  documentId: string;
  documentName: string | null;
  extractedAt: string | null;
  /** Whether this request re-read the document or served what was stored. */
  source: "stored" | "extracted";
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The prompt.
 *
 * Kept beside the parsing it feeds rather than in a constants file, because
 * the two have to change together: adding a field to the prompt without adding
 * it here yields a figure nobody reads, and the reverse yields a zero.
 */
export const TAX_RETURN_PROMPT = `You are reading a United States business tax return.

Return ONLY a JSON object, with no commentary and no markdown fence, of this shape:

{
  "year": 2023,
  "formType": "1120-S",
  "totalRevenue": 0,
  "totalCostOfGoodsSold": 0,
  "grossProfit": 0,
  "officerWages": 0,
  "depreciation": 0,
  "amortization": 0,
  "interestExpense": 0,
  "netIncome": 0,
  "reconcilingItems": [{ "label": "Meals and entertainment", "value": 0 }]
}

Rules:
- "year" is the tax year the return covers, as a number.
- "formType" is the form's own designation, e.g. "1120-S", "1065", "1120".
- Every amount is a plain number. Do not include currency symbols, thousands
  separators or parentheses; write a negative as a negative number.
- Use the figures as printed on the return. Do not compute or reconcile them.
- "reconcilingItems" lists the Schedule K / M-1 book-to-tax differences the
  return states. Omit any with a value of zero.
- If a figure does not appear on the return, use 0.`;

/** Read the model's object into the figures, coercing every amount. */
export function toTaxReturnFigures(parsed: unknown): TaxReturnFigures {
  const raw = (parsed ?? {}) as Record<string, unknown>;
  const amount = (key: string): number => modelNumber(raw[key]) ?? 0;

  const grossProfit = amount("grossProfit");
  const officerWages = amount("officerWages");
  const depreciation = amount("depreciation");
  const amortization = amount("amortization");
  const interestExpense = amount("interestExpense");
  const netIncome = amount("netIncome");

  const year = modelNumber(raw.year);
  const items = Array.isArray(raw.reconcilingItems) ? raw.reconcilingItems : [];

  return {
    // A year outside any plausible range is a misread rather than a tax year,
    // and filing figures under it hides them from every year selector.
    year: year !== null && Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null,
    // 1120-S is the commonest small-business return and the least wrong guess
    // when the model does not say. Named here so the page shows something a
    // person can correct rather than an empty label.
    formType: String(raw.formType ?? "").trim() || "1120-S",
    totalRevenue: amount("totalRevenue"),
    totalCostOfGoodsSold: amount("totalCostOfGoodsSold"),
    grossProfit,
    officerWages,
    depreciation,
    amortization,
    interestExpense,
    netIncome,
    allOtherExpenses: round2(
      grossProfit - officerWages - depreciation - amortization - interestExpense - netIncome,
    ),
    reconcilingItems: items
      .map((item) => {
        const entry = (item ?? {}) as { label?: unknown; value?: unknown };
        return {
          label: String(entry.label ?? "").trim(),
          value: modelNumber(entry.value) ?? 0,
        };
      })
      // A nameless item cannot be matched against anything on the books, and a
      // zero difference is not a difference.
      .filter((item) => item.label !== "" && item.value !== 0),
  };
}

/** Where the document's bytes come from. */
export interface DocumentBytesPort {
  /** The file behind a document, or null when there is nothing stored. */
  bytesFor(documentId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
}

/** Which document holds the company's tax return. */
export interface TaxReturnDocumentPort {
  /**
   * The document a key-report version files under `tax_return`, newest first.
   *
   * Scoped to the company as well as the version, so a version id from another
   * company cannot reach a document.
   */
  forVersion(companyId: string, versionId: string): Promise<Array<{ id: string; name: string | null }>>;
  /** The most recent tax return on file for a company. */
  latest(companyId: string): Promise<{ id: string; name: string | null } | null>;
}

export interface TaxReturnServiceDeps {
  statements: StatementsRepository;
  documents: TaxReturnDocumentPort;
  bytes: DocumentBytesPort;
  reader: DocumentReader;
}

export class TaxReturnService {
  constructor(private readonly deps: TaxReturnServiceDeps) {}

  /**
   * The figures from a company's tax return.
   *
   * Served from what was already extracted unless `force` is set. That is not
   * a performance cache: asking a model to read a scanned form takes tens of
   * seconds and costs money per call, and the answer does not change unless
   * the document does. It is keyed by DOCUMENT, in the database — legacy kept
   * a JSON file in the source tree keyed by filesystem path, which is shared
   * across every company that process serves.
   */
  async read(
    user: SessionUser,
    companyId: string,
    options: { keyReportVersionId?: string; force?: boolean } = {},
  ): Promise<TaxReturnResult> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const document = await this.resolveDocument(companyId, options.keyReportVersionId);
    if (!document) {
      throw new NotFoundError(
        "No tax return is on file for this company. Upload one and link it to a report version.",
      );
    }

    if (!options.force) {
      const stored = await this.deps.statements.forDocument(companyId, document.id, "tax_return");
      if (stored) return this.fromStored(stored, document);
    }

    const file = await this.deps.bytes.bytesFor(document.id);
    if (!file) {
      throw new NotFoundError(
        `The tax return "${document.name ?? document.id}" has no file stored against it.`,
      );
    }

    const parsed = await this.deps.reader.askForJson({
      prompt: TAX_RETURN_PROMPT,
      document: { mimeType: file.mimeType, data: file.bytes.toString("base64") },
    });
    const figures = toTaxReturnFigures(parsed);

    const saved = await this.deps.statements.save({
      companyId,
      provenance: { from: "document", documentId: document.id },
      statementType: "tax_return",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: null,
      fiscalYear: figures.year,
      payload: figures as unknown as Record<string, unknown>,
      extractedBy: user.id,
    });

    return {
      figures,
      documentId: document.id,
      documentName: document.name,
      extractedAt: saved.extractedAt,
      source: "extracted",
    };
  }

  private fromStored(
    stored: StatementExtract,
    document: { id: string; name: string | null },
  ): TaxReturnResult {
    return {
      // Re-read through the same coercion, so a row written by an older
      // extraction answers in today's shape rather than whatever it stored.
      figures: toTaxReturnFigures(stored.payload),
      documentId: document.id,
      documentName: stored.documentName ?? document.name,
      extractedAt: stored.extractedAt,
      source: "stored",
    };
  }

  private async resolveDocument(
    companyId: string,
    versionId: string | undefined,
  ): Promise<{ id: string; name: string | null } | null> {
    if (versionId) {
      const linked = await this.deps.documents.forVersion(companyId, versionId);
      // A version that links one wins. Falling through when it links none is
      // deliberate: a version with nothing linked should still show something,
      // and the response names the document either way.
      if (linked[0]) return linked[0];
    }
    return this.deps.documents.latest(companyId);
  }
}

/** The nine labels the page puts down its left-hand column, in order. */
export const TAX_RETURN_LABELS = [
  "Total Revenue",
  "Total Cost of Goods Sold",
  "Gross Profit",
  "Officer Wages",
  "Depreciation Expense",
  "Amortization Expense",
  "Total Interest Expense",
  "All Other Expenses",
  "Net Income",
] as const;

/** The figures as the page's rows — the same shape `/quickbooks-pl` answers. */
export function toTaxReturnRows(
  figures: TaxReturnFigures,
): Array<{ label: string; taxReturn: number }> {
  const byLabel: Record<string, number> = {
    "Total Revenue": figures.totalRevenue,
    "Total Cost of Goods Sold": figures.totalCostOfGoodsSold,
    "Gross Profit": figures.grossProfit,
    "Officer Wages": figures.officerWages,
    "Depreciation Expense": figures.depreciation,
    "Amortization Expense": figures.amortization,
    "Total Interest Expense": figures.interestExpense,
    "All Other Expenses": figures.allOtherExpenses,
    "Net Income": figures.netIncome,
  };
  return TAX_RETURN_LABELS.map((label) => ({ label, taxReturn: byLabel[label] ?? 0 }));
}

/** The category a key-report version files a tax return under. */
export const TAX_RETURN_CATEGORY = CATEGORY_OF_STATEMENT.tax_return;
