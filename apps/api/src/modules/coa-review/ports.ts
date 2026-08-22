import type {
  CoaRow,
  NormalizedProposal,
  StoredRecommendation,
} from "@datahub/financial-engine";

/**
 * Ports for the chart-of-accounts reasonableness review.
 *
 * The decision logic lives in `@datahub/financial-engine/coa-recommendation`
 * and is pure. Everything that touches the outside world — a language model, a
 * database, the one function allowed to write a hierarchy — is behind one of
 * the three interfaces below, so the service can be exercised end to end
 * without either.
 *
 * That split is not decoration. The original
 * (`aiHierarchyRecommendationService.js` on `data_room`) reached for
 * `@google/generative-ai`, `supabase` and a lazy `require` of the 6,800-line
 * COA service directly, which is why its 43 tests could only ever cover the
 * pure helpers it exported for the purpose: the orchestration around them —
 * batching, the fail-soft contract, the staleness gate, the apply path — was
 * unreachable from a test. Those are the parts that decide whether a wrong
 * answer reaches the chart of accounts.
 */

/** The chart of accounts for one version, already split by role. */
export interface VersionCoa {
  rows: CoaRow[];
  /** Document-driven `is_group` nodes — the sections a recommendation targets. */
  categories: CoaRow[];
  /** Posting accounts. */
  leaves: CoaRow[];
  /**
   * The leaves eligible for review.
   *
   * Excludes any leaf a person — or a previously applied recommendation —
   * already customised: its hierarchy is intentionally sticky, the same rule
   * the COA generator applies on regenerate.
   */
  reviewable: CoaRow[];
}

export interface UpsertRecommendationInput extends NormalizedProposal {
  versionId: string;
  companyId: string;
  currentHierarchy: string[];
  currentAccountType: string | null;
  currentStatementType: string | null;
  aiModel: string | null;
}

export interface CoaReviewRepository {
  loadVersionCoa(versionId: string): Promise<VersionCoa>;

  /**
   * Store one recommendation, keyed on (version, account, recommended rollup).
   *
   * MUST NOT write `status`: on conflict only the columns supplied here are
   * updated, so a row somebody has already decided keeps its decision. A fresh
   * pass can never silently reopen a settled one.
   */
  upsertRecommendation(input: UpsertRecommendationInput): Promise<void>;

  countByStatus(versionId: string, statuses: readonly string[]): Promise<number>;
  listRecommendations(versionId: string): Promise<StoredRecommendation[]>;
  getRecommendation(recommendationId: string): Promise<StoredRecommendation | null>;
  getAccount(accountId: string): Promise<CoaRow | null>;

  markApplied(input: {
    recommendationId: string;
    userId: string | null;
    appliedHierarchy: string[];
  }): Promise<void>;

  /**
   * Record a rejection. Only a pending row may be rejected, so a decision
   * already taken is never overwritten.
   */
  markRejected(input: {
    recommendationId: string;
    userId: string | null;
    reason: string | null;
  }): Promise<void>;
}

/**
 * The language model, reduced to the one thing this feature asks of it.
 *
 * Returns the raw response text; parsing and validation are the engine's job,
 * never the adapter's. An adapter that "helpfully" parsed would be a second
 * place where a malformed answer could be repaired into a plausible one.
 */
export interface ReasonablenessClassifier {
  /** @throws when the model is unreachable — the service is fail-soft around it. */
  review(prompt: string): Promise<{ text: string; model: string }>;
}

/**
 * The single write path into `chart_of_accounts`.
 *
 * Deliberately one narrow port rather than a general repository. Applying a
 * recommendation must go through the SAME function the manual "Edit Chart of
 * Accounts" grid uses — which writes the level columns, appends an audit entry,
 * and marks the row user-modified. A second hierarchy writer is exactly the
 * thing this design is avoiding.
 */
export interface HierarchyWriter {
  updateAccountHierarchy(
    accountId: string,
    patch: {
      levels: string[];
      movedParent: boolean;
      accountType?: string;
      statementType?: string;
    },
    userId: string | null,
  ): Promise<void>;
}

export interface ReviewSummary {
  accountsReviewed: number;
  recommendations: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  applied: number;
  rejected: number;
  /** True when no model answer was obtained. The COA is unaffected either way. */
  aiUnavailable: boolean;
}

export type ApplyResult =
  | { ok: true; alreadyApplied?: boolean; noChange?: boolean; accountId: string; newLevels?: string[]; kind?: string | null }
  | {
      ok: false;
      conflict?: boolean;
      code: "ALREADY_REJECTED" | "ACCOUNT_NOT_FOUND" | "NO_HIERARCHY" | "STALE_RECOMMENDATION" | "UNSAFE_RECOMMENDATION";
      message: string;
      currentHierarchy?: string[];
      recommendedFor?: string[] | null;
    };
