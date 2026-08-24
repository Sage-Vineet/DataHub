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
        // Type-only: every `ports.ts` is interfaces and nothing else, so there
        // is no runtime code to execute and v8 scores them 0%. Counting them
        // depressed the total by roughly a point and a half while describing
        // nothing that could be tested.
        "src/modules/**/ports.ts",
        "src/modules/**/repository.drizzle.ts", // runtime DB adapter — exercised by integration tests, not unit-counted
        "src/modules/**/emailer.ts", // dev console stub (the real Graph adapter IS tested)
        "src/modules/**/better-test-harness.ts", // test-only harness (PGlite wiring)
      ],
      /**
       * A ratchet at what the suite actually reaches, not an aspiration.
       *
       * Raise these when you add tests; the only thing they forbid is going
       * backwards. They were 80/80/70 while the real figure was 92 — a gate
       * eleven points below the truth cannot fail, so it was not a gate.
       */
      thresholds: {
        // The suite reaches 97.55 / 96.09 / 95.18. Each gate sits a point or
        // so under that, for the reason the block above gives: set exactly at
        // the current figure it fails on a hundredth of a point, which trains
        // people to raise the number rather than to look at what moved.
        //
        // Branches came from 86 the long way. Most of the distance was not
        // writing tests for untested code — it was finding code that could not
        // be reached: fallbacks behind a body parser that always sets a body,
        // `?? ""` on columns declared NOT NULL, a default parameter every call
        // site supplies. An unreachable branch is not a coverage problem, and
        // raising this gate by deleting one is the right way to raise it.
        lines: 97,
        functions: 95,
        branches: 94,
        statements: 97,
      },
    },
  },
});
