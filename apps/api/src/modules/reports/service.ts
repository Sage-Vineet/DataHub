import type {
  ReportVersionCreate,
  ReportVersionResponse,
  ReportVersionUpdate,
  SessionUser,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import type { EngagementPort, ReportSyncPort, ReportsRepository, VersionRecord } from "./ports.js";
import { buildStatements, type BuildStatementsOptions, type FinancialStatements } from "./statements.js";
import {
  buildProfitLossSummary,
  type ProfitLossFilters,
  type ProfitLossSummaryPayload,
} from "./profit-loss-view.js";
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

export interface ReportsServiceDeps {
  repo: ReportsRepository;
  sync: ReportSyncPort;
  engagement: EngagementPort;
}

export class ReportsService {
  private readonly repo: ReportsRepository;
  private readonly syncPort: ReportSyncPort;
  private readonly engagement: EngagementPort;
  constructor(deps: ReportsServiceDeps) {
    this.repo = deps.repo;
    this.syncPort = deps.sync;
    this.engagement = deps.engagement;
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

  /** The engagement behind a company's active key-report version. */
  private async activeEngagement(user: SessionUser, companyId: string) {
    this.requireCompany(user, companyId);

    const versions = await this.repo.listByCompany(companyId);
    const active = versions.find((v) => v.isActive) ?? versions[0];
    if (!active) throw new NotFoundError("No key-report version for this company.");

    const engagement = await this.engagement.load(active.id);
    if (!engagement) throw new NotFoundError("Report version not found.");
    return engagement;
  }

  async list(user: SessionUser, companyId: string): Promise<ReportVersionResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listByCompany(companyId)).map(toResponse);
  }

  async get(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    return toResponse(await this.requireAccessible(user, id));
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

  /** The GL sync is not yet migrated — the port reports it's on the legacy engine (D5). */
  async sync(user: SessionUser, id: string): Promise<never> {
    await this.requireAccessible(user, id);
    return this.syncPort.sync(id);
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
