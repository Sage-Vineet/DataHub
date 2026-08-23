import type { SessionUser } from "@datahub/contracts";
import {
  buildBankResponseShape,
  normaliseExtractedStatement,
  scopeToYear,
  type BankResponseShape,
  type RawExtractedStatement,
} from "@datahub/financial-engine";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { DocumentReader } from "../../shared/gemini.js";
import type { StatementsRepository } from "./ports.js";
import type { DocumentBytesPort } from "./tax-return.js";

/**
 * The bank reconciliation's grid, from a company's uploaded statements.
 *
 * Read the statements, extract each one, build the grid. The grid-building is
 * arithmetic and lives in the engine; this is the part that finds the
 * documents and asks a model to read them.
 *
 * WHAT IS STORED AND WHY
 * ----------------------
 * Each statement's extraction is kept as a `bank_reconciliation` extract
 * against the DOCUMENT it came from, so re-opening the page does not re-read
 * every PDF. That is not a performance nicety: reading a dozen statements
 * costs a dozen model calls and the better part of a minute, and the answer
 * does not change unless the document does.
 *
 * Legacy cached the assembled GRID instead, keyed by a signature of the
 * document set. Two problems with that: adding one statement invalidated the
 * whole cache and re-read every document, and the cached grid could not be
 * re-scoped to a different year without going back to the model. Keeping the
 * per-document extractions means adding a statement costs one call.
 */

export interface BankStatementsServiceDeps {
  statements: StatementsRepository;
  bytes: DocumentBytesPort;
  reader: DocumentReader;
  /** Which documents hold this company's bank statements. */
  documents: {
    forCompany(
      companyId: string,
      options: { sourceKey: string; keyReportVersionId?: string },
    ): Promise<Array<{ id: string; name: string | null }>>;
  };
}

export const BANK_STATEMENT_PROMPT = `You are reading bank statements.

STEP 1 — Is this a bank statement? Count how many of these appear anywhere in
the document: "Beginning balance", "Ending balance", "Total credits",
"Total debits", "Account summary", "Deposits", "Withdrawals", "Account number",
"Opening balance", "Closing balance", "Statement date", "Transactions".
If fewer than three appear, return [].

STEP 2 — For EACH account and EACH statement period, return one object:
{
  "bankName": "Wells Fargo",
  "accountName": "Acme Trading LLC",
  "accountNumber": "8209360067",
  "statementStartDate": "2025-01-01",
  "statementEndDate": "2025-01-31",
  "startingBalance": 4306.99,
  "deposits": 174012.41,
  "withdrawals": 121647.89,
  "fees": 0,
  "endingBalance": 56671.51
}

Search the whole document rather than fixed positions:
  Beginning / Opening / Starting / Previous balance -> startingBalance
  Total credits / Credits / Deposits / Additions     -> deposits
  Total debits / Debits / Withdrawals / Subtractions -> withdrawals (always positive)
  Service charges / Fees / Maintenance               -> fees
  Ending / Closing / New / Current balance           -> endingBalance
  accountName: the entity on the statement header, not the bank
  Dates MUST be YYYY-MM-DD.

BEGINNING AND ENDING ARE DIFFERENT NUMBERS. The opening balance is the position
BEFORE the period; the closing balance is the position AFTER it. Do not use the
same figure for both unless the account genuinely did not move. Where no
opening balance is shown, use 0.

CHECK before answering: startingBalance + deposits - withdrawals - fees should
equal endingBalance to within 1.00. If it does not, re-read and correct.

Return ONLY a raw JSON array. No markdown, no fences, no commentary. Amounts are
plain numbers: no currency symbols, no thousands separators, no parentheses.`;

export class BankStatementsService {
  constructor(private readonly deps: BankStatementsServiceDeps) {}

  /**
   * The grid for a company.
   *
   * `fiscalYear` narrows it, and the narrowing recomputes every total from the
   * surviving months — a totals row carried over would describe months the
   * page is no longer showing.
   */
  async grid(
    user: SessionUser,
    companyId: string,
    options: {
      sourceKey: string;
      keyReportVersionId?: string;
      fiscalYear?: number;
      force?: boolean;
    },
  ): Promise<BankResponseShape & { documentCount: number; extractedCount: number }> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const documents = await this.deps.documents.forCompany(companyId, {
      sourceKey: options.sourceKey,
      ...(options.keyReportVersionId ? { keyReportVersionId: options.keyReportVersionId } : {}),
    });

    const statements: RawExtractedStatement[] = [];
    let extractedCount = 0;

    for (const document of documents) {
      const stored = options.force
        ? null
        : await this.deps.statements.forDocument(companyId, document.id, "bank_reconciliation");

      if (stored) {
        statements.push(...readStored(stored.payload));
        continue;
      }

      const file = await this.deps.bytes.bytesFor(document.id);
      // A document with no file behind it is skipped rather than failing the
      // whole grid: one unreadable statement should not take eleven readable
      // ones off the page.
      if (!file) continue;

      let parsed: unknown;
      try {
        parsed = await this.deps.reader.askForJson({
          prompt: BANK_STATEMENT_PROMPT,
          document: { mimeType: file.mimeType, data: file.bytes.toString("base64") },
        });
      } catch {
        // Same reasoning. The grid reports how many documents it read against
        // how many it found, so a caller can see that some did not answer.
        continue;
      }

      const fromDocument = Array.isArray(parsed) ? (parsed as RawExtractedStatement[]) : [];
      extractedCount += 1;

      await this.deps.statements.save({
        companyId,
        provenance: { from: "document", documentId: document.id },
        statementType: "bank_reconciliation",
        sourceKey: options.sourceKey,
        periodStart: null,
        periodEnd: null,
        asOfDate: null,
        fiscalYear: null,
        payload: { statements: fromDocument },
        extractedBy: user.id,
      });

      statements.push(...fromDocument);
    }

    const shape = buildBankResponseShape(statements.map(normaliseExtractedStatement));

    return {
      ...scopeToYear(shape, options.fiscalYear ?? null),
      documentCount: documents.length,
      extractedCount,
    };
  }
}

/** The statements inside a stored extract, whatever shape it holds. */
function readStored(payload: Record<string, unknown>): RawExtractedStatement[] {
  const inner = (payload as { statements?: unknown }).statements;
  if (Array.isArray(inner)) return inner as RawExtractedStatement[];
  // An older row stored the array directly. Both are on file.
  return Array.isArray(payload) ? (payload as RawExtractedStatement[]) : [];
}
