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
  },
});
