import type { CoaRow, StoredRecommendation } from "@datahub/financial-engine";

import type {
  CoaReviewRepository,
  ReasonablenessClassifier,
  HierarchyWriter,
  UpsertRecommendationInput,
  VersionCoa,
} from "./ports.js";

/**
 * In-memory adapters for the reasonableness review.
 *
 * These exist because the Drizzle adapter cannot be written yet:
 * `key_report_coa_hierarchy_recommendations` exists only on the `data_room`
 * deployment and is absent from `packages/db/schema-snapshot.sql`, so it needs
 * a migration before a real repository has a table to talk to.
 *
 * They are not a stopgap for the tests, though. The upsert semantics below are
 * the contract the real adapter has to satisfy, written down where a test can
 * check them — in particular that a re-run must NOT reopen a decision somebody
 * already made.
 */

/** Mirrors the store's uniqueness key: (version, account, recommended rollup). */
const upsertKey = (versionId: string, accountId: string, rollup: string): string =>
  `${versionId}::${accountId}::${rollup}`;

export interface MemoryRepoSeed {
  coa?: Partial<VersionCoa> & { rows?: CoaRow[] };
  recommendations?: StoredRecommendation[];
}

export function createMemoryCoaReviewRepository(seed: MemoryRepoSeed = {}) {
  const rows = seed.coa?.rows ?? [];
  const categories = seed.coa?.categories ?? rows.filter((r) => r.metadata?.is_group);
  const leaves = seed.coa?.leaves ?? rows.filter((r) => !r.metadata?.is_group);
  const reviewable =
    seed.coa?.reviewable ??
    leaves.filter((r) => !r.metadata?.user_modified && Boolean(r.account_type));

  const stored = new Map<string, StoredRecommendation>();
  const byKey = new Map<string, string>();
  for (const r of seed.recommendations ?? []) stored.set(r.id, { ...r });

  let nextId = stored.size + 1;
  const upserts: UpsertRecommendationInput[] = [];

  const repo: CoaReviewRepository & {
    /** Everything that was written, in order — for assertions. */
    upserts: UpsertRecommendationInput[];
    all(): StoredRecommendation[];
  } = {
    upserts,
    all: () => [...stored.values()],

    async loadVersionCoa(): Promise<VersionCoa> {
      return { rows, categories, leaves, reviewable };
    },

    async upsertRecommendation(input) {
      upserts.push(input);
      const key = upsertKey(input.versionId, input.accountId, input.recommendedRollup);
      const existingId = byKey.get(key);

      const record: StoredRecommendation = {
        id: existingId ?? `reco-${nextId++}`,
        account_id: input.accountId,
        current_hierarchy: input.currentHierarchy,
        current_account_type: input.currentAccountType,
        current_statement_type: input.currentStatementType,
        kind: input.kind,
        recommended_hierarchy: input.recommendedHierarchy,
        recommended_rollup: input.recommendedRollup,
        recommended_parent: input.recommendedParent,
        recommended_account_type: input.recommendedAccountType,
        recommended_statement_type: input.recommendedStatementType,
        confidence: input.confidence,
        confidence_band: input.confidenceBand,
        source: input.source,
        impact: input.impact,
        reason: input.reason,
        ai_model: input.aiModel,
      };

      if (existingId) {
        // The contract the real adapter must honour: `status` and the decision
        // columns are NOT among the fields a re-run updates, so a settled row
        // keeps its decision.
        const prev = stored.get(existingId)!;
        stored.set(existingId, {
          ...record,
          status: prev.status,
          rejection_reason: prev.rejection_reason,
          decided_at: prev.decided_at,
          decided_by: prev.decided_by,
          applied_at: prev.applied_at,
          created_at: prev.created_at,
        });
      } else {
        stored.set(record.id, { ...record, status: "pending" });
        byKey.set(key, record.id);
      }
    },

    async countByStatus(_versionId, statuses) {
      return [...stored.values()].filter((r) => statuses.includes(String(r.status))).length;
    },

    async listRecommendations() {
      return [...stored.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    },

    async getRecommendation(recommendationId) {
      return stored.get(recommendationId) ?? null;
    },

    async getAccount(accountId) {
      return rows.find((r) => r.id === accountId) ?? null;
    },

    async markApplied({ recommendationId, userId, appliedHierarchy }) {
      const row = stored.get(recommendationId);
      if (!row) return;
      stored.set(recommendationId, {
        ...row,
        status: "applied",
        decided_by: userId,
        applied_at: "stamped",
        decided_at: "stamped",
        current_hierarchy: row.current_hierarchy,
        recommended_hierarchy: row.recommended_hierarchy,
        // Recorded so a test can assert what was actually written.
        ...({ applied_hierarchy: appliedHierarchy } as Record<string, unknown>),
      });
    },

    async markRejected({ recommendationId, userId, reason }) {
      const row = stored.get(recommendationId);
      // Only a pending row may be rejected — a decision already taken is never
      // overwritten. The real adapter enforces this with `.in("status",
      // ["pending"])`.
      if (!row || row.status !== "pending") return;
      stored.set(recommendationId, {
        ...row,
        status: "rejected",
        rejection_reason: reason,
        decided_by: userId,
        decided_at: "stamped",
      });
    },
  };

  return repo;
}

/**
 * A classifier that returns whatever the test hands it.
 *
 * `responses` is consumed in order, one per batch. An `Error` entry is thrown
 * rather than returned, which is how a failing batch is simulated.
 */
export function createStubClassifier(
  responses: (string | Error)[],
  model = "stub-model",
): ReasonablenessClassifier & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    async review(prompt: string) {
      prompts.push(prompt);
      const next = responses[i++];
      if (next === undefined) throw new Error("no stub response configured");
      if (next instanceof Error) throw next;
      return { text: next, model };
    },
  };
}

/** Records writes so a test can assert the COA was — or was not — touched. */
export function createRecordingHierarchyWriter(): HierarchyWriter & {
  writes: { accountId: string; patch: unknown; userId: string | null }[];
} {
  const writes: { accountId: string; patch: unknown; userId: string | null }[] = [];
  return {
    writes,
    async updateAccountHierarchy(accountId, patch, userId) {
      writes.push({ accountId, patch, userId });
    },
  };
}
