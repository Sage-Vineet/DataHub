export * as schema from "./schema.all.js";
export { createDb, type Db } from "./client.js";
export {
  activityTablesDdl,
  activityGrantsDdl,
  monthlyPartitionDdl,
  upcomingPartitionsDdl,
  partitionBounds,
  partitionSuffix,
} from "./activity-ddl.js";
export {
  diffSchemas,
  reconcile,
  baselineFrom,
  driftKey,
  isBreaking,
  normalizeType,
  renderDrift,
  type DriftBaseline,
  type DriftItem,
  type DriftKind,
  type DriftReport,
  type SchemaShape,
  type TableShape,
} from "./drift.js";

/**
 * Test-only: a PGlite database carrying the real deployed schema. Exported from
 * the package so integration tests never hand-write DDL again — see testing.ts.
 */
export { createSchemaDb, readSchemaSnapshot, SNAPSHOT_PATH } from "./testing.js";
