import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  detectMapping,
  emptyMapping,
  type ColumnMapping,
  type MappingResult,
} from "./column-mapping.js";
import { applyMapping, parseSheet, SheetParseError, type ImportedRow } from "./sheet.js";
import type { GlImportRepository, StoredMapping } from "./ports.js";

export interface GlImportServiceDeps {
  repo: GlImportRepository;
}

/** What the mapping screen renders. */
export interface ColumnsView {
  uploadId: string;
  fileName: string;
  columns: string[];
  sheetName: string;
  sheetNames: string[];
  /** A handful of rows, so somebody can see what they are mapping. */
  sample: Array<Record<string, unknown>>;
  rowCount: number;
  mapping: ColumnMapping;
  confidence: MappingResult["confidence"];
  sources: MappingResult["sources"];
  missingRequired: string[];
  lowConfidenceFields: string[];
  canAutoProcess: boolean;
  /** True when this mapping was confirmed by a person, not detected. */
  confirmed: boolean;
}

/** How many sample rows to send. Enough to recognise the file, not to ship it. */
const SAMPLE_ROWS = 10;

export class GlImportService {
  constructor(private readonly deps: GlImportServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /**
   * Read an uploaded ledger's columns, with a mapping to start from.
   *
   * A mapping somebody already confirmed wins over detection — they were
   * looking at the file, and re-detecting would quietly discard their
   * correction every time the screen reloaded.
   */
  async columns(
    user: SessionUser,
    companyId: string,
    uploadId: string,
  ): Promise<ColumnsView> {
    this.requireCompany(user, companyId);
    if (!uploadId) throw new BadRequestError("uploadId is required.");

    // Ownership BEFORE the bytes. Parsing another tenant's upload and handing
    // back its columns and sample rows is a disclosure, not a mis-fetch.
    if (!(await this.deps.repo.uploadBelongsToCompany(companyId, uploadId))) {
      throw new NotFoundError("No such upload for this company.");
    }

    const upload = await this.deps.repo.getUpload(uploadId);
    if (!upload) throw new NotFoundError("No such upload for this company.");

    const stored = await this.deps.repo.getMapping(companyId, uploadId);
    const parsed = parseSheet({
      data: upload.data,
      fileName: upload.fileName,
      contentType: upload.contentType,
    });

    const detected = detectMapping({
      columns: parsed.columns,
      rows: parsed.rows,
      ...(stored ? { mapping: stored.mapping } : {}),
    });

    return {
      uploadId,
      fileName: upload.fileName,
      columns: parsed.columns,
      sheetName: parsed.sheetName,
      sheetNames: parsed.sheetNames,
      sample: parsed.rows.slice(0, SAMPLE_ROWS),
      rowCount: parsed.rows.length,
      mapping: detected.mapping,
      confidence: detected.confidence,
      sources: detected.sources,
      missingRequired: detected.missingRequired,
      lowConfidenceFields: detected.lowConfidenceFields,
      canAutoProcess: detected.canAutoProcess,
      confirmed: Boolean(stored?.confirmedAt),
    };
  }

  /**
   * Record the mapping somebody confirmed.
   *
   * Refused when it names a column the file does not have: a mapping that
   * points at nothing imports a column of blanks, which is a ledger of zeroes
   * rather than an error anybody sees.
   */
  async saveMapping(
    user: SessionUser,
    companyId: string,
    input: { uploadId: string; mapping: Partial<ColumnMapping> },
  ): Promise<StoredMapping> {
    this.requireCompany(user, companyId);
    if (!input.uploadId) throw new BadRequestError("uploadId is required.");

    if (!(await this.deps.repo.uploadBelongsToCompany(companyId, input.uploadId))) {
      throw new NotFoundError("No such upload for this company.");
    }
    const upload = await this.deps.repo.getUpload(input.uploadId);
    if (!upload) throw new NotFoundError("No such upload for this company.");

    const parsed = parseSheet({
      data: upload.data,
      fileName: upload.fileName,
      contentType: upload.contentType,
    });

    const mapping = emptyMapping(input.mapping);
    const unknown = Object.entries(mapping)
      .filter(([, column]) => column && !parsed.columns.includes(column))
      .map(([field, column]) => `${field} → "${column}"`);
    if (unknown.length > 0) {
      throw new BadRequestError(
        `That mapping names columns "${upload.fileName}" does not have: ${unknown.join(", ")}.`,
      );
    }

    const detected = detectMapping({ columns: parsed.columns, rows: parsed.rows });
    // Only what is worth keeping: the whole result carries a profile per
    // column, which is diagnostics rather than a record of a decision.
    return this.deps.repo.saveMapping({
      companyId,
      uploadId: input.uploadId,
      mapping,
      detected: {
        mapping: detected.mapping,
        confidence: detected.confidence,
        sources: detected.sources,
      },
      confirmedBy: user.id,
    });
  }

  /**
   * Read the rows an upload would import, under its confirmed mapping.
   *
   * Refuses rather than importing when required fields are missing: an import
   * that runs on a broken mapping produces a ledger nobody can tell apart from
   * a correct one until it fails to balance.
   */
  async preview(
    user: SessionUser,
    companyId: string,
    uploadId: string,
  ): Promise<{
    fileName: string;
    mapping: ColumnMapping;
    rows: ImportedRow[];
    skipped: { noAccount: number; noAmount: number; noDate: number };
  }> {
    this.requireCompany(user, companyId);
    const view = await this.columns(user, companyId, uploadId);

    if (view.missingRequired.length > 0) {
      throw new BadRequestError(
        `"${view.fileName}" cannot be imported yet: ${view.missingRequired.join(", ")} ` +
          `${view.missingRequired.length === 1 ? "is" : "are"} not mapped.`,
      );
    }

    const upload = await this.deps.repo.getUpload(uploadId);
    if (!upload) throw new NotFoundError("No such upload for this company.");
    const parsed = parseSheet({
      data: upload.data,
      fileName: upload.fileName,
      contentType: upload.contentType,
    });

    const { rows, skipped } = applyMapping(parsed.rows, view.mapping);
    return { fileName: upload.fileName, mapping: view.mapping, rows, skipped };
  }
}

export { SheetParseError };
