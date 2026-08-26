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
 *   classifier.gemini.ts   the model, with its fallback chain
 *   router.ts              the HTTP contract
 *   module.ts              wiring, behind COA_REVIEW_MODULE_ENABLED
 *   repository.memory.ts   in-memory store, stub classifier, recording writer
 *
 * The decision logic — every rule deciding whether a model proposal becomes a
 * recommendation, and whether one may be applied — is in
 * `@datahub/financial-engine/coa-recommendation` and is pure.
 *
 * ## Notes for whoever touches this next
 *
 * The module mounts whether or not `GEMINI_API_KEY` is set. Listing and
 * deciding are database operations; only *generating* needs a model, and that
 * path is fail-soft. Withholding a reviewer's queue over a dependency they are
 * not using would be the worse trade.
 *
 * The service is built PER REQUEST, which is unusual here and deliberate: the
 * hierarchy writer carries the caller's own identity into the code that owns
 * `chart_of_accounts`, so a reviewer who cannot edit an account cannot apply a
 * recommendation to it either. A boot-time singleton would have to hold a
 * service identity, which turns the review UI into a privilege escalation.
 *
 * This module never writes the level columns itself. Doing so would make it the
 * second hierarchy writer in the system, diverging from the manual grid's the
 * moment either changed, with no audit entry and no user-modified flag. It
 * delegates to the one writer that owns the table — which used to mean an HTTP
 * hop to legacy and now means an in-process call. Nothing else changed when
 * that swapped, because the module depends on the port rather than on either.
 *
 * Still absent: the SPA. `ba/rearch` never took the review UI from `data_room`,
 * so nothing calls these routes yet — which is why the flag defaults off.
 *
 * `chart_of_accounts.system_id` does not exist in this schema. Legacy migration
 * 052 added it on the branch this was ported from and `ba/rearch` never took it,
 * so the adapter reports null rather than selecting a column that is not there.
 */

export { createCoaReviewModule } from "./module.js";
export type { CoaReviewModule, CreateCoaReviewModuleOptions } from "./module.js";
export { createCoaReviewRouter } from "./router.js";
export { createGeminiClassifier, DEFAULT_MODELS } from "./classifier.gemini.js";
export { createInProcessHierarchyWriter } from "./hierarchy.in-process.js";
export type { ApplyHierarchy } from "./hierarchy.in-process.js";
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
