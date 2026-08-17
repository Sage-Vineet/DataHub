export { runParity } from "./harness.js";
export type {
  HarnessOptions,
  RequestSpec,
  AuthenticatedRequestSpec,
  Transport,
  FixtureResolver,
} from "./harness.js";
export {
  compareResponses,
  shapeOf,
  invariants,
  type ComparisonResult,
  type Difference,
  type Invariant,
  type ResponseSnapshot,
  type Verdict,
} from "./comparator.js";
export {
  assertNotProduction,
  assertSafeTarget,
  assertStagingTarget,
  isMutating,
  mutationAllowed,
  hostOf,
  productionHosts,
  ParityRefusal,
  type MarkerReader,
  type StagingMarker,
} from "./guards.js";
export {
  renderText,
  renderJson,
  reportPassed,
  domainPassed,
  isComplete,
  type DomainReport,
  type EndpointVerdict,
  type ParityReport,
  type SkipReason,
  type SkippedEndpoint,
} from "./report.js";
export {
  allRouteSets,
  legacyRoutes,
  moduleSurfaces,
  routeSetFor,
  routerRoutes,
  parseRouteKey,
  legacyBacklog,
  normalize,
  joinPath,
  type ModuleSurface,
  type RouteSet,
  type DomainRouteSets,
} from "./routes.js";
export {
  anonymizeContactsSql,
  seedSql,
  stagingMarkerSql,
  sinkAddressFor,
  placeholderPhone,
  looksLikeProductionContact,
  CONTACT_COLUMNS,
  type AnonymizeOptions,
  type ContactColumn,
} from "./anonymize.js";
