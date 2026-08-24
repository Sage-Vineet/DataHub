import type { SessionUser } from "@datahub/contracts";
import { statementYear } from "@datahub/financial-engine";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import type { DocumentReader } from "../../shared/gemini.js";
import { STATEMENT_PROMPT, toDate, toStatementRows } from "../statements/source-sync.js";
import type { LinkedDocument, StatementsRepository } from "../statements/ports.js";
import type { DocumentBytesPort } from "../statements/tax-return.js";
import { flattenStatement, type StatementEntryRow } from "./statement-entries.js";
import type { ReportsRepository } from "./ports.js";

/**
 * Reading a key-report version's linked files into the entry tables.
 *
 * `balance_sheet_entries` and `profit_loss_entries` are the financial engine's
 * input: `loadAnchors` rolls the balance sheet forward from the first, and the
 * chart of accounts is regenerated from both. Nothing in the gateway wrote
 * either table — they were filled by the legacy extraction pipeline alone,
 * which is why this route is the one that mattered.
 *
 * WHAT REPLACED THE PYTHON
 * ------------------------
 * The pipeline this supersedes shelled out to `backend/python` to turn a PDF
 * into text before anything read it: 2,248 lines of PDF text extraction, OCR,
 * and a detector choosing between the two. None of that is needed here — the
 * model reads the PDF itself, so the choice between text-extraction and OCR
 * never arises, and a spreadsheet is `xlsx`'s job in the GL importer.
 *
 * WHAT IS CLEARED AND WHAT IS NOT
 * -------------------------------
 * Rows this system GENERATED are cleared before a run — a carry-forward has to
 * be recomputed from freshly extracted figures or it compounds whatever
 * produced it. Rows extracted from a document are replaced per document, so a
 * re-sync of one file does not empty the others. Legacy did the same thing,
 * and it is the only part of its shape worth keeping.
 */

/** Which entry table a linked document's category feeds. */
const KIND_OF_CATEGORY: Readonly<Record<string, "balance_sheet" | "profit_and_loss">> = {
  balance_sheet: "balance_sheet",
  profit_loss: "profit_and_loss",
};

export interface StatementEntryWriter {
  /** Remove the rows this system derived, so a carry-forward is recomputed. */
  clearGenerated(versionId: string): Promise<number>;
  /** Replace one document's rows, leaving every other document's alone. */
  replaceForDocument(input: {
    versionId: string;
    companyId: string;
    documentId: string;
    kind: "balance_sheet" | "profit_and_loss";
    fiscalYear: number;
    asOfDate: string | null;
    rows: readonly StatementEntryRow[];
  }): Promise<number>;
}

export interface SyncLogWriter {
  start(input: { versionId: string; companyId: string; createdBy: string | null }): Promise<number>;
  finish(
    id: number,
    input: { status: "success" | "failed"; errorMessage?: string | null; metadata: Record<string, unknown> },
  ): Promise<void>;
}

export interface KeyReportSyncDeps {
  versions: ReportsRepository;
  statements: StatementsRepository;
  entries: StatementEntryWriter;
  logs: SyncLogWriter;
  bytes: DocumentBytesPort;
  reader: DocumentReader;
}

export interface SyncedFile {
  documentId: string;
  fileName: string | null;
  kind: "balance_sheet" | "profit_and_loss";
  fiscalYear: number;
  rows: number;
}

export interface FailedFile {
  documentId: string;
  fileName: string | null;
  reason: string;
}

export interface KeyReportSyncResult {
  versionId: string;
  processed: SyncedFile[];
  failed: FailedFile[];
  /** Documents linked under a category no entry table takes. */
  skipped: number;
  years: number[];
  totalRowsInserted: number;
}

export class KeyReportSyncService {
  constructor(private readonly deps: KeyReportSyncDeps) {}

  /**
   * Read every statement this version links, into the entry tables.
   *
   * One file failing does not fail the run: a company with one unreadable
   * balance sheet should still get the rest of its statements, and what failed
   * is named rather than swallowed. A run where NOTHING could be read is a
   * failure, whatever the per-file detail says.
   */
  async sync(user: SessionUser, versionId: string, now = new Date()): Promise<KeyReportSyncResult> {
    if (!versionId) throw new BadRequestError("Missing versionId.");

    const version = await this.deps.versions.getById(versionId);
    if (!version) throw new NotFoundError("Version not found.");

    const logId = await this.deps.logs.start({
      versionId,
      companyId: version.companyId,
      createdBy: user.id,
    });

    try {
      // Generated rows first: the carry-forward they represent has to be
      // recomputed from freshly extracted figures rather than compounded.
      await this.deps.entries.clearGenerated(versionId);

      const linked = await this.deps.statements.linkedDocuments(version.companyId, { versionId });
      const processed: SyncedFile[] = [];
      const failed: FailedFile[] = [];
      let skipped = 0;
      const years = new Set<number>();
      let totalRowsInserted = 0;

      for (const document of linked) {
        const kind = KIND_OF_CATEGORY[document.category];
        if (!kind) {
          // A tax return or a bank statement. Those are read by their own
          // modules into `statement_extracts`; duplicating them here would be
          // two stores disagreeing about one file.
          skipped += 1;
          continue;
        }

        try {
          const read = await this.readOne(version.companyId, versionId, document, kind, now);
          processed.push(read);
          years.add(read.fiscalYear);
          totalRowsInserted += read.rows;
        } catch (error) {
          failed.push({
            documentId: document.documentId,
            fileName: document.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const result: KeyReportSyncResult = {
        versionId,
        processed,
        failed,
        skipped,
        years: [...years].sort((a, b) => a - b),
        totalRowsInserted,
      };

      if (processed.length === 0 && failed.length > 0) {
        // Nothing landed. Marking the version synced would leave the page
        // saying the figures are current when no figure was written.
        await this.deps.logs.finish(logId, {
          status: "failed",
          errorMessage: `No statement could be read (${failed.length} failed).`,
          metadata: { ...result },
        });
        return result;
      }

      await this.deps.versions.update(versionId, { status: "synced" });
      await this.deps.logs.finish(logId, { status: "success", metadata: { ...result } });
      return result;
    } catch (error) {
      // Whatever went wrong, the log is closed rather than left "started" —
      // an open row reads as a sync still running, forever.
      await this.deps.logs.finish(logId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        metadata: {},
      });
      throw error;
    }
  }

  /** Read one document, and replace that document's rows. */
  private async readOne(
    companyId: string,
    versionId: string,
    document: LinkedDocument,
    kind: "balance_sheet" | "profit_and_loss",
    now: Date,
  ): Promise<SyncedFile> {
    const file = await this.deps.bytes.bytesFor(document.documentId);
    if (!file) {
      throw new NotFoundError(
        `No file is stored against "${document.name ?? document.documentId}".`,
      );
    }

    const parsed = await this.deps.reader.askForJson({
      prompt: STATEMENT_PROMPT,
      document: { mimeType: file.mimeType, data: file.bytes.toString("base64") },
    });

    const rows = flattenStatement(toStatementRows(parsed), { kind });
    if (rows.length === 0) {
      // An empty statement written to the entry tables takes the year's place
      // in every report derived from them, and reports every figure as zero.
      throw new BadRequestError(
        `Nothing could be read out of "${document.name ?? document.documentId}".`,
      );
    }

    const dates = parsed as { asOfDate?: unknown; periodStart?: unknown; periodEnd?: unknown };
    const asOfDate = toDate(dates.asOfDate);
    const periodEnd = toDate(dates.periodEnd);
    const fiscalYear = statementYear(
      { asOfDate, periodEnd, periodStart: toDate(dates.periodStart) },
      document.name,
      now.getUTCFullYear(),
    );

    const written = await this.deps.entries.replaceForDocument({
      versionId,
      companyId,
      documentId: document.documentId,
      kind,
      fiscalYear,
      // A balance sheet states a position and needs a date to be rolled from.
      // Its own `asOfDate` where it gave one, its period end otherwise, and
      // the year end as a last resort — a position with no date anchors
      // nothing.
      asOfDate: asOfDate ?? periodEnd ?? `${fiscalYear}-12-31`,
      rows,
    });

    return {
      documentId: document.documentId,
      fileName: document.name,
      kind,
      fiscalYear,
      rows: written,
    };
  }
}
