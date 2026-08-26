import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import type { RegenerateResult } from "./regenerate.drizzle.js";

/**
 * What rebuilds the chart from the entry tables.
 *
 * A port rather than the class, so the service can be constructed without a
 * database — every other dependency here already can be, and a mandatory
 * Drizzle generator would make the unit tests need one.
 */
export interface ChartOfAccountsGenerator {
  regenerate(companyId: string, versionId: string): Promise<RegenerateResult>;
}
import {
  buildTree,
  isModified,
  hierarchySnapshot,
  MAX_LEVELS,
  statementTypeFor,
  toAccount,
  type CoaAccount,
  type CoaTreeNode,
} from "./mapping.js";
import type {
  AccountPatch,
  AccountUpdate,
  AdjustmentRecord,
  ChartOfAccountsRepository,
  ClassificationHistoryRecord,
  HierarchyLevel,
} from "./ports.js";

/** Resolves a version to its company, so access can be checked against it. */
export interface VersionAccessPort {
  /** Null when the version does not exist. */
  companyIdFor(versionId: string): Promise<string | null>;
  /** Throws `ForbiddenError` when the user may not see the company. */
  assertAccess(user: SessionUser, companyId: string): void;
}

export interface ChartOfAccountsResponse {
  versionId: string;
  flat: CoaAccount[];
  tree: CoaTreeNode[];
  accountCount: number;
}

export interface ChartOfAccountsServiceDeps {
  repo: ChartOfAccountsRepository;
  versions: VersionAccessPort;
  /** Injected so an edit's timestamps are pinnable in a test. */
  now?: () => Date;
  /** Absent in unit tests; the rebuild route says so rather than failing at a null. */
  generator?: ChartOfAccountsGenerator;
}

export class ChartOfAccountsService {
  private readonly repo: ChartOfAccountsRepository;
  private readonly versions: VersionAccessPort;
  private readonly now: () => Date;
  private readonly generator: ChartOfAccountsGenerator | undefined;

  constructor(deps: ChartOfAccountsServiceDeps) {
    this.repo = deps.repo;
    this.versions = deps.versions;
    this.now = deps.now ?? (() => new Date());
    this.generator = deps.generator;
  }

  private async requireVersion(user: SessionUser, versionId: string): Promise<string> {
    const companyId = await this.versions.companyIdFor(versionId);
    if (!companyId) throw new NotFoundError("Report version not found.");
    this.versions.assertAccess(user, companyId);
    return companyId;
  }

  /**
   * The chart, flat and as a tree.
   *
   * Group rows are dropped: they exist only to carry the parent chain, and the
   * tree is rebuilt from each account's level path anyway. Leaving them in
   * would show every category twice — once as itself and once as a node.
   */
  async list(user: SessionUser, versionId: string): Promise<ChartOfAccountsResponse> {
    await this.requireVersion(user, versionId);

    const rows = await this.repo.listByVersion(versionId);
    const flat = rows.filter((r) => !r.metadata?.is_group).map(toAccount);
    return { versionId, flat, tree: buildTree(flat), accountCount: flat.length };
  }

  /**
   * Rebuild the chart from what extraction stored.
   *
   * Answers the rebuilt chart, not just a count: the page that triggers this
   * is showing the chart, and making it ask again is a second round trip
   * during which the two can disagree.
   *
   * What a person edited survives — a renamed account, a moved one, one
   * deactivated. Those cannot be recovered from anything, unlike everything
   * the rules produce.
   */
  async regenerate(
    user: SessionUser,
    versionId: string,
  ): Promise<ChartOfAccountsResponse & RegenerateResult> {
    const companyId = await this.requireVersion(user, versionId);
    if (!this.generator) {
      throw new BadRequestError("Rebuilding the chart is not available in this configuration.");
    }
    const summary = await this.generator.regenerate(companyId, versionId);
    return { ...(await this.list(user, versionId)), ...summary };
  }

  /**
   * The audit trail: what changed, and what the classification looked like.
   *
   * Keyed `classificationHistory` rather than `history` to match the response
   * legacy served — the endpoint is otherwise identical, and a gratuitous
   * rename is a compatibility break for nothing.
   */
  async history(
    user: SessionUser,
    versionId: string,
  ): Promise<{
    adjustments: AdjustmentRecord[];
    classificationHistory: ClassificationHistoryRecord[];
  }> {
    await this.requireVersion(user, versionId);
    const [adjustments, classificationHistory] = await Promise.all([
      this.repo.listAdjustments(versionId),
      this.repo.listHistory(versionId),
    ]);
    return { adjustments, classificationHistory };
  }

  /**
   * Persist an edited hierarchy for many accounts at once.
   *
   * Applied one at a time through the single-account path, so every node gets
   * the same audit trail and the same `user_modified` flag. A bulk shortcut
   * that wrote the rows directly would be a second writer, silently diverging
   * the moment either changed.
   */
  async saveHierarchy(
    user: SessionUser,
    versionId: string,
    nodes: ReadonlyArray<{ accountId?: string; id?: string } & AccountPatch>,
  ): Promise<{ updated: number }> {
    await this.requireVersion(user, versionId);

    let updated = 0;
    for (const node of nodes) {
      const accountId = node.accountId ?? node.id;
      if (!accountId) continue;
      await this.updateAccount(user, accountId, {
        adjustedName: node.adjustedName,
        accountType: node.accountType,
        statementType: node.statementType,
        levels: node.levels,
        isActive: node.isActive,
        movedParent: node.movedParent,
      });
      updated += 1;
    }
    return { updated };
  }

  /**
   * Restore every edited account in a version to the classifier's answer.
   *
   * Only the edited ones are touched — resetting an untouched account would
   * write an audit entry saying nothing changed.
   */
  async resetVersion(user: SessionUser, versionId: string): Promise<{ reset: number }> {
    await this.requireVersion(user, versionId);

    const rows = await this.repo.listByVersion(versionId);
    const edited = rows.filter(isModified);
    for (const row of edited) await this.resetAccount(user, row.id);
    return { reset: edited.length };
  }

  /** The standard hierarchy vocabulary. Reference data, not per-company. */
  async hierarchyLevels(): Promise<HierarchyLevel[]> {
    return this.repo.listHierarchyLevels();
  }

  /**
   * Apply a hand edit to one account.
   *
   * Every branch records what it changed before writing, so the audit trail
   * carries the old value — reconstructing it afterwards is impossible once the
   * row is overwritten. An edit that changes nothing writes nothing at all,
   * rather than filling the trail with no-ops.
   *
   * `original_*` is never touched. That pair is what "reset" restores, and an
   * edit that overwrote it would make the reset a no-op.
   */
  async updateAccount(
    user: SessionUser,
    accountId: string,
    patch: AccountPatch,
  ): Promise<CoaAccount> {
    const row = await this.repo.getAccount(accountId);
    if (!row) throw new NotFoundError("Account not found.");
    this.versions.assertAccess(user, row.companyId ?? "");

    const audit = (fieldChanged: string, oldValue: unknown, newValue: unknown): Promise<void> =>
      this.repo.recordAdjustment({
        accountId: row.id,
        versionId: row.versionId,
        companyId: row.companyId,
        fieldChanged,
        oldValue,
        newValue,
        changedBy: user.id,
      });

    const update: AccountUpdate = {
      classificationMethod: "manual",
      metadata: { ...(row.metadata ?? {}), user_modified: true },
    };
    let changed = false;

    if (patch.adjustedName !== undefined && patch.adjustedName !== row.adjustedName) {
      await audit("name", row.adjustedName, patch.adjustedName);
      // An empty rename falls back to the source name rather than blanking it.
      update.adjustedName = patch.adjustedName.trim() || row.accountName;
      changed = true;
    }

    if (patch.accountType !== undefined && patch.accountType !== row.accountType) {
      await audit("reclassify", row.accountType, patch.accountType);
      update.accountType = patch.accountType;
      // The statement follows the type unless the caller states otherwise.
      if (patch.statementType === undefined) {
        update.statementType = statementTypeFor(patch.accountType);
      }
      changed = true;
    }
    if (patch.statementType !== undefined) update.statementType = patch.statementType;

    if (Array.isArray(patch.levels)) {
      const levels = patch.levels.slice(0, MAX_LEVELS);
      while (levels.length < MAX_LEVELS) levels.push(null);
      const filled = levels.filter((l): l is string => Boolean(l));
      const baseAccount = filled.length > 0 ? filled[filled.length - 1]! : row.baseAccount;

      await audit(patch.movedParent ? "parent" : "level", row.levels, levels);
      update.levels = levels;
      update.baseAccount = baseAccount;
      update.hierarchyPath = filled.join(" > ");
      update.adjustedHierarchy = hierarchySnapshot(
        levels,
        update.accountType ?? row.accountType,
        update.statementType ?? row.statementType,
        baseAccount,
      );
      changed = true;
    }

    if (patch.isActive !== undefined && patch.isActive !== row.isActive) {
      await audit("active", row.isActive, patch.isActive);
      update.isActive = patch.isActive;
      changed = true;
    }

    if (!changed) return toAccount(row);

    const updated = await this.repo.updateAccount(accountId, update);
    if (!updated) throw new NotFoundError("Account not found.");

    await this.repo.recordHistory({
      accountId: updated.id,
      versionId: updated.versionId,
      companyId: row.companyId,
      classificationMethod: "manual",
      hierarchySnapshot: hierarchySnapshot(
        updated.levels,
        updated.accountType,
        updated.statementType,
        updated.baseAccount,
      ),
      source: "adjust",
      createdBy: user.id,
    });

    return toAccount(updated);
  }

  /**
   * Restore an account to what the classifier originally produced.
   *
   * Clearing `adjusted_*` is the whole operation — the original pair was never
   * written to, so there is nothing to restore from anywhere else.
   */
  async resetAccount(user: SessionUser, accountId: string): Promise<CoaAccount> {
    const row = await this.repo.getAccount(accountId);
    if (!row) throw new NotFoundError("Account not found.");
    this.versions.assertAccess(user, row.companyId ?? "");

    await this.repo.recordAdjustment({
      accountId: row.id,
      versionId: row.versionId,
      companyId: row.companyId,
      fieldChanged: "reset",
      oldValue: { adjustedName: row.adjustedName, levels: row.levels },
      newValue: null,
      changedBy: user.id,
    });

    const metadata = { ...(row.metadata ?? {}) };
    delete (metadata as { user_modified?: boolean }).user_modified;

    const updated = await this.repo.updateAccount(accountId, {
      classificationMethod: "ai",
      metadata,
      adjustedName: "",
      adjustedHierarchy: undefined,
    });
    if (!updated) throw new NotFoundError("Account not found.");

    await this.repo.recordHistory({
      accountId: updated.id,
      versionId: updated.versionId,
      companyId: row.companyId,
      classificationMethod: "ai",
      hierarchySnapshot: hierarchySnapshot(
        updated.levels,
        updated.accountType,
        updated.statementType,
        updated.baseAccount,
      ),
      source: "reset",
      createdBy: user.id,
    });

    return toAccount(updated);
  }

  /** Timestamp helper, kept so the clock is injectable in one place. */
  protected stamp(): string {
    return this.now().toISOString();
  }
}
