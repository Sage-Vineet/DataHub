import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  CATEGORY_OF_STATEMENT,
  STATEMENT_TYPES,
  type LatestFilter,
  type SourceTreeEntry,
  type StatementExtract,
  type Provenance,
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

  /**
   * Every statement of a type, newest first — the "which one did you mean"
   * picker behind the Reports page's file selector.
   *
   * `keyReportVersionId` narrows to what a version actually links, and it
   * narrows rather than orders: a version that links two documents offers two
   * files to choose between, and one that links none offers none. Returning
   * the company's whole history there would put files the version was never
   * signed off against in a dropdown that claims to be the version's.
   *
   * This is the same question `resolve` answers for a single statement, and it
   * has to agree with it — a picker whose options exclude the statement the
   * page is showing is worse than no picker.
   */
  async list(
    user: SessionUser,
    companyId: string,
    statementType: string,
    filter: { sourceKey?: string; fiscalYear?: number; keyReportVersionId?: string } = {},
  ): Promise<StatementExtract[]> {
    this.requireCompany(user, companyId);
    const type = this.requireType(statementType);

    let documentIds: readonly string[] | undefined;
    if (filter.keyReportVersionId) {
      const category = CATEGORY_OF_STATEMENT[type];
      // A type nothing is ever filed under — cash flow, which is derived
      // rather than uploaded — cannot be narrowed by a version, so it is not.
      documentIds = category
        ? await this.deps.repo.documentsForVersion(filter.keyReportVersionId, category)
        : undefined;
    }

    return this.deps.repo.list(companyId, {
      statementType: type,
      ...(filter.sourceKey ? { sourceKey: filter.sourceKey } : {}),
      ...(filter.fiscalYear !== undefined ? { fiscalYear: filter.fiscalYear } : {}),
      ...(documentIds ? { documentIds } : {}),
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

  /**
   * The most recent statement of a type, or null.
   *
   * Separate from `resolve` because the callers differ in what an absence
   * means. `resolve` is asked for a statement somebody expects to exist and
   * 404s; this is asked "is there one?" and null is a perfectly good answer.
   */
  async latestOrNull(
    user: SessionUser,
    companyId: string,
    statementType: string,
    filter: LatestFilter = {},
  ): Promise<StatementExtract | null> {
    this.requireCompany(user, companyId);
    return this.deps.repo.latest(companyId, this.requireType(statementType), filter);
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
      /** Where it came from. One of a file, or the run that pulled it. */
      provenance: Provenance;
      statementType: string;
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
    if (input.provenance.from === "document" && !input.provenance.documentId) {
      throw new BadRequestError("Missing documentId.");
    }
    if (
      input.provenance.from === "pull" &&
      input.provenance.syncRunId !== undefined &&
      input.provenance.syncRunId !== null &&
      input.provenance.syncRunId === ""
    ) {
      // An empty string is a caller that meant to name a run and lost the id
      // somewhere. `undefined` is different and legitimate: a report fetched
      // on demand has no run behind it, and its origin is named by the pull
      // key, the report params and who asked. See migration 0015.
      throw new BadRequestError("Missing syncRunId.");
    }

    const periodEnd = input.periodEnd ?? null;
    const asOfDate = input.asOfDate ?? null;
    const yearFrom = (value: string | null): number | null => {
      const year = Number.parseInt(String(value ?? "").slice(0, 4), 10);
      return Number.isInteger(year) && year > 1900 && year < 3000 ? year : null;
    };

    return this.deps.repo.save({
      companyId,
      provenance: input.provenance,
      statementType: type,
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
