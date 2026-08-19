import {
  buildBridge,
  classifyAccounts,
  type Addback,
  type Aggregation,
  type BridgeResult,
  type ClassificationReport,
  type DataSource,
  type EarningsMetric,
} from "@datahub/financial-engine";
import type { EbitdaRole, SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { HttpError } from "../../shared/errors.js";
import type {
  AddbackRecord,
  CommentaryDraftPort,
  CreateAddbackInput,
  QoeRepository,
} from "./ports.js";

export interface BridgeOptions {
  years?: number[];
  aggregation?: Aggregation;
  dataSource?: DataSource;
  metric?: EarningsMetric;
}

export interface QoeServiceDeps {
  repo: QoeRepository;
  commentary?: CommentaryDraftPort;
}

function toEngineAddback(record: AddbackRecord): Addback {
  return {
    id: record.id,
    kind: record.kind,
    dataSource: record.dataSource,
    typeKey: record.typeKey,
    name: record.name,
    linkedAccountId: record.linkedAccountId,
    vendorScope: record.vendorScope,
    granularity: record.granularity,
    values: record.values,
    recastNormalizedValue: record.recastNormalizedValue,
    groupId: record.groupId,
    groupLabel: record.groupLabel,
    explanation: record.explanation,
    commentary: record.commentary,
  };
}

export class QoeService {
  constructor(private readonly deps: QoeServiceDeps) {}

  private async engagement(user: SessionUser, versionId: string) {
    const data = await this.deps.repo.loadEngagement(versionId);
    if (!data) throw new HttpError(404, "Report version not found.");
    if (!canAccessCompany(user, data.companyId)) {
      throw new HttpError(403, "You do not have access to this company.");
    }
    return data;
  }

  /** The SDE/EBITDA bridge for a version (`QE - 0004`). */
  async bridge(user: SessionUser, versionId: string, options: BridgeOptions = {}): Promise<BridgeResult> {
    const data = await this.engagement(user, versionId);
    const records = await this.deps.repo.listAddbacks(versionId);

    // Default to every fiscal year present, per QE-0004's annual default.
    const years =
      options.years && options.years.length > 0 ? options.years : data.fiscalYears;

    return buildBridge({
      accounts: data.accounts,
      entries: data.entries,
      addbacks: records.map(toEngineAddback),
      selectedYears: years,
      aggregation: options.aggregation ?? "annual",
      dataSource: options.dataSource ?? "company_financials",
      metric: options.metric ?? data.profitMetric,
      marketRateReplacementSalary: data.marketRateReplacementSalary,
    });
  }

  async listAddbacks(user: SessionUser, versionId: string): Promise<AddbackRecord[]> {
    await this.engagement(user, versionId);
    return this.deps.repo.listAddbacks(versionId);
  }

  async createAddback(user: SessionUser, input: CreateAddbackInput): Promise<AddbackRecord> {
    const data = await this.engagement(user, input.versionId);
    if (input.companyId !== data.companyId) {
      throw new HttpError(400, "Add-back company does not match the report version.");
    }
    return this.deps.repo.createAddback(input);
  }

  async deleteAddback(user: SessionUser, id: string): Promise<void> {
    const record = await this.deps.repo.getAddback(id);
    if (!record) throw new HttpError(404, "Add-back not found.");
    await this.engagement(user, record.versionId);
    await this.deps.repo.deleteAddback(id);
  }

  /**
   * Draft commentary for an add-back. Returned for review and NEVER saved —
   * `QE - 0004` requires explicit human confirmation before commentary lands.
   */
  async draftCommentary(user: SessionUser, id: string): Promise<{ draft: string }> {
    const record = await this.deps.repo.getAddback(id);
    if (!record) throw new HttpError(404, "Add-back not found.");
    await this.engagement(user, record.versionId);
    if (!this.deps.commentary) {
      throw new HttpError(503, "Commentary drafting is not configured.");
    }
    const draft = await this.deps.commentary.draft({
      label: record.name,
      amounts: record.values,
      context: record.explanation ?? "",
    });
    return { draft };
  }

  /** Confirm a drafted or edited commentary onto the record. */
  async saveCommentary(user: SessionUser, id: string, commentary: string): Promise<AddbackRecord> {
    const record = await this.deps.repo.getAddback(id);
    if (!record) throw new HttpError(404, "Add-back not found.");
    await this.engagement(user, record.versionId);
    const updated = await this.deps.repo.updateCommentary(id, commentary);
    if (!updated) throw new HttpError(404, "Add-back not found.");
    return updated;
  }

  /**
   * Classify the chart of accounts and, unless this is a dry run, persist the
   * high-confidence results.
   *
   * Only `applied` is written. `suggested` is returned for a human to confirm
   * through `setAccountRole`, and `unclassified` carries the reason each
   * account was left out — an operating tax says so, rather than looking like
   * an oversight.
   */
  async classify(
    user: SessionUser,
    versionId: string,
    { dryRun = false }: { dryRun?: boolean } = {},
  ): Promise<ClassificationReport & { applied_count: number; dry_run: boolean }> {
    const data = await this.engagement(user, versionId);
    const report = classifyAccounts(data.accounts);

    if (!dryRun && report.applied.length > 0) {
      await this.deps.repo.setAccountRoles(
        versionId,
        report.applied.map((c) => ({ accountId: c.accountId, role: c.role! })),
      );
    }

    return { ...report, applied_count: dryRun ? 0 : report.applied.length, dry_run: dryRun };
  }

  async setAccountRole(
    user: SessionUser,
    versionId: string,
    accountId: string,
    role: EbitdaRole | null,
  ): Promise<void> {
    await this.engagement(user, versionId);
    await this.deps.repo.setAccountRole(versionId, accountId, role);
  }
}
