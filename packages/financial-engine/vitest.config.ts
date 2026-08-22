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
        thresholds: {
          statements: 95,
          lines: 95,
          functions: 90,
          branches: 80,
        },
      },
    },
  }),
);
