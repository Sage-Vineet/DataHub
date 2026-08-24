import { describe, expect, it } from "vitest";
import type { CoaRow, StoredRecommendation } from "@datahub/financial-engine";

import {
  createMemoryCoaReviewRepository,
  createRecordingHierarchyWriter,
  createStubClassifier,
} from "./repository.memory.js";
import { createCoaReviewService, parseJsonFromText } from "./service.js";

/**
 * The orchestration around the reasonableness review.
 *
 * This is the half the original could not test. `aiHierarchyRecommendationService.js`
 * required `@google/generative-ai`, `supabase` and the COA service directly, so
 * its 43 tests could only reach the pure helpers it exported for the purpose —
 * and the untested remainder is where the consequences live: the fail-soft
 * contract that keeps a model outage from breaking chart-of-accounts
 * generation, the upsert that must not reopen a settled decision, and the
 * staleness gate that stops an old proposal overwriting a newer edit.
 *
 * With the three ports those are all reachable, with no database and no model.
 */

const leaf = (over: Partial<CoaRow> = {}): CoaRow => ({
  id: "acc-1",
  account_name: "Interest Income",
  account_type: "income",
  statement_type: "profit_loss",
  parent_account_id: "cat-1",
  level_1: "Net Income",
  level_2: "Total Revenue",
  level_3: "Income",
  level_4: "Interest Income",
  metadata: {},
  ...over,
});

const category = (over: Partial<CoaRow> = {}): CoaRow => ({
  id: "cat-2",
  account_name: "Other Income",
  statement_type: "profit_loss",
  level_1: "Net Income",
  level_2: "Pretax Income",
  level_3: "Other Income",
  metadata: { is_group: true },
  ...over,
});

const modelAnswer = (recommendations: unknown[]) => JSON.stringify({ recommendations });

const moveProposal = {
  id: "acc-1",
  kind: "HIERARCHY_MOVE",
  recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
  confidence: "HIGH",
  reason: "Interest income is non-operating.",
};

function build(seed: Parameters<typeof createMemoryCoaReviewRepository>[0], responses: (string | Error)[]) {
  const repo = createMemoryCoaReviewRepository(seed);
  const classifier = createStubClassifier(responses);
  const hierarchy = createRecordingHierarchyWriter();
  const service = createCoaReviewService({ repo, classifier, hierarchy });
  return { repo, classifier, hierarchy, service };
}

describe("parseJsonFromText", () => {
  it("tolerates the markdown fence models add unbidden", () => {
    expect(parseJsonFromText('```json\n{"recommendations":[]}\n```')).toEqual({
      recommendations: [],
    });
    expect(parseJsonFromText('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
  });

  it("throws on something that is not JSON at all", () => {
    // Deliberately not caught here: the caller treats a bad batch as a failed
    // batch, which is what keeps one malformed answer from being mistaken for
    // "the model had no recommendations".
    expect(() => parseJsonFromText("I'm afraid I can't do that")).toThrow();
  });
});

describe("generateRecommendations", () => {
  it("stores a material recommendation and counts it by band", async () => {
    const { repo, service } = build(
      { coa: { rows: [leaf(), category()] } },
      [modelAnswer([moveProposal]), modelAnswer([])],
    );

    const summary = await service.generateRecommendations("co-1", "ver-1");

    expect(summary.accountsReviewed).toBe(1);
    expect(summary.recommendations).toBe(1);
    expect(summary.highConfidence).toBe(1);
    expect(summary.mediumConfidence).toBe(0);
    expect(summary.lowConfidence).toBe(0);
    expect(summary.aiUnavailable).toBe(false);
    expect(repo.upserts[0]!.recommendedRollup).toBe("Other Income");
    // The snapshot of what the account looked like when reviewed — the input to
    // the staleness gate later.
    expect(repo.upserts[0]!.currentHierarchy).toEqual([
      "Net Income",
      "Total Revenue",
      "Income",
      "Interest Income",
    ]);
  });

  it("does not un-reject an account a reviewer already decided on", async () => {
    /**
     * Re-running classification over a chart somebody has already worked
     * through is the ordinary case — a new period arrives and the whole thing
     * is re-read. Every settled row would come back as `pending` if the
     * re-run overwrote status, and the reviewer would be handed their own
     * rejections again with nothing saying they had seen them.
     *
     * Worse for an APPLIED row: it is already reflected in the chart, so
     * offering it again invites applying it twice.
     */
    const { repo, service } = build(
      { coa: { rows: [leaf(), category()] } },
      // One batch per run: only the profit-and-loss accounts are reviewable
      // here, so the balance-sheet pass issues no prompt at all.
      [modelAnswer([moveProposal]), modelAnswer([moveProposal])],
    );

    await service.generateRecommendations("co-1", "ver-1");
    const first = repo.all()[0]!;
    await service.rejectRecommendation(String(first.id), "user-1", "presentation is fine");

    await service.generateRecommendations("co-1", "ver-1");

    // Proves the re-run actually reached the write. Without this the test
    // passes when the second run proposes nothing at all, which is how it read
    // when it was first written.
    expect(repo.upserts).toHaveLength(2);

    const after = repo.all();
    expect(after).toHaveLength(1); // matched, not duplicated
    expect(after[0]).toMatchObject({
      status: "rejected",
      rejection_reason: "presentation is fine",
      decided_by: "user-1",
    });
  });

  it("refreshes the recommendation itself while keeping the decision", async () => {
    // The decision is preserved; the model's latest reasoning is not frozen
    // with it, so a reviewer reopening a rejected row sees what the model says
    // now rather than what it said the first time.
    const { repo, service } = build(
      { coa: { rows: [leaf(), category()] } },
      [
        modelAnswer([moveProposal]),
        modelAnswer([{ ...moveProposal, reason: "A second look, with more detail." }]),
      ],
    );

    await service.generateRecommendations("co-1", "ver-1");
    await service.rejectRecommendation(String(repo.all()[0]!.id), "user-1", null);
    await service.generateRecommendations("co-1", "ver-1");

    expect(repo.all()[0]).toMatchObject({
      status: "rejected",
      reason: "A second look, with more detail.",
    });
  });

  it("batches per statement type so each prompt carries the right sections", async () => {
    const { classifier, service } = build(
      {
        coa: {
          rows: [
            leaf(),
            leaf({ id: "acc-2", account_name: "Cash", statement_type: "balance_sheet" }),
            category(),
            category({
              id: "cat-3",
              statement_type: "balance_sheet",
              level_1: "Balance Sheet",
              level_2: "Assets",
              level_3: undefined,
            }),
          ],
        },
      },
      [modelAnswer([]), modelAnswer([])],
    );

    await service.generateRecommendations("co-1", "ver-1");

    expect(classifier.prompts).toHaveLength(2);
    expect(classifier.prompts[0]).toContain("PROFIT & LOSS SECTIONS");
    expect(classifier.prompts[0]).toContain("Net Income > Pretax Income > Other Income");
    expect(classifier.prompts[1]).toContain("BALANCE SHEET SECTIONS");
    // The P&L catalog must not leak into the balance-sheet prompt.
    expect(classifier.prompts[1]).not.toContain("Pretax Income");
  });

  it("never calls the model when nothing is reviewable", async () => {
    const { classifier, service } = build({ coa: { rows: [] } }, []);

    const summary = await service.generateRecommendations("co-1", "ver-1");

    expect(summary.accountsReviewed).toBe(0);
    expect(classifier.prompts).toHaveLength(0);
  });

  it("skips a leaf somebody already customised", async () => {
    // Its hierarchy is intentionally sticky — the same rule the generator
    // applies on regenerate.
    const { service } = build(
      { coa: { rows: [leaf({ metadata: { user_modified: true } }), category()] } },
      [],
    );
    expect((await service.generateRecommendations("co-1", "ver-1")).accountsReviewed).toBe(0);
  });

  it("skips an account too shallow for the question to mean anything", async () => {
    // Without at least [parent, ownName] there is no placement to assess.
    const shallow = leaf({ level_2: undefined, level_3: undefined, level_4: undefined });
    const { service } = build({ coa: { rows: [shallow] } }, []);
    expect((await service.generateRecommendations("co-1", "ver-1")).accountsReviewed).toBe(0);
  });

  describe("the fail-soft contract", () => {
    it("returns a summary instead of throwing when every batch fails", async () => {
      const { repo, service } = build({ coa: { rows: [leaf(), category()] } }, [
        new Error("503 model unavailable"),
      ]);

      const summary = await service.generateRecommendations("co-1", "ver-1");

      // The whole point: COA generation carries on. "Generated successfully,
      // reasonableness check unavailable" is a valid state.
      expect(summary.aiUnavailable).toBe(true);
      expect(summary.recommendations).toBe(0);
      expect(repo.upserts).toHaveLength(0);
    });

    it("does NOT report the model unavailable when only some batches failed", async () => {
      const { service } = build(
        {
          coa: {
            rows: [
              leaf(),
              leaf({ id: "acc-2", account_name: "Cash", statement_type: "balance_sheet" }),
              category(),
            ],
          },
        },
        [new Error("one bad batch"), modelAnswer([])],
      );

      const summary = await service.generateRecommendations("co-1", "ver-1");

      // A bad batch and an outage are different things, and conflating them
      // would hide a real failure behind an expected one.
      expect(summary.aiUnavailable).toBe(false);
    });

    it("survives a malformed response without losing the rest of the run", async () => {
      const { service } = build(
        {
          coa: {
            rows: [
              leaf(),
              leaf({ id: "acc-2", account_name: "Cash", statement_type: "balance_sheet" }),
              category(),
            ],
          },
        },
        ["not json at all", modelAnswer([])],
      );

      const summary = await service.generateRecommendations("co-1", "ver-1");
      expect(summary.recommendations).toBe(0);
      expect(summary.aiUnavailable).toBe(false);
    });

    it("ignores a proposal about an account that was never sent", async () => {
      const { repo, service } = build({ coa: { rows: [leaf(), category()] } }, [
        modelAnswer([{ ...moveProposal, id: "hallucinated-id" }]),
        modelAnswer([]),
      ]);

      await service.generateRecommendations("co-1", "ver-1");
      expect(repo.upserts).toHaveLength(0);
    });

    it("carries on when the store rejects one recommendation", async () => {
      const { repo, service } = build({ coa: { rows: [leaf(), category()] } }, [
        modelAnswer([moveProposal]),
        modelAnswer([]),
      ]);
      repo.upsertRecommendation = async () => {
        throw new Error("unique violation");
      };

      const summary = await service.generateRecommendations("co-1", "ver-1");
      expect(summary.recommendations).toBe(0);
    });
  });

  it("counts each confidence band separately", async () => {
    // MEDIUM and LOW have their own counters, and a band miscounted here is a
    // review queue that misrepresents how much of itself is guesswork.
    const { service } = build(
      {
        coa: {
          rows: [
            leaf(),
            leaf({ id: "acc-2", account_name: "Bank Fees", level_4: "Bank Fees" }),
            category(),
          ],
        },
      },
      [
        modelAnswer([
          { ...moveProposal, confidence: "MEDIUM" },
          {
            ...moveProposal,
            id: "acc-2",
            kind: "RECLASSIFY",
            recommendedHierarchy: ["Balance Sheet", "Assets", "Bank Fees"],
            recommendedAccountType: "asset",
            confidence: "LOW",
          },
        ]),
        modelAnswer([]),
      ],
    );

    const summary = await service.generateRecommendations("co-1", "ver-1");

    expect(summary.mediumConfidence).toBe(1);
    // A LOW RECLASSIFY survives materiality because it changes which statement
    // the number appears on.
    expect(summary.lowConfidence).toBe(1);
  });

  it("a re-run never reopens a decision somebody already made", async () => {
    const { repo, service } = build({ coa: { rows: [leaf(), category()] } }, [
      modelAnswer([moveProposal]),
      modelAnswer([]),
      modelAnswer([moveProposal]),
      modelAnswer([]),
    ]);

    await service.generateRecommendations("co-1", "ver-1");
    const [stored] = repo.all();
    await repo.markRejected({ recommendationId: stored!.id, userId: "u1", reason: "not correct" });

    // Same proposal, second pass, same uniqueness key.
    await service.generateRecommendations("co-1", "ver-1");

    const after = repo.all();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("rejected");
    expect(after[0]!.rejection_reason).toBe("not correct");
  });
});

describe("applyRecommendation", () => {
  const storedReco = (over: Partial<StoredRecommendation> = {}): StoredRecommendation => ({
    id: "reco-1",
    account_id: "acc-1",
    status: "pending",
    kind: "HIERARCHY_MOVE",
    current_hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
    current_account_type: "income",
    current_statement_type: "profit_loss",
    recommended_hierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
    recommended_rollup: "Other Income",
    ...over,
  });

  it("writes the recommended hierarchy through the one permitted path", async () => {
    const { hierarchy, repo, service } = build(
      { coa: { rows: [leaf()] }, recommendations: [storedReco()] },
      [],
    );

    const result = await service.applyRecommendation("reco-1", "user-1");

    expect(result).toMatchObject({ ok: true, accountId: "acc-1" });
    expect(hierarchy.writes).toHaveLength(1);
    expect(hierarchy.writes[0]).toMatchObject({
      accountId: "acc-1",
      userId: "user-1",
      patch: {
        levels: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
        movedParent: true,
      },
    });
    expect(repo.all()[0]!.status).toBe("applied");
  });

  it("carries the target type on a RECLASSIFY, and only then", async () => {
    const { hierarchy, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [
          storedReco({
            kind: "RECLASSIFY",
            recommended_account_type: "equity",
            recommended_statement_type: "balance_sheet",
          }),
        ],
      },
      [],
    );

    await service.applyRecommendation("reco-1", "user-1");

    expect(hierarchy.writes[0]!.patch).toMatchObject({
      accountType: "equity",
      statementType: "balance_sheet",
    });
  });

  it("ignores a target type outside the closed set", async () => {
    const { hierarchy, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [
          storedReco({ kind: "RECLASSIFY", recommended_account_type: "nonsense" }),
        ],
      },
      [],
    );

    await service.applyRecommendation("reco-1", "user-1");
    expect(hierarchy.writes[0]!.patch).not.toHaveProperty("accountType");
  });

  describe("the staleness gate", () => {
    it("refuses to apply when the account has changed since generation", async () => {
      // The account has since moved; the stored proposal was reasoned about a
      // chart of accounts that no longer exists.
      const moved = leaf({ level_2: "Pretax Income", level_3: "Other Income" });
      const { hierarchy, service } = build(
        { coa: { rows: [moved] }, recommendations: [storedReco()] },
        [],
      );

      const result = await service.applyRecommendation("reco-1", "user-1");

      expect(result).toMatchObject({ ok: false, conflict: true, code: "STALE_RECOMMENDATION" });
      // Nothing was written — that is the point of the gate.
      expect(hierarchy.writes).toHaveLength(0);
    });

    it("detects a type change as staleness, not just a hierarchy change", async () => {
      const retyped = leaf({ account_type: "equity" });
      const { service } = build(
        { coa: { rows: [retyped] }, recommendations: [storedReco()] },
        [],
      );
      expect(await service.applyRecommendation("reco-1")).toMatchObject({
        code: "STALE_RECOMMENDATION",
      });
    });

    it("does not treat a casing difference as staleness", async () => {
      const recased = leaf({ level_2: "TOTAL REVENUE" });
      const { service } = build(
        { coa: { rows: [recased] }, recommendations: [storedReco()] },
        [],
      );
      expect(await service.applyRecommendation("reco-1")).toMatchObject({ ok: true });
    });
  });

  it("refuses an unsafe target before writing anything", async () => {
    const { hierarchy, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [
          storedReco({ recommended_hierarchy: ["Net Income", "Something Else"] }),
        ],
      },
      [],
    );

    const result = await service.applyRecommendation("reco-1");

    expect(result).toMatchObject({ ok: false, code: "UNSAFE_RECOMMENDATION" });
    expect(hierarchy.writes).toHaveLength(0);
  });

  it("records a no-change decision without a pointless write", async () => {
    const { hierarchy, repo, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [
          storedReco({
            recommended_hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
          }),
        ],
      },
      [],
    );

    const result = await service.applyRecommendation("reco-1");

    expect(result).toMatchObject({ ok: true, noChange: true });
    expect(hierarchy.writes).toHaveLength(0);
    expect(repo.all()[0]!.status).toBe("applied");
  });

  it("is idempotent for an already-applied recommendation", async () => {
    const { hierarchy, service } = build(
      { coa: { rows: [leaf()] }, recommendations: [storedReco({ status: "applied" })] },
      [],
    );

    expect(await service.applyRecommendation("reco-1")).toMatchObject({
      ok: true,
      alreadyApplied: true,
    });
    expect(hierarchy.writes).toHaveLength(0);
  });

  it("refuses a recommendation that was already rejected", async () => {
    const { service } = build(
      { coa: { rows: [leaf()] }, recommendations: [storedReco({ status: "rejected" })] },
      [],
    );
    expect(await service.applyRecommendation("reco-1")).toMatchObject({
      ok: false,
      code: "ALREADY_REJECTED",
    });
  });

  it("reports a recommendation that no longer exists", async () => {
    const { hierarchy, service } = build({ coa: { rows: [leaf()] } }, []);
    expect(await service.applyRecommendation("gone")).toMatchObject({
      ok: false,
      code: "ACCOUNT_NOT_FOUND",
    });
    expect(hierarchy.writes).toHaveLength(0);
  });

  it("reports a missing account rather than writing blind", async () => {
    const { service } = build(
      { coa: { rows: [] }, recommendations: [storedReco()] },
      [],
    );
    expect(await service.applyRecommendation("reco-1")).toMatchObject({
      ok: false,
      code: "ACCOUNT_NOT_FOUND",
    });
  });

  it("reports an account with no hierarchy to modify", async () => {
    const bare = leaf({ level_1: undefined, level_2: undefined, level_3: undefined, level_4: undefined });
    const { service } = build(
      { coa: { rows: [bare] }, recommendations: [storedReco()] },
      [],
    );
    expect(await service.applyRecommendation("reco-1")).toMatchObject({
      ok: false,
      code: "NO_HIERARCHY",
    });
  });
});

describe("acceptRecommendation keeps the original throwing contract", () => {
  it("resolves on success", async () => {
    const { service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [
          {
            id: "reco-1",
            account_id: "acc-1",
            status: "pending",
            recommended_hierarchy: [
              "Net Income",
              "Pretax Income",
              "Other Income",
              "Interest Income",
            ],
            recommended_rollup: "Other Income",
          },
        ],
      },
      [],
    );
    await expect(service.acceptRecommendation("reco-1", "u1")).resolves.toMatchObject({
      accountId: "acc-1",
    });
  });

  it("throws with the conflict flag a route needs to answer 409", async () => {
    const moved = leaf({ level_2: "Pretax Income", level_3: "Other Income" });
    const { service } = build(
      {
        coa: { rows: [moved] },
        recommendations: [
          {
            id: "reco-1",
            account_id: "acc-1",
            status: "pending",
            current_hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
            recommended_hierarchy: ["Net Income", "X", "Interest Income"],
            recommended_rollup: "X",
          },
        ],
      },
      [],
    );

    await expect(service.acceptRecommendation("reco-1")).rejects.toMatchObject({
      code: "STALE_RECOMMENDATION",
      conflict: true,
    });
  });
});

describe("deciding on a recommendation that is not there", () => {
  /**
   * Both take an id from a URL, so a recommendation removed by a re-run
   * between a page loading and a button being pressed lands here. Neither may
   * throw from the store — the service above them turns a missing row into an
   * answer a person can read.
   */
  it("does nothing rather than failing", async () => {
    const { repo, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [{ id: "reco-1", account_id: "acc-1", status: "pending" }],
      },
      [],
    );

    await expect(service.rejectRecommendation("nope", "user-1", null)).resolves.toBeDefined();
    expect(repo.all()[0]!.status).toBe("pending");
  });

  it("does not overwrite a decision already taken", async () => {
    // Rejecting an applied recommendation would leave the chart carrying a
    // move the record says was refused.
    const { repo, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [{ id: "reco-1", account_id: "acc-1", status: "applied" }],
      },
      [],
    );

    await service.rejectRecommendation("reco-1", "user-2", "changed my mind");

    expect(repo.all()[0]).toMatchObject({ status: "applied" });
  });
});

describe("rejecting a recommendation", () => {
  it("writes only to the recommendation row, never to the chart of accounts", async () => {
    const { hierarchy, repo, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [{ id: "reco-1", account_id: "acc-1", status: "pending" }],
      },
      [],
    );

    await service.rejectRecommendation("reco-1", "user-1", "  presentation is fine  ");

    expect(hierarchy.writes).toHaveLength(0);
    expect(repo.all()[0]).toMatchObject({
      status: "rejected",
      rejection_reason: "presentation is fine",
      decided_by: "user-1",
    });
  });

  it("stores no reason rather than an empty string", async () => {
    const { repo, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [{ id: "reco-1", account_id: "acc-1", status: "pending" }],
      },
      [],
    );
    await service.rejectRecommendation("reco-1", "user-1", "   ");
    expect(repo.all()[0]!.rejection_reason).toBeNull();
  });

  it("stores no reason when the caller gives none at all", async () => {
    // The route makes the reason optional, so this is the ordinary path from a
    // reviewer who clicked reject without typing anything.
    const { repo, service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [{ id: "reco-1", account_id: "acc-1", status: "pending" }],
      },
      [],
    );
    await service.rejectRecommendation("reco-1", "user-1");
    expect(repo.all()[0]).toMatchObject({ status: "rejected", rejection_reason: null });
  });

  it("is the same operation as the legacy ignore alias", async () => {
    const { service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [{ id: "reco-1", account_id: "acc-1", status: "pending" }],
      },
      [],
    );
    expect(service.ignoreRecommendation).toBe(service.rejectRecommendation);
  });
});

describe("listRecommendations", () => {
  it("returns the public shape, most confident first", async () => {
    const { service } = build(
      {
        coa: { rows: [leaf()] },
        recommendations: [
          { id: "r-low", account_id: "acc-1", status: "pending", confidence: 0.5 },
          { id: "r-high", account_id: "acc-1", status: "accepted", confidence: 0.95 },
        ],
      },
      [],
    );

    const list = await service.listRecommendations("ver-1");

    expect(list.map((r) => r.id)).toEqual(["r-high", "r-low"]);
    expect(list[0]!.status).toBe("APPLIED"); // legacy "accepted" surfaces as APPLIED
    expect(list[1]!.confidenceBand).toBe("LOW");
  });
});
