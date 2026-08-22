/**
 * Chart-of-accounts reasonableness review.
 *
 * Deliberately incomplete, and the gap is structural rather than an oversight:
 * a Drizzle repository has no table to talk to. The store this feature needs,
 * `key_report_coa_hierarchy_recommendations`, exists only on the `data_room`
 * deployment and is absent from `packages/db/schema-snapshot.sql`, so it needs
 * a migration before an adapter can be written. Wiring a router in ahead of
 * that would mean mounting a route that cannot answer.
 *
 * What is here is everything that does not depend on the table:
 *
 *   ports.ts             the three seams — store, classifier, hierarchy writer
 *   service.ts           the orchestration, reaching the world only through them
 *   repository.memory.ts an in-memory store plus stub classifier and recording
 *                        writer, which is what makes the service testable at all
 *
 * The decision logic — every rule that decides whether a model proposal becomes
 * a recommendation, and whether a recommendation may be applied — lives in
 * `@datahub/financial-engine/coa-recommendation` and is pure.
 *
 * To finish the module:
 *   1. a migration creating the recommendations table, with the uniqueness key
 *      (version_id, account_id, recommended_rollup) the upsert relies on;
 *   2. `repository.drizzle.ts` — note the upsert must NOT write `status`, or a
 *      re-run silently reopens decisions people have already made;
 *   3. a `ReasonablenessClassifier` adapter over the model provider;
 *   4. a `HierarchyWriter` adapter pointing at whatever owns account hierarchy
 *      at that time — legacy `updateAccountHierarchy` today, the folders/reports
 *      module after its cutover;
 *   5. `router.ts` behind a module flag, per ADR-0003.
 */

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
