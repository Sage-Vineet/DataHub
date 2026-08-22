import { defineConfig } from "vitest/config";

export default defineConfig({
  // @datahub/contracts and @datahub/db expose `development` → TS source and
  // `default` → dist. Tests read the source; only the built server reads dist.
  resolve: { conditions: ["development"] },
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests spin up embedded Postgres (PGlite/WASM) + Better Auth
    // crypto. Bound worker concurrency (not fully sequential) so many heavy
    // instances don't contend for memory/CPU and time out — while still finishing
    // the growing suite quickly.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 3 } },
    // Generous, because the integration tests spin up an embedded Postgres and
    // the number of them only grows. Two further multipliers apply on top: v8
    // coverage instrumentation, which is why `test:cov` tipped cases over a
    // 30s ceiling that `test` cleared comfortably, and a loaded CI box.
    //
    // A timeout is a backstop against a hung test, not a performance budget —
    // the failures it was producing were all "slower than expected", never
    // "wrong", and a gate that fails for the wrong reason gets ignored.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/server.ts", // listen bootstrap
        "src/modules/**/repository.drizzle.ts", // runtime DB adapter — exercised by integration tests, not unit-counted
        "src/modules/**/emailer.ts", // dev console stub (the real Graph adapter IS tested)
        "src/modules/**/better-test-harness.ts", // test-only harness (PGlite wiring)
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
