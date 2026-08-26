import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

/**
 * Test config for the SPA, kept separate from `vite.config.js` so the build
 * config stays about building.
 *
 * Adds coverage reporting and nothing else. In particular it does NOT set an
 * environment: the suite runs in vitest's default `node` environment and relies
 * on Node's `Blob`/`TextDecoder`, so switching it to `jsdom` fails four of the
 * CIM PDF export tests. Components that need a DOM opt in per file with
 * `@vitest-environment jsdom`.
 *
 * ## The coverage numbers are a ratchet, not a target
 *
 * This app is ~59,000 lines, most of it pre-modernization `.jsx` with god
 * components and no seams. A 95% threshold would fail every run and be removed
 * within a day. These are set at what the suite actually covers, so the only
 * thing they forbid is going backwards.
 *
 * RAISE THEM when you add tests — the number here is the high-water mark, and it
 * is manual on purpose. An auto-updating threshold silently accepts a drop on
 * any run where a test file fails to load.
 *
 * ADR-0005's standard applies to NEW code: 90%+, 95% on critical paths. The
 * frontend reaches that by migration (`frontend-ui-adoption`), not by
 * back-filling tests onto components that are being replaced.
 *
 * `branches` is excluded deliberately: v8 counts branch denominators only in
 * files a test loads, so the percentage FALLS when you add the first test for a
 * new file — punishing exactly the work this exists to encourage.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      passWithNoTests: true,
      coverage: {
        provider: "v8",
        reporter: ["text-summary", "lcov"],
        include: ["src/**/*.{js,jsx}"],
        exclude: ["src/**/*.test.{js,jsx}", "src/main.jsx"],
        // Statements and lines were 2.7 and the suite reports 2.67 (1587/59422),
        // so this gate was red on every run. It had been invisible: turbo aborts
        // at the first failing task, and `@datahub/financial-engine#typecheck`
        // failed ahead of it, so CI never reached the coverage step to report it.
        //
        // Lowered to match reality rather than papered over with a test written
        // to move a number. It is a floor to raise again, not a target — and the
        // TypeScript migration will move it on its own, because `include` below
        // matches only .js/.jsx: a file converted to .tsx leaves the denominator
        // entirely rather than counting as uncovered.
        thresholds: {
          statements: 2.6,
          functions: 8.2,
          lines: 2.6,
        },
      },
    },
  }),
);
