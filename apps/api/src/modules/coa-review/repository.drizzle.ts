import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@datahub/db";
import { schema } from "@datahub/db";
import type { CoaRow, StoredRecommendation } from "@datahub/financial-engine";

import type { CoaReviewRepository, UpsertRecommendationInput, VersionCoa } from "./ports.js";

const { chartOfAccounts, coaRecommendations } = schema;

/**
 * Drizzle adapter for the reasonableness review.
 *
 * Mirrors `migrations/0005_coa_recommendations.sql`. Two things here are load
 * bearing and easy to get wrong; both are covered by
 * `coa-review.integration.test.ts` against the real schema.
 */

/** The number of flattened level columns `chart_of_accounts` carries. */
const MAX_LEVELS = 15;

/**
 * Drizzle's camelCase row to the snake_case shape the engine reads.
 *
 * Not a formality. `CoaRow` and every function over it use the database's own
 * column names, while Drizzle returns the model's property names — so a row
 * passed straight through has `accountType` where the engine looks for
 * `account_type`, and every check against it silently reads `undefined`. The
 * first version of this adapter did exactly that and reported zero reviewable
 * accounts on a chart of accounts that was entirely reviewable, with nothing
 * failing anywhere: the integration test is what found it.
 */
function toCoaRow(row: Record<string, unknown>): CoaRow {
  const out: Record<string, unknown> = {
    id: row.id,
    account_name: row.accountName ?? null,
    adjusted_name: row.adjustedName ?? null,
    base_account: row.baseAccount ?? null,
    account_number: row.accountNumber ?? null,
    account_type: row.accountType ?? null,
    statement_type: row.statementType ?? null,
    parent_account_id: row.parentAccountId ?? null,
    hierarchy_path: row.hierarchyPath ?? null,
    // Absent from this schema — see the note in `listRecommendations`.
    system_id: null,
    // jsonb arrives parsed from the driver, but a text column carrying JSON
    // would arrive as a string; the metadata flags decide whether an account is
    // reviewed at all, so a silent parse failure is not an acceptable outcome.
    metadata:
      typeof row.metadata === "string"
        ? (JSON.parse(row.metadata) as CoaRow["metadata"])
        : ((row.metadata ?? null) as CoaRow["metadata"]),
  };
  for (let i = 1; i <= MAX_LEVELS; i += 1) {
    out[`level_${i}`] = row[`level${i}`] ?? null;
  }
  return out as CoaRow;
}

export class DrizzleCoaReviewRepository implements CoaReviewRepository {
  constructor(private readonly db: Db) {}

  async loadVersionCoa(versionId: string): Promise<VersionCoa> {
    const found = await this.db
      .select()
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.versionId, versionId), eq(chartOfAccounts.isActive, true)));

    const rows = found.map((r) => toCoaRow(r as Record<string, unknown>));
    const categories = rows.filter((r) => r.metadata?.is_group);
    const leaves = rows.filter((r) => !r.metadata?.is_group);
    // A leaf somebody already customised is excluded: its hierarchy is
    // intentionally sticky, the same rule the COA generator applies on
    // regenerate. Categories are NOT filtered that way — they are the company's
    // own section structure, and what a recommendation must target.
    const reviewable = leaves.filter((r) => !r.metadata?.user_modified && Boolean(r.account_type));

    return { rows, categories, leaves, reviewable };
  }

  /**
   * Store one recommendation, conflicting on (version, account, rollup).
   *
   * `status` and the whole decision trail are deliberately absent from the
   * update set. On conflict Postgres updates only the columns named here, so a
   * row somebody has already applied or rejected keeps its decision — a fresh
   * pass can never silently reopen a settled one. That is the single most
   * important line in this file.
   */
  async upsertRecommendation(input: UpsertRecommendationInput): Promise<void> {
    const values = {
      versionId: input.versionId,
      companyId: input.companyId,
      accountId: input.accountId,
      currentHierarchy: input.currentHierarchy,
      currentAccountType: input.currentAccountType,
      currentStatementType: input.currentStatementType,
      kind: input.kind,
      recommendedHierarchy: input.recommendedHierarchy,
      recommendedRollup: input.recommendedRollup,
      recommendedParent: input.recommendedParent,
      recommendedAccountType: input.recommendedAccountType,
      recommendedStatementType: input.recommendedStatementType,
      confidence: String(input.confidence),
      confidenceBand: input.confidenceBand,
      source: input.source,
      impact: input.impact,
      reason: input.reason,
      aiModel: input.aiModel,
      updatedAt: new Date(),
    };

    await this.db
      .insert(coaRecommendations)
      .values(values)
      .onConflictDoUpdate({
        target: [
          coaRecommendations.versionId,
          coaRecommendations.accountId,
          coaRecommendations.recommendedRollup,
        ],
        set: {
          currentHierarchy: values.currentHierarchy,
          currentAccountType: values.currentAccountType,
          currentStatementType: values.currentStatementType,
          kind: values.kind,
          recommendedHierarchy: values.recommendedHierarchy,
          recommendedParent: values.recommendedParent,
          recommendedAccountType: values.recommendedAccountType,
          recommendedStatementType: values.recommendedStatementType,
          confidence: values.confidence,
          confidenceBand: values.confidenceBand,
          source: values.source,
          impact: values.impact,
          reason: values.reason,
          aiModel: values.aiModel,
          updatedAt: values.updatedAt,
        },
      });
  }

  async countByStatus(versionId: string, statuses: readonly string[]): Promise<number> {
    if (!statuses.length) return 0;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coaRecommendations)
      .where(
        and(
          eq(coaRecommendations.versionId, versionId),
          inArray(coaRecommendations.status, [...statuses]),
        ),
      );
    return row?.n ?? 0;
  }

  async listRecommendations(versionId: string): Promise<StoredRecommendation[]> {
    const rows = await this.db
      .select({
        reco: coaRecommendations,
        accountName: chartOfAccounts.accountName,
        adjustedName: chartOfAccounts.adjustedName,
        baseAccount: chartOfAccounts.baseAccount,
        accountNumber: chartOfAccounts.accountNumber,
      })
      .from(coaRecommendations)
      .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, coaRecommendations.accountId))
      .where(eq(coaRecommendations.versionId, versionId))
      .orderBy(desc(coaRecommendations.confidence));

    return rows.map(({ reco, accountName, adjustedName, baseAccount, accountNumber }) =>
      this.toStored(reco, {
        account_name: accountName,
        adjusted_name: adjustedName,
        base_account: baseAccount,
        // `chart_of_accounts.system_id` does not exist in this schema: legacy
        // migration 052 added it on the branch this feature came from, and
        // ba/rearch never took it. Reported as null rather than selected, which
        // the public shape already tolerates.
        system_id: null,
        account_number: accountNumber,
      }),
    );
  }

  async getRecommendation(recommendationId: string): Promise<StoredRecommendation | null> {
    const [row] = await this.db
      .select()
      .from(coaRecommendations)
      .where(eq(coaRecommendations.id, recommendationId));
    return row ? this.toStored(row) : null;
  }

  async getAccount(accountId: string): Promise<CoaRow | null> {
    const [row] = await this.db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, accountId));
    return row ? toCoaRow(row as Record<string, unknown>) : null;
  }

  async markApplied({
    recommendationId,
    userId,
    appliedHierarchy,
  }: {
    recommendationId: string;
    userId: string | null;
    appliedHierarchy: string[];
  }): Promise<void> {
    const now = new Date();
    await this.db
      .update(coaRecommendations)
      .set({
        status: "applied",
        decidedAt: now,
        decidedBy: userId,
        appliedAt: now,
        appliedHierarchy,
        updatedAt: now,
      })
      .where(eq(coaRecommendations.id, recommendationId));
  }

  /**
   * Only a pending row may be rejected.
   *
   * The status predicate is not redundant with the service's own check: two
   * reviewers acting at once would both read `pending` and both call this, and
   * without it the second would overwrite the first one's reason.
   */
  async markRejected({
    recommendationId,
    userId,
    reason,
  }: {
    recommendationId: string;
    userId: string | null;
    reason: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .update(coaRecommendations)
      .set({
        status: "rejected",
        rejectionReason: reason,
        decidedAt: now,
        decidedBy: userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(coaRecommendations.id, recommendationId),
          eq(coaRecommendations.status, "pending"),
        ),
      );
  }

  /** Drizzle's camelCase row back to the snake_case shape the engine reads. */
  private toStored(
    row: typeof coaRecommendations.$inferSelect,
    account?: StoredRecommendation["chart_of_accounts"],
  ): StoredRecommendation {
    return {
      id: row.id,
      account_id: row.accountId,
      current_hierarchy: row.currentHierarchy,
      current_account_type: row.currentAccountType,
      current_statement_type: row.currentStatementType,
      kind: row.kind,
      recommended_hierarchy: row.recommendedHierarchy,
      recommended_rollup: row.recommendedRollup,
      recommended_parent: row.recommendedParent,
      recommended_account_type: row.recommendedAccountType,
      recommended_statement_type: row.recommendedStatementType,
      // `numeric` arrives as a string; the engine compares and sorts it as a
      // number, and `confidence >= 0.85` on a string is a silently wrong band.
      confidence: row.confidence == null ? null : Number(row.confidence),
      confidence_band: row.confidenceBand,
      source: row.source,
      impact: row.impact,
      reason: row.reason,
      status: row.status,
      rejection_reason: row.rejectionReason,
      ai_model: row.aiModel,
      created_at: row.createdAt?.toISOString() ?? null,
      decided_at: row.decidedAt?.toISOString() ?? null,
      decided_by: row.decidedBy,
      applied_at: row.appliedAt?.toISOString() ?? null,
      ...(account ? { chart_of_accounts: account } : {}),
    };
  }
}
