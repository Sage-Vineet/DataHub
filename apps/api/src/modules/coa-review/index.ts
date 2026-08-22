/**
 * Chart-of-accounts reasonableness review.
 *
 * A second-pass accounting review that runs AFTER the deterministic chart of
 * accounts is built, flagging accounts whose placement is technically possible
 * but reads wrong on a financial statement. Advisory only: no report engine
 * reads its output, and a row reaches `chart_of_accounts` only when a person
 * accepts it.
 *
 *   ports.ts               store, classifier, hierarchy writer
 *   service.ts             orchestration, reaching the world only through them
 *   repository.drizzle.ts  the real store, over migration 0005
 *   repository.memory.ts   in-memory store, stub classifier, recording writer
 *
 * The decision logic — every rule deciding whether a model proposal becomes a
 * recommendation, and whether one may be applied — is in
 * `@datahub/financial-engine/coa-recommendation` and is pure.
 *
 * ## Still to do before this serves a request
 *
 * 1. A `ReasonablenessClassifier` adapter over the model provider. The port
 *    returns raw text on purpose: parsing and validation are the engine's job,
 *    and an adapter that "helpfully" parsed would be a second place where a
 *    malformed answer could be repaired into a plausible one.
 * 2. A `HierarchyWriter` adapter pointing at whatever owns account hierarchy at
 *    the time — legacy `updateAccountHierarchy` today, the reports module after
 *    its cutover. Deliberately one narrow port: applying a recommendation must
 *    go through the same function the manual grid uses, and a second hierarchy
 *    writer is the thing this design exists to avoid.
 * 3. `router.ts`, behind a module flag per ADR-0003. Note the route contract the
 *    original had: a stale recommendation is a 409, not a generic error —
 *    `acceptRecommendation` throws with `conflict: true` for exactly that.
 *
 * `chart_of_accounts.system_id` does not exist in this schema. Legacy migration
 * 052 added it on the branch this was ported from and `ba/rearch` never took it,
 * so the adapter reports null rather than selecting a column that is not there.
 */

export { DrizzleCoaReviewRepository } from "./repository.drizzle.js";
export {
  createMemoryCoaReviewRepository,
  createRecordingHierarchyWriter,
  createStubClassifier,
} from "./repository.memory.js";
export { createCoaReviewService, parseJsonFromText } from "./service.js";
export type { CoaReviewDeps, CoaReviewService } from "./service.js";
export type {
  ApplyResult,
  CoaReviewRepository,
  HierarchyWriter,
  ReasonablenessClassifier,
  ReviewSummary,
  UpsertRecommendationInput,
  VersionCoa,
} from "./ports.js";
