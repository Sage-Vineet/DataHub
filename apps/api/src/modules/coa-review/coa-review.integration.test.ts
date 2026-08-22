import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb } from "@datahub/db";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { schema, type Db } from "@datahub/db";

import { DrizzleCoaReviewRepository } from "./repository.drizzle.js";
import { createRecordingHierarchyWriter, createStubClassifier } from "./repository.memory.js";
import { createCoaReviewService } from "./service.js";

/**
 * The Drizzle adapter against the real deployed schema.
 *
 * `createSchemaDb()` loads `packages/db/schema-snapshot.sql`, so every insert
 * below has to satisfy the constraints production actually has — including the
 * ones 0005 adds. That matters more than usual here: the interesting behaviour
 * of this adapter is a conflict clause and a `numeric` round-trip, and neither
 * can be verified against hand-written DDL or an in-memory fake.
 */

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const VERSION = "bbbbbbbb-0000-4000-8000-000000000001";
const ACCOUNT = "cccccccc-0000-4000-8000-000000000001";
const CATEGORY = "cccccccc-0000-4000-8000-000000000002";
// `decided_by` is a uuid column. The in-memory fake accepts any string, so a
// non-uuid reviewer id only fails against the real schema — which is the sort of
// difference this file exists to surface.
const REVIEWER = "dddddddd-0000-4000-8000-000000000001";

let pg: PGlite;
let db: Db;
let repo: DrizzleCoaReviewRepository;

beforeEach(async () => {
  pg = await createSchemaDb();
  db = drizzle(pg, { schema }) as unknown as Db;
  repo = new DrizzleCoaReviewRepository(db);

  await pg.exec(`
    INSERT INTO companies (id, name, industry, status)
      VALUES ('${COMPANY}', 'Acme', 'Manufacturing', 'active');
    INSERT INTO key_report_versions (id, company_id, version_number, is_active)
      VALUES ('${VERSION}', '${COMPANY}', 1, true);

    -- One posting account, four levels deep, with the trailing padding the
    -- generator writes.
    INSERT INTO chart_of_accounts
      (id, version_id, company_id, account_name, account_type, statement_type,
       is_active, metadata, level_1, level_2, level_3, level_4, level_5)
      VALUES ('${ACCOUNT}', '${VERSION}', '${COMPANY}', 'Interest Income', 'income',
              'profit_loss', true, '{}'::jsonb,
              'Net Income', 'Total Revenue', 'Income', 'Interest Income', 'Interest Income');

    -- A document-driven section node the review can target.
    INSERT INTO chart_of_accounts
      (id, version_id, company_id, account_name, account_type, statement_type,
       is_active, metadata, level_1, level_2, level_3)
      VALUES ('${CATEGORY}', '${VERSION}', '${COMPANY}', 'Other Income', 'income',
              'profit_loss', true, '{"is_group": true}'::jsonb,
              'Net Income', 'Pretax Income', 'Other Income');
  `);
});

afterEach(async () => {
  await pg.close();
});

const upsertInput = (over: Record<string, unknown> = {}) => ({
  versionId: VERSION,
  companyId: COMPANY,
  accountId: ACCOUNT,
  currentHierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
  currentAccountType: "income",
  currentStatementType: "profit_loss",
  kind: "HIERARCHY_MOVE" as const,
  recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
  recommendedRollup: "Other Income",
  recommendedParent: "Pretax Income",
  recommendedAccountType: null,
  recommendedStatementType: null,
  confidenceBand: "HIGH" as const,
  confidence: 0.95,
  source: "DOCUMENT_MATCH" as const,
  impact: "OPERATING_RESULT" as const,
  reason: "Interest income is non-operating.",
  aiModel: "test-model",
  ...over,
});

describe("loadVersionCoa", () => {
  it("splits categories from posting accounts", async () => {
    const coa = await repo.loadVersionCoa(VERSION);

    expect(coa.rows).toHaveLength(2);
    expect(coa.categories.map((c) => c.id)).toEqual([CATEGORY]);
    expect(coa.leaves.map((l) => l.id)).toEqual([ACCOUNT]);
    expect(coa.reviewable.map((l) => l.id)).toEqual([ACCOUNT]);
  });

  it("exposes the level columns under the names the engine reads", async () => {
    // Drizzle models them as level1..level15; `columnsToLevels` reads level_N.
    // If that translation is wrong every hierarchy silently becomes empty.
    const coa = await repo.loadVersionCoa(VERSION);
    const account = coa.leaves[0]!;

    expect(account.level_1).toBe("Net Income");
    expect(account.level_4).toBe("Interest Income");
    expect(account.level_6).toBeNull();
  });

  it("excludes an account somebody edited by hand", async () => {
    await pg.exec(
      `UPDATE chart_of_accounts SET metadata = '{"user_modified": true}'::jsonb WHERE id = '${ACCOUNT}';`,
    );
    const coa = await repo.loadVersionCoa(VERSION);

    expect(coa.leaves).toHaveLength(1);
    expect(coa.reviewable).toHaveLength(0);
  });

  it("excludes an inactive row", async () => {
    await pg.exec(`UPDATE chart_of_accounts SET is_active = false WHERE id = '${ACCOUNT}';`);
    expect((await repo.loadVersionCoa(VERSION)).rows).toHaveLength(1);
  });
});

describe("upsertRecommendation", () => {
  it("stores a recommendation as pending", async () => {
    await repo.upsertRecommendation(upsertInput());

    const [stored] = await repo.listRecommendations(VERSION);
    expect(stored).toMatchObject({
      account_id: ACCOUNT,
      status: "pending",
      recommended_rollup: "Other Income",
      source: "DOCUMENT_MATCH",
    });
    // `numeric` comes back from the driver as a string; a band derived from
    // `confidence >= 0.85` on a string is silently wrong.
    expect(stored!.confidence).toBe(0.95);
    expect(typeof stored!.confidence).toBe("number");
  });

  it("refreshes the same row rather than duplicating it", async () => {
    await repo.upsertRecommendation(upsertInput());
    await repo.upsertRecommendation(upsertInput({ reason: "Revised wording." }));

    const rows = await repo.listRecommendations(VERSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("Revised wording.");
  });

  it("NEVER reopens a decision somebody already made", async () => {
    // The single most important behaviour in the adapter. `status` and the
    // decision trail are absent from the conflict update set, so a settled row
    // keeps its decision through any number of regenerations.
    await repo.upsertRecommendation(upsertInput());
    const [first] = await repo.listRecommendations(VERSION);
    await repo.markRejected({ recommendationId: first!.id, userId: null, reason: "not correct" });

    await repo.upsertRecommendation(upsertInput({ reason: "Revised wording." }));

    const [after] = await repo.listRecommendations(VERSION);
    expect(after!.status).toBe("rejected");
    expect(after!.rejection_reason).toBe("not correct");
    // The advisory content still refreshed — only the decision is sticky.
    expect(after!.reason).toBe("Revised wording.");
  });

  it("keeps a different proposed rollup as its own recommendation", async () => {
    await repo.upsertRecommendation(upsertInput());
    await repo.upsertRecommendation(upsertInput({ recommendedRollup: "Other Expenses" }));
    expect(await repo.listRecommendations(VERSION)).toHaveLength(2);
  });

  it("is refused by the database when a RECLASSIFY carries no type", async () => {
    // The service already drops these, but the constraint is what makes it true
    // of every writer rather than of one code path.
    // Drizzle wraps the driver error, so the constraint name is on the cause.
    const err = await repo
      .upsertRecommendation(upsertInput({ kind: "RECLASSIFY" }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeTruthy();
    expect(JSON.stringify({ m: String(err), c: String((err as { cause?: unknown }).cause) }))
      .toContain("coa_reco_reclassify_type_check");
  });
});

describe("listRecommendations", () => {
  it("joins the account and orders by confidence", async () => {
    await repo.upsertRecommendation(upsertInput({ confidence: 0.5, confidenceBand: "LOW" }));
    await repo.upsertRecommendation(
      upsertInput({ recommendedRollup: "Other Expenses", confidence: 0.95 }),
    );

    const rows = await repo.listRecommendations(VERSION);

    expect(rows.map((r) => r.confidence)).toEqual([0.95, 0.5]);
    expect(rows[0]!.chart_of_accounts?.account_name).toBe("Interest Income");
    // Absent from this schema — reported rather than selected.
    expect(rows[0]!.chart_of_accounts?.system_id).toBeNull();
  });

  it("returns nothing for a version with no recommendations", async () => {
    expect(await repo.listRecommendations(VERSION)).toEqual([]);
  });
});

describe("countByStatus", () => {
  it("counts only the statuses asked for", async () => {
    await repo.upsertRecommendation(upsertInput());
    const [reco] = await repo.listRecommendations(VERSION);
    await repo.markApplied({
      recommendationId: reco!.id,
      userId: null,
      appliedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
    });

    expect(await repo.countByStatus(VERSION, ["applied", "accepted"])).toBe(1);
    expect(await repo.countByStatus(VERSION, ["rejected", "ignored"])).toBe(0);
    expect(await repo.countByStatus(VERSION, [])).toBe(0);
  });
});

describe("markRejected", () => {
  it("refuses to overwrite a decision already taken", async () => {
    // Two reviewers acting at once both read `pending`; the status predicate is
    // what stops the second from erasing the first one's reason.
    await repo.upsertRecommendation(upsertInput());
    const [reco] = await repo.listRecommendations(VERSION);

    await repo.markRejected({ recommendationId: reco!.id, userId: null, reason: "first" });
    await repo.markRejected({ recommendationId: reco!.id, userId: null, reason: "second" });

    const [after] = await repo.listRecommendations(VERSION);
    expect(after!.rejection_reason).toBe("first");
  });
});

describe("the service on the real adapter", () => {
  it("generates, stores and applies end to end", async () => {
    const hierarchy = createRecordingHierarchyWriter();
    const classifier = createStubClassifier([
      JSON.stringify({
        recommendations: [
          {
            id: ACCOUNT,
            kind: "HIERARCHY_MOVE",
            recommendedHierarchy: [
              "Net Income",
              "Pretax Income",
              "Other Income",
              "Interest Income",
            ],
            confidence: "HIGH",
            reason: "Interest income is non-operating.",
          },
        ],
      }),
      JSON.stringify({ recommendations: [] }),
    ]);
    const service = createCoaReviewService({ repo, classifier, hierarchy });

    const summary = await service.generateRecommendations(COMPANY, VERSION);
    expect(summary).toMatchObject({ accountsReviewed: 1, recommendations: 1, highConfidence: 1 });

    const [listed] = await service.listRecommendations(VERSION);
    expect(listed).toMatchObject({ status: "PENDING", confidenceBand: "HIGH" });

    const applied = await service.applyRecommendation(String(listed!.id), REVIEWER);
    expect(applied).toMatchObject({ ok: true, accountId: ACCOUNT });
    expect(hierarchy.writes[0]!.patch).toMatchObject({
      levels: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
    });

    const [after] = await service.listRecommendations(VERSION);
    expect(after!.status).toBe("APPLIED");
  });

  it("refuses to apply once the account has moved on", async () => {
    await repo.upsertRecommendation(upsertInput());
    const [reco] = await repo.listRecommendations(VERSION);

    // Somebody edits the account after the recommendation was generated.
    await pg.exec(
      `UPDATE chart_of_accounts SET level_2 = 'Pretax Income', level_3 = 'Other Income' WHERE id = '${ACCOUNT}';`,
    );

    const hierarchy = createRecordingHierarchyWriter();
    const service = createCoaReviewService({
      repo,
      classifier: createStubClassifier([]),
      hierarchy,
    });

    const result = await service.applyRecommendation(reco!.id, REVIEWER);

    expect(result).toMatchObject({ conflict: true, code: "STALE_RECOMMENDATION" });
    expect(hierarchy.writes).toHaveLength(0);
  });
});
