import { defineConfig } from "vitest/config";

/**
 * Shared Vitest base config. Packages import and extend this:
 *   import base from "@datahub/config/vitest";
 * The legacy backend and moved SPA are excluded from coverage so the
 * program's 90% target is measured on new/migrated code only.
 */
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.config.*",
        "**/*.test.ts",
        "backend/**",
        "legacy/**",
        "apps/web/**",
      ],
      // Ratchets toward the program target of 90% as modules land.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
