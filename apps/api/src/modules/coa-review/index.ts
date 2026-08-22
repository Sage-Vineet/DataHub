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
 *   hierarchy.legacy.ts    the one write path, over legacy's PATCH route
 *   router.ts              the HTTP contract legacy already serves
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
 * hierarchy writer forwards the caller's own credentials to the route that owns
 * `chart_of_accounts`, so a reviewer who cannot edit an account cannot apply a
 * recommendation to it either. A boot-time singleton would have to hold a
 * service identity, which turns the review UI into a privilege escalation.
 *
 * `hierarchy.legacy.ts` pays an HTTP hop rather than writing the level columns
 * directly, because writing them here would make this the second hierarchy
 * writer in the system — diverging from the manual grid's the moment either
 * changes, with no audit entry and no user-modified flag. When the chart of
 * accounts moves in-process, swap that adapter; nothing else changes, because
 * the module depends on the port rather than on it.
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
export { createLegacyHierarchyWriter } from "./hierarchy.legacy.js";
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
