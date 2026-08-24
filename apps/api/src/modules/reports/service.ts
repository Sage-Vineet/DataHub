import type {
  ReportVersionCreate,
  ReportVersionResponse,
  ReportVersionUpdate,
  SessionUser,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import type {
  ExtractedDataPage,
  ExtractedDataQuery,
  ExtractedDataReader,
} from "./extracted-data.js";
import { inferMappingYear } from "./mapping-year.js";
import {
  REPORT_CATEGORIES,
  type MappingRecord,
  type MappingsRepository,
  type PreferencesRepository,
  type ReportCategory,
  type SyncLogRecord,
  type SyncLogsRepository,
} from "./ports.js";
import type {
  EngagementPort,
  LedgerDetailPort,
  ReportSyncPort,
  ReportsRepository,
  VersionRecord,
} from "./ports.js";
import { buildStatements, type BuildStatementsOptions, type FinancialStatements } from "./statements.js";
import {
  buildProfitLossSummary,
  type ProfitLossFilters,
  type ProfitLossSummaryPayload,
} from "./profit-loss-view.js";
import {
  buildFilterOptions,
  type FilterOptionsPayload,
} from "./filter-options-view.js";
import {
  validateBalanceSheet,
  type ValidationPayload,
} from "./balance-sheet-validation.js";
import {
  buildVendorDetail,
  type VendorDetailFilters,
  type VendorDetailPayload,
} from "./vendor-detail-view.js";
import {
  buildCashFlowMonthlyDetail,
  type CashFlowMonthlyFilters,
  type CashFlowMonthlyPayload,
} from "./cash-flow-monthly-view.js";
import {
  buildBalanceSheetMonthlyDetail,
  type BalanceSheetMonthlyFilters,
  type BalanceSheetMonthlyPayload,
} from "./balance-sheet-monthly-view.js";
import {
  buildMonthlyDetail,
  type MonthlyDetailFilters,
  type MonthlyDetailPayload,
} from "./monthly-detail-view.js";
import {
  buildCashFlowReport,
  type CashFlowFilters,
  type CashFlowPayload,
} from "./cash-flow-view.js";
import {
  buildBalanceSheet,
  NoBalanceSheetError,
  type BalanceSheetFilters,
  type BalanceSheetPayload,
} from "./balance-sheet-view.js";

/** The preference key legacy wrote, kept so an existing dismissal still counts. */
const POPUP_PREF_KEY = "key_reports_popup_dismissed";

export interface ReportsServiceDeps {
  repo: ReportsRepository;
  sync: ReportSyncPort;
  engagement: EngagementPort;
  ledger: LedgerDetailPort;
  mappings: MappingsRepository;
  syncLogs: SyncLogsRepository;
  preferences: PreferencesRepository;
  /**
   * The raw rows extraction stored, read a page at a time.
   *
   * Optional because it needs a database and every other dependency here is a
   * port with an in-memory double — the service is constructed without it in
   * unit tests, and the route that uses it says so rather than failing at a
   * null.
   */
  extractedData?: ExtractedDataReader;
}

export class ReportsService {
  private readonly repo: ReportsRepository;
  private readonly syncPort: ReportSyncPort;
  private readonly engagement: EngagementPort;
  private readonly ledger: LedgerDetailPort;
  private readonly mappings: MappingsRepository;
  private readonly syncLogs: SyncLogsRepository;
  private readonly preferences: PreferencesRepository;
  private readonly extracted: ExtractedDataReader | undefined;
  constructor(deps: ReportsServiceDeps) {
    this.repo = deps.repo;
    this.syncPort = deps.sync;
    this.engagement = deps.engagement;
    this.ledger = deps.ledger;
    this.mappings = deps.mappings;
    this.syncLogs = deps.syncLogs;
    this.preferences = deps.preferences;
    this.extracted = deps.extractedData;
  }

  /**
   * The balance sheet and cash flow for a version, derived from the ledger.
   *
   * Every figure comes from `@datahub/financial-engine`, so the statements
   * agree with each other by construction — the cash flow is a function of the
   * balance sheet rather than a third pass over the ledger that can disagree
   * with it.
   */
  async financialStatements(
    user: SessionUser,
    versionId: string,
    options: BuildStatementsOptions = {},
  ): Promise<FinancialStatements> {
    await this.requireAccessible(user, versionId);

    const engagement = await this.engagement.load(versionId);
    if (!engagement) throw new NotFoundError("Report version not found.");

    return buildStatements(engagement, options);
  }

  /**
   * The Profit & Loss the Reports page reads, for a company rather than a
   * version.
   *
   * Legacy resolved this endpoint from `X-Client-Id` and served it from
   * `manual_gl_staged_transactions`; the version was implicit in whichever
   * batch happened to be active. Here the company's active key-report version
   * supplies the engagement, so the statement is tied to a version a user can
   * see and switch — and a company with no active version gets a plain 404
   * rather than a P&L assembled from nothing.
   */
  async profitLoss(
    user: SessionUser,
    companyId: string,
    filters: ProfitLossFilters = {},
  ): Promise<ProfitLossSummaryPayload> {
    return buildProfitLossSummary(await this.activeEngagement(user, companyId), filters);
  }

  /**
   * The Balance Sheet, company-scoped like the P&L.
   *
   * An engagement with no ingested balance sheet is a 422 rather than an empty
   * statement: a roll-forward with nothing to roll from produces a sheet that
   * balances perfectly and is wrong in every figure, and the page needs to be
   * able to tell that apart from a company that genuinely has no activity.
   */
  async balanceSheet(
    user: SessionUser,
    companyId: string,
    filters: BalanceSheetFilters = {},
  ): Promise<BalanceSheetPayload> {
    const engagement = await this.activeEngagement(user, companyId);
    try {
      return buildBalanceSheet(engagement, filters);
    } catch (err) {
      if (err instanceof NoBalanceSheetError) throw new HttpError(422, err.message);
      throw err;
    }
  }

  /**
   * The Cash Flow — a function of the other two statements, so it cannot
   * disagree with them, and it inherits the balance sheet's precondition.
   */
  async cashFlow(
    user: SessionUser,
    companyId: string,
    filters: CashFlowFilters = {},
  ): Promise<CashFlowPayload> {
    const engagement = await this.activeEngagement(user, companyId);
    try {
      return buildCashFlowReport(engagement, filters);
    } catch (err) {
      if (err instanceof NoBalanceSheetError) throw new HttpError(422, err.message);
      throw err;
    }
  }

  /**
   * The month-by-month P&L, with the posted rows behind each line.
   *
   * The ledger detail is a second read rather than part of the engagement: the
   * engine needs an account, a period and an amount, and widening its input
   * with vendor and reference columns for the sake of one table would put
   * presentation concerns inside the calculator.
   */
  async monthlyDetail(
    user: SessionUser,
    companyId: string,
    filters: MonthlyDetailFilters = {},
  ): Promise<MonthlyDetailPayload> {
    const { engagement, versionId } = await this.activeVersion(user, companyId);
    const transactions = await this.ledger.list(versionId);
    return buildMonthlyDetail(engagement, transactions, filters);
  }

  /** The month-by-month Balance Sheet, with the movements behind each line. */
  async balanceSheetMonthlyDetail(
    user: SessionUser,
    companyId: string,
    filters: BalanceSheetMonthlyFilters = {},
  ): Promise<BalanceSheetMonthlyPayload> {
    const { engagement, versionId } = await this.activeVersion(user, companyId);
    const transactions = await this.ledger.list(versionId);
    try {
      return buildBalanceSheetMonthlyDetail(engagement, transactions, filters);
    } catch (err) {
      if (err instanceof NoBalanceSheetError) throw new HttpError(422, err.message);
      throw err;
    }
  }

  /**
   * The month-by-month Cash Flow.
   *
   * No ledger read: every line is a movement between two rolled positions, so
   * there is nothing to drill into that the balance sheet does not already
   * show.
   */
  async cashFlowMonthlyDetail(
    user: SessionUser,
    companyId: string,
    filters: CashFlowMonthlyFilters = {},
  ): Promise<CashFlowMonthlyPayload> {
    const engagement = await this.activeEngagement(user, companyId);
    try {
      return buildCashFlowMonthlyDetail(engagement, filters);
    } catch (err) {
      if (err instanceof NoBalanceSheetError) throw new HttpError(422, err.message);
      throw err;
    }
  }

  /** Spend by vendor, then by account. */
  async vendorDetail(
    user: SessionUser,
    companyId: string,
    filters: VendorDetailFilters = {},
  ): Promise<VendorDetailPayload> {
    return buildVendorDetail(await this.activeEngagement(user, companyId), filters);
  }

  /**
   * Does the ledger carry the opening balance sheet to the closing one?
   *
   * Unlike the statements, this answers rather than refuses when a sheet is
   * missing — "no ending sheet was uploaded" is the finding, not an error.
   */
  async validateBalanceSheet(user: SessionUser, companyId: string): Promise<ValidationPayload> {
    return validateBalanceSheet(await this.activeEngagement(user, companyId));
  }

  /** What the report filters can offer, drawn from the ledger itself. */
  async filterOptions(user: SessionUser, companyId: string): Promise<FilterOptionsPayload> {
    return buildFilterOptions(await this.activeEngagement(user, companyId));
  }

  /**
   * The documents linked to a version, grouped by category.
   *
   * Every category is present whether or not anything is filed under it: the
   * page renders one drop zone per category and iterates the object's keys, so
   * an absent key is a missing drop zone rather than an empty one.
   */
  async listMappings(
    user: SessionUser,
    versionId: string,
  ): Promise<Record<string, MappingRecord[]>> {
    await this.requireAccessible(user, versionId);
    const grouped: Record<string, MappingRecord[]> = Object.fromEntries(
      REPORT_CATEGORIES.map((category) => [category, []]),
    );
    for (const mapping of await this.mappings.listByVersion(versionId)) {
      (grouped[mapping.reportCategory] ??= []).push(mapping);
    }
    return grouped;
  }

  /**
   * Link one or more Data Room documents to a category.
   *
   * The document is looked up rather than trusted: a mapping pointing at a file
   * that is not there renders as a linked document that cannot be opened, and
   * the sync that reads it fails later and further away.
   */
  async linkMappings(
    user: SessionUser,
    versionId: string,
    input: { reportCategory: string; documentIds: string[] },
  ): Promise<MappingRecord[]> {
    const version = await this.requireAccessible(user, versionId);

    if (!(REPORT_CATEGORIES as readonly string[]).includes(input.reportCategory)) {
      throw new HttpError(
        400,
        `Invalid report category: ${input.reportCategory}. ` +
          `Expected one of ${REPORT_CATEGORIES.join(", ")}.`,
      );
    }
    if (input.documentIds.length === 0) throw new HttpError(400, "documentId(s) required.");

    const category = input.reportCategory as ReportCategory;
    const linked: MappingRecord[] = [];
    for (const documentId of input.documentIds) {
      const document = await this.mappings.getDocument(documentId);
      if (!document) throw new NotFoundError("Document not found in the Data Room.");
      // A document belongs to one company; linking another company's file into
      // this version would leak it into a report the owner never sees.
      if (document.companyId !== version.companyId) {
        throw new ForbiddenError("That document belongs to another company.");
      }

      const mapping = await this.mappings.link({
        versionId,
        companyId: version.companyId,
        reportCategory: category,
        documentId,
        uploadId: document.uploadId,
        fileName: document.name,
        year: inferMappingYear(document.name),
        linkedBy: user.id,
      });
      await this.mappings.addFileReference({
        companyId: version.companyId,
        documentId,
        linkedEntityId: versionId,
        createdBy: user.id,
        metadata: { reportCategory: category },
      });
      linked.push(mapping);
    }
    return linked;
  }

  /**
   * Unlink one mapping.
   *
   * The file reference is released only when no OTHER mapping in the same
   * version still points at that document — unlinking a file from the P&L
   * category must not make it deletable while the balance sheet still uses it.
   */
  async deleteMapping(user: SessionUser, mappingId: string): Promise<void> {
    const mapping = await this.mappings.getById(mappingId);
    if (!mapping) throw new NotFoundError("Mapping not found.");
    this.requireCompany(user, mapping.companyId);

    await this.mappings.delete(mappingId);
    if (!mapping.documentId) return;

    const remaining = await this.mappings.countForDocument(mapping.versionId, mapping.documentId);
    if (remaining === 0) {
      await this.mappings.removeFileReference(mapping.documentId, mapping.versionId);
    }
  }

  /**
   * The last few sync attempts on a version.
   *
   * Capped rather than unbounded: the panel shows a short history, and a
   * version synced nightly for a year would otherwise ship thousands of rows to
   * render five.
   */
  async listSyncLogs(user: SessionUser, versionId: string, limit = 20): Promise<SyncLogRecord[]> {
    await this.requireAccessible(user, versionId);
    const capped = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    return this.syncLogs.listByVersion(versionId, capped);
  }

  /**
   * Whether this user has dismissed the Key Reports introduction.
   *
   * Keyed on the caller's own id and never on anything from the request, so one
   * user cannot read or set another's settings.
   */
  async getPopupDismissed(user: SessionUser): Promise<boolean> {
    const value = await this.preferences.get(user.id, POPUP_PREF_KEY);
    return value?.dismissed === true;
  }

  async setPopupDismissed(user: SessionUser, dismissed: boolean): Promise<boolean> {
    await this.preferences.set(user.id, POPUP_PREF_KEY, { dismissed });
    return dismissed;
  }

  /** The engagement behind a company's active key-report version. */
  private async activeEngagement(user: SessionUser, companyId: string) {
    return (await this.activeVersion(user, companyId)).engagement;
  }

  /** The same, when the caller also needs the version it came from. */
  private async activeVersion(user: SessionUser, companyId: string) {
    this.requireCompany(user, companyId);

    const versions = await this.repo.listByCompany(companyId);
    const active = versions.find((v) => v.isActive) ?? versions[0];
    if (!active) throw new NotFoundError("No key-report version for this company.");

    const engagement = await this.engagement.load(active.id);
    if (!engagement) throw new NotFoundError("Report version not found.");
    return { engagement, versionId: active.id };
  }

  async list(user: SessionUser, companyId: string): Promise<ReportVersionResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listByCompany(companyId)).map(toResponse);
  }

  async get(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    return toResponse(await this.requireAccessible(user, id));
  }

  /**
   * The raw rows extraction stored for a version.
   *
   * The access check comes first and separately: the reader is handed a
   * version id it is entitled to read, and does not decide anything about
   * access itself. That keeps the "which table" decision — the only part that
   * takes a value off the query string — away from the part that decides who
   * may see it.
   */
  async extractedData(
    user: SessionUser,
    versionId: string,
    query: ExtractedDataQuery,
  ): Promise<ExtractedDataPage> {
    await this.requireAccessible(user, versionId);
    if (!this.extracted) {
      throw new BadRequestError("Extracted data is not available in this configuration.");
    }
    return this.extracted.read(versionId, query);
  }

  async create(user: SessionUser, input: ReportVersionCreate): Promise<ReportVersionResponse> {
    this.requireCompany(user, input.company_id);
    return toResponse(
      await this.repo.create({
        companyId: input.company_id,
        versionName: input.version_name ?? null,
        metadata: input.metadata ?? {},
        createdBy: user.id,
      }),
    );
  }

  async update(user: SessionUser, id: string, input: ReportVersionUpdate): Promise<ReportVersionResponse> {
    await this.requireAccessible(user, id);
    const updated = await this.repo.update(id, {
      versionName: input.version_name,
      status: input.status,
      metadata: input.metadata,
    });
    return toResponse(updated!);
  }

  async duplicate(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    await this.requireAccessible(user, id);
    return toResponse((await this.repo.duplicate(id, user.id))!);
  }

  async activate(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    await this.requireAccessible(user, id);
    return toResponse((await this.repo.activate(id))!);
  }

  async delete(user: SessionUser, id: string): Promise<void> {
    await this.requireAccessible(user, id);
    await this.repo.delete(id);
  }

  /**
   * Read the version's linked statements into the entry tables.
   *
   * The port is still a seam: a deployment with no model configured gets one
   * that says so, rather than this service knowing whether extraction is
   * available.
   */
  async sync(user: SessionUser, id: string): Promise<unknown> {
    await this.requireAccessible(user, id);
    return this.syncPort.sync(user, id);
  }

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("You do not have access to this company's reports.");
  }
  private async requireAccessible(user: SessionUser, id: string): Promise<VersionRecord> {
    const record = await this.repo.getById(id);
    if (!record) throw new NotFoundError("Report version not found.");
    if (!canAccessCompany(user, record.companyId)) throw new ForbiddenError("You do not have access to this report version.");
    return record;
  }
}

export function toResponse(r: VersionRecord): ReportVersionResponse {
  return {
    id: r.id,
    company_id: r.companyId,
    version_number: r.versionNumber,
    version_name: r.versionName,
    status: r.status,
    is_active: r.isActive,
    resolved_batch_id: r.resolvedBatchId,
    last_synced_at: r.lastSyncedAt,
    metadata: r.metadata,
    created_by: r.createdBy,
  };
}
