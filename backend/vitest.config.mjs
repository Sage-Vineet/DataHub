import { defineConfig } from "vitest/config";

/**
 * Tests for the legacy backend.
 *
 * The workspace comment on `backend` says it "is not edited — it is proxied to
 * by apps/api and retired domain-by-domain", and that remains the intent. But
 * the cutover window is long, legacy still owns most of the financial surface,
 * and until a domain moves in-process a defect in it is a live defect. So a
 * change here is allowed when it fixes correctness, and when it fixes
 * correctness it needs a test — which is what this config exists for. It is
 * not a mandate to grow legacy.
 *
 * ## Why these tests inject dependencies instead of mocking modules
 *
 * Vitest externalises this package's CommonJS source: `require()` inside a
 * legacy service is resolved by Node, outside the module runner. Neither
 * `vi.mock` nor `resolve.alias` nor `server.deps.inline` can intercept it —
 * all three were tried, and the service kept receiving the real `pg` driver and
 * the real Supabase client (which carries a 55-second connection timeout, so
 * every such test also took half a minute to fail).
 *
 * The consequence is a rule rather than a workaround: legacy logic that needs a
 * test gets its I/O passed in. The exported helpers take a `query` function, so
 * a test can hand them PGlite carrying the real committed schema and exercise
 * the actual SQL with no network, no mocking layer, and no timeouts.
 */
export default defineConfig({
  // @datahub/db exposes `development` → TS source, `default` → dist. Reading the
  // source means the test suite does not depend on a prior build.
  resolve: { conditions: ["development"] },
  test: {
    include: ["src/**/*.test.mjs"],
    // PGlite is a WASM Postgres; each instance costs real memory. Bound the
    // workers for the same reason apps/api does.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    testTimeout: 30_000,
    hookTimeout: 30_000,

    /**
     * A ratchet, not a target.
     *
     * This package is ~59,000 lines of legacy CommonJS that had no tests at all
     * until 22 Aug 2026. A 95% threshold here would fail every run and be
     * deleted within a day; these numbers are set at what the suite actually
     * covers, so the only thing they forbid is going backwards.
     *
     * RAISE THEM when you add tests. That is the whole mechanism: coverage can
     * only move up, and the number in this file is the high-water mark. It is
     * deliberately manual — an auto-updating threshold silently accepts a drop
     * on any run where a test file fails to load.
     *
     * ADR-0005's real standard applies to NEW code: 90%+, and 95% on the
     * critical paths below. Legacy is retired domain-by-domain rather than
     * back-filled to 95%, which would cost more than deleting it.
     *
     * `branches` is excluded on purpose: v8 counts branch denominators only in
     * files a test actually loads, so the percentage FALLS when you add the
     * first test for a new file. Gating on it would punish exactly the work
     * this ratchet exists to encourage.
     */
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.*", "src/server.js"],
      thresholds: {
        // Global floor — the high-water mark, raise it as tests land.
        statements: 4.6,
        functions: 4.7,
        lines: 4.6,

        /**
         * Critical paths, held at 100% per file.
         *
         * A global percentage cannot protect these: the denominator is ~59,000
         * lines, so `permissionService.js` could drop from full coverage to
         * nothing and move the total by less than half a point. Per-file
         * thresholds are what make "95% on the code that matters" enforceable
         * rather than aspirational.
         *
         * permissionService is every authorization decision the legacy backend
         * makes — the thing standing between one client's diligence data and
         * another's — and it is pure, so there is no reason for it to be below
         * 100%. If a change here cannot be covered, that is the signal to move
         * the logic into the users module rather than to lower this number.
         */
        "**/src/services/permissionService.js": {
          statements: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
