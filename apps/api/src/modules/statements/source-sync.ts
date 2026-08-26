import type { SessionUser } from "@datahub/contracts";
import { statementYear, type StatementNode } from "@datahub/financial-engine";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { DocumentReader } from "../../shared/gemini.js";
import type { FinishInput, ProgressPatch, SyncRunRecord } from "../sync/ports.js";
import {
  CATEGORY_OF_STATEMENT,
  STATEMENT_TYPES,
  type LinkedDocument,
  type StatementType,
  type StatementsRepository,
} from "./ports.js";
import type { DocumentBytesPort } from "./tax-return.js";

/**
 * Reading a source's uploaded files into statements.
 *
 * This is the WRITER behind the manual-upload pages. `/reports/:type/latest`,
 * the dashboards and the derived cash flow all read `statement_extracts`; until
 * something puts rows there, a company that has uploaded a year of statements
 * sees an empty product and no explanation.
 *
 * WHY THIS IS NOT A PORT
 * ----------------------
 * The version this replaces wrote to `qb_synced_reports`, which does not exist
 * in the database. Its first act was to DELETE from that table, so the sync
 * failed on its first statement for every company, every time. There is no
 * behaviour to preserve, so what follows is built against what the pages
 * actually read rather than against what the old code did.
 *
 * Three things it does differently on purpose:
 *
 * CLEARING FIRST IS NOT THE DEFAULT. Legacy deleted every row for the source
 * before reading anything. A sync that then failed halfway left the company
 * with LESS than it had before somebody pressed the button, and there was no
 * way back short of running it again and hoping. Extraction is per document
 * here, so a failure leaves what was already there.
 *
 * A DOCUMENT ALREADY READ IS NOT READ AGAIN. Every file went through the model
 * on every sync, at cost, whether or not it had changed. A document's
 * extraction does not change unless the document does, so it is skipped unless
 * the caller asks for a refresh.
 *
 * PROGRESS LIVES IN THE DATABASE. Legacy kept it in `_setManualUploadProgress`,
 * a module-level map — so two gateway instances each had their own idea of how
 * far along the sync was, and a restart lost it entirely while the work was
 * half done. It is a `sync_runs` row here, which is what `/sync-status`
 * already reads.
 */

/** What the model is asked for, and what a saved extract holds. */
export const STATEMENT_PROMPT = `You are reading a financial statement.

Return ONLY a raw JSON object. No markdown, no backticks, no commentary:

{
  "asOfDate": "YYYY-MM-DD or null",
  "periodStart": "YYYY-MM-DD or null",
  "periodEnd": "YYYY-MM-DD or null",
  "rows": [
    { "name": "Total Revenue", "amount": 1234.56, "type": "revenue",
      "children": [ { "name": "Product Sales", "amount": 1000, "type": "revenue" } ] }
  ]
}

Rules:
- Keep the statement's own structure: a section's lines are its "children".
- "amount" is a plain number. No currency symbols, no thousands separators, no
  parentheses — write a negative as a negative number.
- Include section totals as rows with children, not as separate sibling rows.
  A total listed alongside the lines it totals double counts the section.
- "type" is the account category where the statement says so, else null.
- A balance sheet states a position: set "asOfDate" and leave the period null.
  A profit and loss covers a period: set "periodStart" and "periodEnd".
- Return { "rows": [] } if the document is not a financial statement.`;

/** How the extract's payload is shaped, so every reader agrees. */
export interface StatementPayload {
  rows: StatementNode[];
}

export interface SyncedFile {
  documentId: string;
  fileName: string | null;
  statementType: StatementType;
  extractId: string;
  fiscalYear: number | null;
}

export interface FailedFile {
  documentId: string;
  fileName: string | null;
  reason: string;
}

export interface SourceSyncResult {
  runId: string;
  processed: SyncedFile[];
  failed: FailedFile[];
  /** Documents already read, which this sync did not pay to read again. */
  skipped: number;
}

/** The part of the sync service this uses. See `quickbooks/reports/sync.ts`. */
export interface SyncRunner {
  start(
    user: SessionUser,
    companyId: string,
    input: { sourceKey: string; kind?: string; totalFiles?: number },
    now?: Date,
  ): Promise<SyncRunRecord>;
  advance(user: SessionUser, companyId: string, runId: string, patch: ProgressPatch): Promise<void>;
  finish(user: SessionUser, companyId: string, runId: string, input: FinishInput): Promise<void>;
}

export interface SourceSyncDeps {
  statements: StatementsRepository;
  bytes: DocumentBytesPort;
  reader: DocumentReader;
  runs: SyncRunner;
}

/** Which statement type a document filed under a category holds. */
export function statementTypeOfCategory(category: string): StatementType | null {
  for (const type of STATEMENT_TYPES) {
    if (CATEGORY_OF_STATEMENT[type] === category) return type;
  }
  return null;
}

/** The tree the model returned, or an empty one. */
export function toStatementRows(parsed: unknown): StatementNode[] {
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as StatementNode[]) : [];
}

/** A date the model wrote, or null for anything unreadable. */
export function toDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export class SourceSyncService {
  constructor(private readonly deps: SourceSyncDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /**
   * Read every document this source has, into statements.
   *
   * The documents come from the key-report file mappings — the link that
   * already records which uploaded file is the balance sheet and which is the
   * P&L. Legacy read the folder tree and inferred the type from folder names,
   * which meant renaming a folder silently stopped its contents being read.
   */
  async syncSource(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
    options: { versionId?: string; force?: boolean } = {},
    now = new Date(),
  ): Promise<SourceSyncResult> {
    this.requireCompany(user, companyId);
    if (!sourceKey) throw new BadRequestError("Missing sourceKey.");

    const linked = await this.deps.statements.linkedDocuments(companyId, {
      ...(options.versionId ? { versionId: options.versionId } : {}),
    });
    const readable = linked.filter((document) => statementTypeOfCategory(document.category));

    const run = await this.deps.runs.start(
      user,
      companyId,
      { sourceKey, kind: "documents", totalFiles: readable.length },
      now,
    );

    return this.readAll(user, companyId, sourceKey, run.id, readable, options.force ?? false);
  }

  /**
   * Read a named set of documents, and nothing else.
   *
   * The "Choose Folder" flow: somebody picked files and pressed parse. It
   * never re-scans everything, because on a company with fifty statements
   * that is fifty model calls to read the two that were just uploaded.
   */
  async parseDocuments(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
    documents: ReadonlyArray<{ documentId?: unknown; statementType?: unknown }>,
    options: { clearFirst?: boolean } = {},
    now = new Date(),
  ): Promise<SourceSyncResult> {
    this.requireCompany(user, companyId);
    if (!sourceKey) throw new BadRequestError("Missing sourceKey.");
    if (documents.length === 0) {
      throw new BadRequestError("documents array is required.");
    }

    const wanted: LinkedDocument[] = [];
    for (const entry of documents) {
      const documentId = String(entry.documentId ?? "").trim();
      if (!documentId) throw new BadRequestError("Every document needs a documentId.");

      const statementType = String(entry.statementType ?? "").trim();
      const type = (STATEMENT_TYPES as readonly string[]).includes(statementType)
        ? (statementType as StatementType)
        : statementTypeOfCategory(statementType);
      // Refused rather than guessed. A statement stored under the wrong type
      // is served to the page that asks for that type, and its figures are
      // wrong in a way nothing on screen can show.
      if (!type) {
        throw new BadRequestError(`"${statementType}" is not a statement type.`);
      }

      const category = CATEGORY_OF_STATEMENT[type];
      if (!category) {
        throw new BadRequestError(`Nothing is ever filed under ${type}.`);
      }
      wanted.push({ documentId, name: null, folderName: null, category });
    }

    const run = await this.deps.runs.start(
      user,
      companyId,
      { sourceKey, kind: "documents", totalFiles: wanted.length },
      now,
    );

    if (options.clearFirst) {
      // Scoped to the SOURCE, not the company. Legacy cleared everything the
      // company had before parsing two files, so a targeted parse could empty
      // a year of statements it was never asked to touch.
      await this.deps.statements.deleteForSource(companyId, sourceKey);
    }

    // `force`, because a caller who explicitly named these documents is asking
    // for them to be read, not for a report on what was already read.
    return this.readAll(user, companyId, sourceKey, run.id, wanted, true);
  }

  /** Read each document in turn, advancing the run as it goes. */
  private async readAll(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
    runId: string,
    documents: readonly LinkedDocument[],
    force: boolean,
  ): Promise<SourceSyncResult> {
    const processed: SyncedFile[] = [];
    const failed: FailedFile[] = [];
    let skipped = 0;

    try {
      for (const [index, document] of documents.entries()) {
        const type = statementTypeOfCategory(document.category)!;
        await this.deps.runs.advance(user, companyId, runId, {
          processedFiles: index,
          currentFile: document.name ?? document.documentId,
          currentStep: `Reading ${type}`,
        });

        try {
          const existing = force
            ? null
            : await this.deps.statements.forDocument(companyId, document.documentId, type);
          if (existing) {
            skipped += 1;
            continue;
          }
          processed.push(await this.readOne(user, companyId, sourceKey, document, type));
        } catch (error) {
          // One unreadable file does not fail the sync: eleven readable
          // statements should still reach the page. What failed is named.
          failed.push({
            documentId: document.documentId,
            fileName: document.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Inside the try, so a store that fails HERE still closes the run. A row
      // nobody finishes reads as a live sync for five minutes and a stalled
      // one forever, and the company cannot start another until it is reaped.
      await this.deps.runs.advance(user, companyId, runId, {
        processedFiles: documents.length,
        currentFile: null,
        currentStep: "done",
      });
    } catch (error) {
      await this.deps.runs.finish(user, companyId, runId, {
        status: "failed",
        result: { processed: processed.length, failed: failed.length, skipped },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    await this.deps.runs.finish(user, companyId, runId, {
      // Files that failed do not fail the run — but a run where NOTHING could
      // be read is a failure, whatever the per-file detail says.
      status: failed.length > 0 && processed.length === 0 && skipped === 0 ? "failed" : "completed",
      result: { processed: processed.length, failed: failed.length, skipped },
      ...(failed.length > 0 && processed.length === 0 && skipped === 0
        ? { errorMessage: `No document could be read (${failed.length} failed).` }
        : {}),
    });

    return { runId, processed, failed, skipped };
  }

  /** Read one document into one extract. */
  private async readOne(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
    document: LinkedDocument,
    type: StatementType,
  ): Promise<SyncedFile> {
    const file = await this.deps.bytes.bytesFor(document.documentId);
    if (!file) {
      throw new NotFoundError(`No file is stored against "${document.name ?? document.documentId}".`);
    }

    const parsed = await this.deps.reader.askForJson({
      prompt: STATEMENT_PROMPT,
      document: { mimeType: file.mimeType, data: file.bytes.toString("base64") },
    });

    const rows = toStatementRows(parsed);
    // An empty tree is not a statement. Saved, it would take the year's slot on
    // the dashboard and report every figure as zero — worse than the warning
    // that says the year has no balance sheet.
    if (rows.length === 0) {
      throw new BadRequestError(
        `Nothing could be read out of "${document.name ?? document.documentId}".`,
      );
    }

    const dates = parsed as { asOfDate?: unknown; periodStart?: unknown; periodEnd?: unknown };
    const asOfDate = toDate(dates.asOfDate);
    const periodStart = toDate(dates.periodStart);
    const periodEnd = toDate(dates.periodEnd);

    const saved = await this.deps.statements.save({
      companyId,
      provenance: { from: "document", documentId: document.documentId },
      statementType: type,
      sourceKey,
      periodStart,
      periodEnd,
      asOfDate,
      // Read from the statement's own dates where it has them and from the
      // file name otherwise. A statement filed under the wrong year sits on
      // the wrong dashboard card, and every figure on it is plausible.
      fiscalYear: statementYear(
        { asOfDate, periodStart, periodEnd },
        document.name,
        new Date().getUTCFullYear(),
      ),
      payload: { rows } satisfies StatementPayload,
      extractedBy: user.id,
    });

    return {
      documentId: document.documentId,
      fileName: document.name,
      statementType: type,
      extractId: saved.id,
      fiscalYear: saved.fiscalYear,
    };
  }
}
