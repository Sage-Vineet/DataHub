import {
  buildReasonablenessPrompt,
  buildSectionCatalog,
  buildSiblingIndex,
  classificationFingerprint,
  columnsToLevels,
  displayName,
  isMaterial,
  isSamePath,
  normalizeProposal,
  RECOMMENDATION_ACCOUNT_TYPES,
  RECOMMENDATION_STATEMENT_TYPES,
  resolveTargetLevels,
  toPublicRecommendation,
  toReviewInput,
  validateTargetLevels,
  type NormalizedProposal,
  type ReviewAccount,
} from "@datahub/financial-engine";

import type {
  ApplyResult,
  CoaReviewRepository,
  HierarchyWriter,
  ReasonablenessClassifier,
  ReviewSummary,
} from "./ports.js";

/**
 * Chart-of-accounts reasonableness review — orchestration.
 *
 * Ported from `aiHierarchyRecommendationService.js` on `data_room`. The
 * decision logic is in `@datahub/financial-engine`; this file is what calls it,
 * and it reaches the outside world only through the three ports.
 *
 * The behaviour worth keeping is the fail-soft contract and the staleness gate,
 * and neither was testable in the original because the model and the database
 * were required directly.
 */

/**
 * Smaller than the original engine's 40: each account now carries real context
 * (number, system id, siblings, section), so the prompt is denser per row.
 */
const BATCH_SIZE = 25;

/** Parse the model's response, tolerating the markdown fence it often adds. */
export function parseJsonFromText(text = ""): unknown {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export interface CoaReviewDeps {
  repo: CoaReviewRepository;
  classifier: ReasonablenessClassifier;
  hierarchy: HierarchyWriter;
  /** Injected so a test can assert the recorded timestamps. */
  now?: () => Date;
  logger?: { warn: (msg: string) => void };
}

export function createCoaReviewService({
  repo,
  classifier,
  hierarchy,
  now = () => new Date(),
  logger = { warn: () => {} },
}: CoaReviewDeps) {
  /**
   * Analyse a fully-generated chart of accounts and store recommendations.
   * Never writes to `chart_of_accounts`.
   *
   * Fail-soft by contract: any failure — no model, the model down, a bad batch,
   * a malformed response — leaves the COA and every downstream report entirely
   * unaffected. "COA generated successfully, reasonableness check unavailable"
   * is a valid state, and the caller logs and carries on.
   */
  async function generateRecommendations(
    companyId: string,
    versionId: string,
  ): Promise<ReviewSummary> {
    const summary: ReviewSummary = {
      accountsReviewed: 0,
      recommendations: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      applied: 0,
      rejected: 0,
      aiUnavailable: false,
    };

    const { categories, leaves, reviewable } = await repo.loadVersionCoa(versionId);
    const sections = buildSectionCatalog(categories);
    const siblingIndex = buildSiblingIndex(leaves);

    const reviewInput = reviewable
      .map((r) => toReviewInput(r, siblingIndex))
      // Need at least [parent, ownName] for "is this placed correctly" to mean
      // anything at all.
      .filter((r) => r.hierarchy.length >= 2);
    summary.accountsReviewed = reviewInput.length;

    if (!reviewInput.length) return summary;

    const byId = new Map(reviewInput.map((r) => [r.id, r]));
    const proposals: { proposal: NormalizedProposal; account: ReviewAccount }[] = [];
    let modelUsed: string | null = null;
    let batchesAttempted = 0;
    let batchesFailed = 0;

    // Batched per statement type so each prompt carries the section catalog
    // that is actually relevant to the accounts in it.
    for (const statementType of ["profit_loss", "balance_sheet"] as const) {
      const scoped = reviewInput.filter((r) => r.statementType === statementType);
      const sectionPaths = sections[statementType] ?? [];

      for (let i = 0; i < scoped.length; i += BATCH_SIZE) {
        const batch = scoped.slice(i, i + BATCH_SIZE);
        batchesAttempted += 1;
        try {
          const { text, model } = await classifier.review(
            buildReasonablenessPrompt(batch, sectionPaths, statementType),
          );
          modelUsed = model;
          const parsed = parseJsonFromText(text) as { recommendations?: unknown };
          const rows = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
          for (const raw of rows as Record<string, unknown>[]) {
            const account = byId.get(String(raw?.id ?? "").trim());
            if (!account) continue;
            const proposal = normalizeProposal(raw, account, sectionPaths);
            if (proposal && isMaterial(proposal)) proposals.push({ proposal, account });
          }
        } catch (err) {
          batchesFailed += 1;
          logger.warn(
            `[CoaReview] ${statementType} batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${
              (err as Error).message
            }`,
          );
        }
      }
    }

    // Every batch failing is the model being unavailable. Some failing is a bad
    // batch, which is not the same thing and must not be reported as one.
    if (batchesAttempted > 0 && batchesFailed === batchesAttempted) summary.aiUnavailable = true;

    for (const { proposal, account } of proposals) {
      try {
        await repo.upsertRecommendation({
          ...proposal,
          versionId,
          companyId,
          currentHierarchy: account.hierarchy,
          currentAccountType: account.accountType,
          currentStatementType: account.statementType,
          aiModel: modelUsed,
        });
      } catch (err) {
        logger.warn(
          `[CoaReview] Failed to store recommendation for account ${proposal.accountId}: ${
            (err as Error).message
          }`,
        );
        continue;
      }
      summary.recommendations += 1;
      if (proposal.confidenceBand === "HIGH") summary.highConfidence += 1;
      else if (proposal.confidenceBand === "MEDIUM") summary.mediumConfidence += 1;
      else summary.lowConfidence += 1;
    }

    summary.applied = await repo.countByStatus(versionId, ["applied", "accepted"]);
    summary.rejected = await repo.countByStatus(versionId, ["rejected", "ignored"]);
    return summary;
  }

  async function listRecommendations(versionId: string): Promise<Record<string, unknown>[]> {
    const rows = await repo.listRecommendations(versionId);
    return rows.map(toPublicRecommendation);
  }

  /**
   * Apply ONE recommendation — the only place this feature touches
   * `chart_of_accounts`, and it does so exclusively through the
   * `HierarchyWriter` port.
   *
   * Refuses to apply a STALE recommendation: if the account's classification
   * has changed since the recommendation was generated, the stored proposal was
   * reasoned about a chart of accounts that no longer exists and could silently
   * undo a newer edit. Those return a conflict for regeneration instead.
   */
  async function applyRecommendation(
    recommendationId: string,
    userId: string | null = null,
  ): Promise<ApplyResult> {
    const reco = await repo.getRecommendation(recommendationId);
    if (!reco) {
      return {
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        message: "This recommendation no longer exists.",
      };
    }

    if (reco.status === "applied" || reco.status === "accepted") {
      return { ok: true, alreadyApplied: true, accountId: reco.account_id };
    }
    if (reco.status === "rejected" || reco.status === "ignored") {
      return {
        ok: false,
        code: "ALREADY_REJECTED",
        message: "This recommendation was already rejected.",
      };
    }

    const account = await repo.getAccount(reco.account_id);
    if (!account) {
      return {
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        message: "The account this recommendation refers to no longer exists.",
      };
    }

    const currentLevels = columnsToLevels(account);
    if (!currentLevels.length) {
      return {
        ok: false,
        code: "NO_HIERARCHY",
        message: "The account has no current hierarchy to modify.",
      };
    }

    // The staleness gate. Compare the account as it is NOW against the snapshot
    // taken when the recommendation was generated; any drift means a regenerate
    // or a user edit has moved on, and this proposal must not be applied blind.
    if (Array.isArray(reco.current_hierarchy) && reco.current_hierarchy.length) {
      const before = classificationFingerprint({
        hierarchy: reco.current_hierarchy,
        accountType: reco.current_account_type || account.account_type,
        statementType: reco.current_statement_type || account.statement_type,
      });
      const after = classificationFingerprint({
        hierarchy: currentLevels,
        accountType: account.account_type,
        statementType: account.statement_type,
      });
      if (before !== after) {
        return {
          ok: false,
          conflict: true,
          code: "STALE_RECOMMENDATION",
          message:
            "This account has changed since the recommendation was generated. Re-run the reasonableness check to get an up-to-date recommendation.",
          currentHierarchy: currentLevels,
          recommendedFor: reco.current_hierarchy,
        };
      }
    }

    const ownName = displayName(account);
    const targetLevels = resolveTargetLevels(reco, currentLevels, ownName);
    const problems = validateTargetLevels(targetLevels, ownName);
    if (problems.length) {
      return { ok: false, code: "UNSAFE_RECOMMENDATION", message: problems.join(" ") };
    }

    if (isSamePath(targetLevels, currentLevels) && !reco.recommended_account_type) {
      // Nothing to do — record the decision without a pointless write.
      await repo.markApplied({ recommendationId, userId, appliedHierarchy: currentLevels });
      return { ok: true, noChange: true, accountId: reco.account_id, newLevels: currentLevels };
    }

    const patch: Parameters<HierarchyWriter["updateAccountHierarchy"]>[1] = {
      levels: targetLevels,
      movedParent: true,
    };
    if (
      reco.kind === "RECLASSIFY" &&
      reco.recommended_account_type &&
      RECOMMENDATION_ACCOUNT_TYPES.has(reco.recommended_account_type)
    ) {
      patch.accountType = reco.recommended_account_type;
      if (
        reco.recommended_statement_type &&
        RECOMMENDATION_STATEMENT_TYPES.has(reco.recommended_statement_type)
      ) {
        patch.statementType = reco.recommended_statement_type;
      }
    }

    await hierarchy.updateAccountHierarchy(reco.account_id, patch, userId);
    await repo.markApplied({ recommendationId, userId, appliedHierarchy: targetLevels });

    return { ok: true, accountId: reco.account_id, newLevels: targetLevels, kind: reco.kind };
  }

  /**
   * The original contract was "resolves on success, throws otherwise". Kept
   * recognisable, while surfacing the conflict information the staleness gate
   * now produces.
   */
  async function acceptRecommendation(recommendationId: string, userId: string | null = null) {
    const result = await applyRecommendation(recommendationId, userId);
    if (!result.ok) {
      const err = new Error(result.message || "Could not apply this recommendation.") as Error & {
        code?: string;
        conflict?: boolean;
      };
      err.code = result.code;
      err.conflict = Boolean(result.conflict);
      throw err;
    }
    return {
      alreadyAccepted: Boolean(result.alreadyApplied),
      accountId: result.accountId,
      newLevels: result.newLevels,
    };
  }

  /** Reject — the COA is left completely unchanged; only the decision is stored. */
  async function rejectRecommendation(
    recommendationId: string,
    userId: string | null = null,
    reason: string | null = null,
  ): Promise<{ ok: true }> {
    await repo.markRejected({
      recommendationId,
      userId,
      reason: String(reason ?? "").trim() || null,
    });
    return { ok: true };
  }

  return {
    generateRecommendations,
    listRecommendations,
    applyRecommendation,
    acceptRecommendation,
    rejectRecommendation,
    /** Backwards-compatible alias for the original route and hook. */
    ignoreRecommendation: rejectRecommendation,
    /** Exposed so a caller can stamp its own audit rows consistently. */
    now,
  };
}

export type CoaReviewService = ReturnType<typeof createCoaReviewService>;
