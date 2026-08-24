import base from "@datahub/config/vitest";
import { mergeConfig, defineConfig } from "vitest/config";

/**
 * The shared base, plus a gate.
 *
 * This package had no config, so it inherited Vitest's defaults rather than the
 * workspace base: no excludes, and no thresholds. Coverage was reported and
 * nothing could fail on it — which showed as 17% functions, almost all of it
 * the Drizzle column builders in `schema.ts` rather than anything testable.
 *
 * `schema.ts` is a DECLARATION. Every "function" v8 counts in it is a column
 * definition evaluated at import time, so the figure measures how much of the
 * schema some test happened to touch, not whether anything is tested. The
 * schema is verified by `drift.test.ts`, `nullability.test.ts` and
 * `schema-snapshot.test.ts`, which check it against a real database — a far
 * stronger statement than executing its builders.
 *
 * What is left after excluding it is the runtime code: the DDL builders, the
 * connection helpers, and the migration runner.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        exclude: [
          // Declarations, all of them. Every "function" v8 counts in these is a
          // column builder evaluated at import; the figure measures which
          // tables a test happened to touch, not whether anything is tested.
          "src/schema.ts",
          "src/*-schema.ts",
          "src/index.ts", // re-export barrel
          "scripts/**", // developer tooling, run by hand
          "migrations/**", // SQL, plus the tests that apply it
        ],
        thresholds: {
          statements: 95,
          lines: 95,
          functions: 95,
          // The suite reaches exactly 95. The gate sits under it for the reason
          // `apps/api` gives: set at the current figure it fails on a
          // hundredth of a point, which trains people to move the number
          // rather than look at what changed.
          branches: 94,
        },
      },
    },
  }),
);
