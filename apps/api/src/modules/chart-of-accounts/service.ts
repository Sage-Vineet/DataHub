import type { SessionUser } from "@datahub/contracts";
import { NotFoundError } from "../../shared/errors.js";
import {
  buildTree,
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
}

export class ChartOfAccountsService {
  private readonly repo: ChartOfAccountsRepository;
  private readonly versions: VersionAccessPort;
  private readonly now: () => Date;

  constructor(deps: ChartOfAccountsServiceDeps) {
    this.repo = deps.repo;
    this.versions = deps.versions;
    this.now = deps.now ?? (() => new Date());
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

  /** The audit trail: what changed, and what the classification looked like. */
  async history(
    user: SessionUser,
    versionId: string,
  ): Promise<{ adjustments: AdjustmentRecord[]; history: ClassificationHistoryRecord[] }> {
    await this.requireVersion(user, versionId);
    const [adjustments, history] = await Promise.all([
      this.repo.listAdjustments(versionId),
      this.repo.listHistory(versionId),
    ]);
    return { adjustments, history };
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
