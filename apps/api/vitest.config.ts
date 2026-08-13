import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests spin up embedded Postgres (PGlite/WASM) + Better Auth
    // crypto. Bound worker concurrency (not fully sequential) so many heavy
    // instances don't contend for memory/CPU and time out — while still finishing
    // the growing suite quickly.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 3 } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
