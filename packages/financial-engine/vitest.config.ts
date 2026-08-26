import base from "@datahub/config/vitest";
import { mergeConfig, defineConfig } from "vitest/config";

/**
 * Critical path: 95%, not the shared 80%.
 *
 * This package is the single source of truth for every derived financial figure
 * the product shows — the income statement, the balance-sheet roll-forward, the
 * trial balance, and the EBITDA bridge. Three arithmetic defects reached UAT
 * through the legacy versions of these calculations, each reproducing exactly in
 * every fiscal year, and each invisible until someone compared the output to a
 * workbook by hand. A wrong number here is not a bug report, it is a valuation.
 *
 * The suite already sits above this line (96.5% statements, 94.4% functions at
 * the time of writing), so the threshold locks in work already done rather than
 * setting a target to chase. Raise it if coverage rises; do not lower it to make
 * a red build green.
 *
 * `functions` is set at 90 rather than 95 deliberately: the package exports a
 * handful of small type-guard and formatting helpers whose branches are covered
 * through their callers, and chasing the last two would mean writing tests that
 * assert nothing a caller does not already assert.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        exclude: [
          // The anonymized walkthrough engagement, consumed by `apps/api`'s
          // suite rather than this one, and a re-export barrel. Neither has
          // runtime behaviour a test could assert.
          "src/fixture.ts",
          "src/index.ts",
          // Interfaces and nothing else. v8 scores a type-only module 0%
          // because there is no runtime code to execute, which describes
          // nothing that could be tested — the same reason `apps/api` excludes
          // its `ports.ts` files.
          "src/types.ts",
        ],
        thresholds: {
          // The suite reaches 99.7 / 99.4 / 95.3. Each gate sits under that so
          // it fails on a real regression rather than on a hundredth of a
          // point, which trains people to move the number instead of looking
          // at what changed.
          statements: 99,
          lines: 99,
          functions: 95,
          branches: 95,
        },
      },
    },
  }),
);
