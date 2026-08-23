import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  CATEGORY_OF_STATEMENT,
  STATEMENT_TYPES,
  type SourceTreeEntry,
  type StatementExtract,
  type StatementType,
  type StatementsRepository,
} from "./ports.js";

export interface StatementsServiceDeps {
  repo: StatementsRepository;
}

export function isStatementType(value: string): value is StatementType {
  return (STATEMENT_TYPES as readonly string[]).includes(value);
}

/** How the caller narrowed "which balance sheet did you mean?". */
export interface ResolveOptions {
  sourceKey?: string;
  /** An exact extract, when the caller already picked one from the list. */
  extractId?: string;
  /**
   * Resolve through a key-report version's linked documents instead of taking
   * whatever is newest for the company.
   */
  keyReportVersionId?: string;
}

export class StatementsService {
  constructor(private readonly deps: StatementsServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  private requireType(statementType: string): StatementType {
    if (!isStatementType(statementType)) {
      throw new BadRequestError(
        `Invalid statementType: ${statementType}. ` +
          `Expected one of ${STATEMENT_TYPES.join(", ")}.`,
      );
    }
    return statementType;
  }

  async list(
    user: SessionUser,
    companyId: string,
    statementType: string,
    filter: { sourceKey?: string; fiscalYear?: number } = {},
  ): Promise<StatementExtract[]> {
    this.requireCompany(user, companyId);
    return this.deps.repo.list(companyId, {
      statementType: this.requireType(statementType),
      ...(filter.sourceKey ? { sourceKey: filter.sourceKey } : {}),
      ...(filter.fiscalYear !== undefined ? { fiscalYear: filter.fiscalYear } : {}),
    });
  }

  /**
   * The statement a caller means, in the order they meant it.
   *
   * 1. An explicit extract id — they picked one from the list.
   * 2. The document a key-report version files under that category — "the
   *    balance sheet for THIS version", not "the latest one lying around".
   * 3. The most recent extract for the company.
   *
   * The middle rung is the one that matters. Without it, opening a
   * six-month-old report version shows whatever was uploaded last week, which
   * is a different company's-worth of numbers than the version was signed off
   * against — and nothing on screen says so.
   */
  async resolve(
    user: SessionUser,
    companyId: string,
    statementType: string,
    options: ResolveOptions = {},
  ): Promise<StatementExtract> {
    this.requireCompany(user, companyId);
    const type = this.requireType(statementType);

    if (options.extractId) {
      const chosen = await this.deps.repo.getById(companyId, options.extractId);
      if (!chosen) throw new NotFoundError("No statement found for that id.");
      // Asking for a balance sheet by an id that turns out to be a P&L is a
      // caller bug, and quietly returning the P&L would hide it.
      if (chosen.statementType !== type) {
        throw new BadRequestError(
          `That statement is a ${chosen.statementType}, not a ${type}.`,
        );
      }
      return chosen;
    }

    if (options.keyReportVersionId) {
      const category = CATEGORY_OF_STATEMENT[type];
      if (category) {
        const documentIds = await this.deps.repo.documentsForVersion(
          options.keyReportVersionId,
          category,
        );
        for (const documentId of documentIds) {
          const found = await this.deps.repo.forDocument(companyId, documentId, type);
          if (found) return found;
        }
      }
      // Falling through to the company-wide latest is deliberate: a version
      // with nothing linked yet should still show something, and the caller
      // can see which document it came from.
    }

    const latest = await this.deps.repo.latest(companyId, type, {
      ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
    });
    if (!latest) throw new NotFoundError("No statement has been extracted for this company.");
    return latest;
  }

  async sourceTree(
    user: SessionUser,
    companyId: string,
    filter: { sourceKey?: string } = {},
  ): Promise<SourceTreeEntry[]> {
    this.requireCompany(user, companyId);
    return this.deps.repo.sourceTree(companyId, filter);
  }

  /**
   * Record what extraction read out of a document.
   *
   * The fiscal year is taken from the period end when the caller did not say —
   * a statement's year is the year it closes in, not the year it opens in, and
   * a December-to-January span filed under the opening year sorts a whole year
   * out of place.
   */
  async save(
    user: SessionUser,
    companyId: string,
    input: {
      documentId: string;
      statementType: string;
      uploadId?: string | null;
      sourceKey?: string;
      periodStart?: string | null;
      periodEnd?: string | null;
      asOfDate?: string | null;
      fiscalYear?: number | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<StatementExtract> {
    this.requireCompany(user, companyId);
    const type = this.requireType(input.statementType);
    if (!input.documentId) throw new BadRequestError("Missing documentId.");

    const periodEnd = input.periodEnd ?? null;
    const asOfDate = input.asOfDate ?? null;
    const yearFrom = (value: string | null): number | null => {
      const year = Number.parseInt(String(value ?? "").slice(0, 4), 10);
      return Number.isInteger(year) && year > 1900 && year < 3000 ? year : null;
    };

    return this.deps.repo.save({
      companyId,
      documentId: input.documentId,
      statementType: type,
      uploadId: input.uploadId ?? null,
      sourceKey: input.sourceKey || "manual_upload_excel_pdf",
      periodStart: input.periodStart ?? null,
      periodEnd,
      asOfDate,
      fiscalYear: input.fiscalYear ?? yearFrom(periodEnd) ?? yearFrom(asOfDate),
      payload: input.payload ?? {},
      extractedBy: user.id,
    });
  }

  async delete(user: SessionUser, companyId: string, id: string): Promise<void> {
    this.requireCompany(user, companyId);
    const deleted = await this.deps.repo.delete(companyId, id);
    if (!deleted) throw new NotFoundError("No statement found for that id.");
  }
}
