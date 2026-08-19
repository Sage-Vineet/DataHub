import {
  buildBridge,
  buildTrialBalance,
  classifyAccounts,
  rollForwardBalanceSheet,
  type Addback,
  type Aggregation,
  type BridgeResult,
  type BalanceSheetResult,
  type ClassificationReport,
  type DataSource,
  type EarningsMetric,
  type TrialBalanceResult,
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
   * The rolled balance sheet.
   *
   * Needs at least one ingested balance-sheet statement to anchor on — the
   * position cannot be derived from ledger movement alone, and saying so is
   * better than returning a sheet anchored at zero.
   */
  async balanceSheet(
    user: SessionUser,
    versionId: string,
    options: { years?: number[] } = {},
  ): Promise<BalanceSheetResult> {
    const data = await this.engagement(user, versionId);
    if (data.anchors.length === 0) {
      throw new HttpError(
        409,
        "No balance sheet has been ingested for this version. Link a starting or " +
          "ending balance sheet and re-run the sync.",
      );
    }
    return rollForwardBalanceSheet({
      accounts: data.accounts,
      entries: data.entries,
      anchors: data.anchors,
      fiscalYears: options.years?.length ? options.years : data.fiscalYears,
    });
  }

  /**
   * The trial balance, with openings read from the same roll-forward the
   * balance sheet uses so the two cannot disagree.
   */
  async trialBalance(
    user: SessionUser,
    versionId: string,
    options: { years?: number[]; aggregation?: Aggregation } = {},
  ): Promise<TrialBalanceResult> {
    const data = await this.engagement(user, versionId);
    if (data.anchors.length === 0) {
      throw new HttpError(
        409,
        "No balance sheet has been ingested for this version, so balance-sheet " +
          "accounts have no opening balances to carry.",
      );
    }
    return buildTrialBalance({
      accounts: data.accounts,
      entries: data.entries,
      anchors: data.anchors,
      fiscalYears: options.years?.length ? options.years : data.fiscalYears,
      aggregation: options.aggregation ?? "annual",
    });
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

  async setAccountClassification(
    user: SessionUser,
    versionId: string,
    accountId: string,
    accountType: string,
  ): Promise<void> {
    await this.engagement(user, versionId);
    await this.deps.repo.setAccountClassification(versionId, accountId, accountType);
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
