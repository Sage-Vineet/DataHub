import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { MAX_LEVELS } from "./mapping.js";
import { InMemoryChartOfAccountsRepository } from "./repository.memory.js";
import { ChartOfAccountsService, type VersionAccessPort } from "./service.js";

/**
 * Editing the chart of accounts.
 *
 * Two properties carry the weight. Every change is recorded with its OLD value
 * before the row is overwritten — afterwards it cannot be recovered — and
 * `original_*` is never written to, because that pair is what "reset" restores.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VERSION = "vvvvvvvv-vvvv-vvvv-vvvv-vvvvvvvvvvvv";

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "Dana",
  email: "dana@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

/** Version access backed by a fixed map, so the service can be tested alone. */
function versionsPort(map: Record<string, string> = { [VERSION]: COMPANY }): VersionAccessPort {
  return {
    companyIdFor: (versionId) => Promise.resolve(map[versionId] ?? null),
    assertAccess: (user, companyId) => {
      if (!canAccessCompany(user, companyId)) throw new ForbiddenError("denied");
    },
  };
}

function make() {
  const repo = new InMemoryChartOfAccountsRepository();
  const service = new ChartOfAccountsService({ repo, versions: versionsPort() });
  return { repo, service };
}

const levels = (...values: Array<string | null>): Array<string | null> => [
  ...values,
  ...Array.from({ length: MAX_LEVELS - values.length }, () => null),
];

describe("listing", () => {
  it("returns the flat grid and the tree together", async () => {
    const { repo, service } = make();
    repo.seed({
      id: "a1",
      versionId: VERSION,
      companyId: COMPANY,
      accountName: "Product Sales",
      levels: levels("Income Statement", "Revenue", "Product Sales"),
    });

    const result = await service.list(session(), VERSION);

    expect(result.accountCount).toBe(1);
    expect(result.flat[0]!.accountName).toBe("Product Sales");
    expect(result.tree[0]!.name).toBe("Income Statement");
  });

  it("drops group rows, which exist only to carry the parent chain", async () => {
    // The tree is rebuilt from each account's levels, so a group row would
    // appear twice — once as itself and once as a node.
    const { repo, service } = make();
    repo.seed({ id: "grp", versionId: VERSION, companyId: COMPANY, metadata: { is_group: true } });
    repo.seed({ id: "acct", versionId: VERSION, companyId: COMPANY });

    const result = await service.list(session(), VERSION);
    expect(result.flat.map((a) => a.id)).toEqual(["acct"]);
  });

  it("404s a version that does not exist", async () => {
    const { service } = make();
    await expect(service.list(session(), randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("403s a version belonging to another company", async () => {
    const { service } = make();
    await expect(service.list(session({ company_ids: [OTHER] }), VERSION)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe("editing an account", () => {
  const seedOne = (repo: InMemoryChartOfAccountsRepository) =>
    repo.seed({
      id: "a1",
      versionId: VERSION,
      companyId: COMPANY,
      accountName: "4000 Sales",
      originalName: "4000 Sales",
      accountType: "income",
      statementType: "profit_loss",
      levels: levels("Income Statement", "Revenue", "4000 Sales"),
    });

  it("renames, and records the old value before overwriting it", async () => {
    const { repo, service } = make();
    seedOne(repo);
    const user = session();

    const account = await service.updateAccount(user, "a1", { adjustedName: "Product Revenue" });

    expect(account.accountName).toBe("Product Revenue");
    expect(account.sourceName).toBe("4000 Sales");
    expect(repo.adjustments).toHaveLength(1);
    expect(repo.adjustments[0]).toMatchObject({
      fieldChanged: "name",
      oldValue: null,
      newValue: "Product Revenue",
      changedBy: user.id,
    });
  });

  it("never touches the original name, because reset restores from it", async () => {
    const { repo, service } = make();
    seedOne(repo);
    await service.updateAccount(session(), "a1", { adjustedName: "Renamed" });
    expect((await repo.getAccount("a1"))!.originalName).toBe("4000 Sales");
  });

  it("falls back to the source name when a rename is blank", async () => {
    const { repo, service } = make();
    seedOne(repo);
    const account = await service.updateAccount(session(), "a1", { adjustedName: "   " });
    expect(account.accountName).toBe("4000 Sales");
  });

  it("derives the statement from a reclassification", async () => {
    const { repo, service } = make();
    seedOne(repo);
    const account = await service.updateAccount(session(), "a1", { accountType: "asset" });
    expect(account).toMatchObject({ accountType: "asset", statementType: "balance_sheet" });
  });

  it("lets an explicit statement type override the derived one", async () => {
    const { repo, service } = make();
    seedOne(repo);
    const account = await service.updateAccount(session(), "a1", {
      accountType: "asset",
      statementType: "profit_loss",
    });
    expect(account.statementType).toBe("profit_loss");
  });

  it("rewrites the hierarchy, padding and recomputing the path", async () => {
    const { repo, service } = make();
    seedOne(repo);

    const account = await service.updateAccount(session(), "a1", {
      levels: ["Income Statement", "Other Income", "4000 Sales"],
    });

    expect(account.levels).toHaveLength(MAX_LEVELS);
    expect(account.hierarchyPath).toBe("Income Statement > Other Income > 4000 Sales");
    // The base account is the deepest level, which is the account itself.
    expect(account.baseAccount).toBe("4000 Sales");
  });

  it("distinguishes a re-parent from a re-label in the trail", async () => {
    const { repo, service } = make();
    seedOne(repo);

    await service.updateAccount(session(), "a1", { levels: ["A", "B"], movedParent: true });
    expect(repo.adjustments[0]!.fieldChanged).toBe("parent");

    repo.adjustments.length = 0;
    await service.updateAccount(session(), "a1", { levels: ["A", "C"] });
    expect(repo.adjustments[0]!.fieldChanged).toBe("level");
  });

  it("marks the account edited and the method manual", async () => {
    const { repo, service } = make();
    seedOne(repo);
    const account = await service.updateAccount(session(), "a1", { adjustedName: "X" });
    expect(account.modified).toBe(true);
    expect(account.classificationMethod).toBe("manual");
  });

  it("writes a history snapshot of where the account ended up", async () => {
    const { repo, service } = make();
    seedOne(repo);
    await service.updateAccount(session(), "a1", { accountType: "asset" });

    expect(repo.history).toHaveLength(1);
    expect(repo.history[0]).toMatchObject({ source: "adjust", classificationMethod: "manual" });
    expect(repo.history[0]!.hierarchySnapshot).toMatchObject({
      account_type: "asset",
      statement_type: "balance_sheet",
    });
  });

  it("writes nothing at all when the patch changes nothing", async () => {
    // Otherwise the trail fills with no-ops and stops being readable.
    const { repo, service } = make();
    seedOne(repo);

    await service.updateAccount(session(), "a1", {
      adjustedName: undefined,
      accountType: "income",
      isActive: true,
    });

    expect(repo.adjustments).toEqual([]);
    expect(repo.history).toEqual([]);
  });

  it("records each changed field separately", async () => {
    const { repo, service } = make();
    seedOne(repo);

    await service.updateAccount(session(), "a1", {
      adjustedName: "New",
      accountType: "expense",
      isActive: false,
    });

    expect(repo.adjustments.map((a) => a.fieldChanged).sort()).toEqual([
      "active",
      "name",
      "reclassify",
    ]);
  });

  it("404s an unknown account and 403s another company's", async () => {
    const { repo, service } = make();
    repo.seed({ id: "theirs", versionId: VERSION, companyId: OTHER });

    await expect(service.updateAccount(session(), randomUUID(), {})).rejects.toThrow(NotFoundError);
    await expect(service.updateAccount(session(), "theirs", {})).rejects.toThrow(ForbiddenError);
  });
});

describe("resetting an account", () => {
  it("clears the adjustment and returns to the classifier's answer", async () => {
    const { repo, service } = make();
    repo.seed({
      id: "a1",
      versionId: VERSION,
      companyId: COMPANY,
      accountName: "4000 Sales",
      originalName: "4000 Sales",
      adjustedName: "Renamed",
      metadata: { user_modified: true },
    });

    const account = await service.resetAccount(session(), "a1");

    expect(account.adjustedName).toBeNull();
    expect(account.accountName).toBe("4000 Sales");
    expect(account.modified).toBe(false);
    expect(account.classificationMethod).toBe("ai");
  });

  it("records the reset, carrying what was discarded", async () => {
    const { repo, service } = make();
    repo.seed({
      id: "a1",
      versionId: VERSION,
      companyId: COMPANY,
      adjustedName: "Renamed",
      metadata: { user_modified: true },
    });

    await service.resetAccount(session(), "a1");

    expect(repo.adjustments[0]).toMatchObject({ fieldChanged: "reset", newValue: null });
    expect(repo.adjustments[0]!.oldValue).toMatchObject({ adjustedName: "Renamed" });
    expect(repo.history[0]).toMatchObject({ source: "reset", classificationMethod: "ai" });
  });

  it("404s an unknown account", async () => {
    const { service } = make();
    await expect(service.resetAccount(session(), randomUUID())).rejects.toThrow(NotFoundError);
  });
});

describe("the audit trail and the vocabulary", () => {
  it("returns both trails for a version", async () => {
    const { repo, service } = make();
    repo.seed({ id: "a1", versionId: VERSION, companyId: COMPANY });
    await service.updateAccount(session(), "a1", { adjustedName: "X" });

    const history = await service.history(session(), VERSION);
    expect(history.adjustments).toHaveLength(1);
    expect(history.classificationHistory).toHaveLength(1);
  });

  it("refuses the trail for a company the caller is not on", async () => {
    const { service } = make();
    await expect(service.history(session({ company_ids: [OTHER] }), VERSION)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("returns the hierarchy vocabulary, which is reference data", async () => {
    const { repo, service } = make();
    repo.seedHierarchyLevels([
      { levelNumber: 1, statementType: "profit_loss", parentLabel: null, label: "Income Statement", sortOrder: 0, isStandard: true },
    ]);
    expect((await service.hierarchyLevels()).map((l) => l.label)).toEqual(["Income Statement"]);
  });
});

describe("bulk editing", () => {
  const seedTwo = (repo: InMemoryChartOfAccountsRepository) => {
    repo.seed({ id: "a1", versionId: VERSION, companyId: COMPANY, accountName: "One" });
    repo.seed({ id: "a2", versionId: VERSION, companyId: COMPANY, accountName: "Two" });
  };

  it("applies each node through the single-account path, audit and all", async () => {
    // A bulk shortcut writing rows directly would be a second writer, and would
    // diverge from the grid's the moment either changed.
    const { repo, service } = make();
    seedTwo(repo);

    const result = await service.saveHierarchy(session(), VERSION, [
      { accountId: "a1", adjustedName: "First" },
      { id: "a2", accountType: "asset" },
    ]);

    expect(result).toEqual({ updated: 2 });
    expect(repo.adjustments.map((a) => a.fieldChanged).sort()).toEqual(["name", "reclassify"]);
    expect(repo.history).toHaveLength(2);
  });

  it("accepts a node keyed either `accountId` or `id`", async () => {
    const { repo, service } = make();
    seedTwo(repo);
    expect(await service.saveHierarchy(session(), VERSION, [{ id: "a1", adjustedName: "X" }])).toEqual(
      { updated: 1 },
    );
  });

  it("skips a node that names no account rather than failing the batch", async () => {
    const { repo, service } = make();
    seedTwo(repo);
    const result = await service.saveHierarchy(session(), VERSION, [
      { adjustedName: "orphan" },
      { accountId: "a1", adjustedName: "First" },
    ]);
    expect(result).toEqual({ updated: 1 });
  });

  it("resets only the accounts somebody edited", async () => {
    // Resetting an untouched account writes an audit entry saying nothing
    // changed, which is worse than doing nothing.
    const { repo, service } = make();
    seedTwo(repo);
    await service.updateAccount(session(), "a1", { adjustedName: "Edited" });
    repo.adjustments.length = 0;
    repo.history.length = 0;

    expect(await service.resetVersion(session(), VERSION)).toEqual({ reset: 1 });
    expect(repo.adjustments.map((a) => a.accountId)).toEqual(["a1"]);
  });

  it("reports zero when nothing has been edited", async () => {
    const { repo, service } = make();
    seedTwo(repo);
    expect(await service.resetVersion(session(), VERSION)).toEqual({ reset: 0 });
  });

  it("refuses both against a company the caller is not on", async () => {
    const { service } = make();
    const outsider = session({ company_ids: [OTHER] });
    await expect(service.saveHierarchy(outsider, VERSION, [])).rejects.toThrow(ForbiddenError);
    await expect(service.resetVersion(outsider, VERSION)).rejects.toThrow(ForbiddenError);
  });
});
