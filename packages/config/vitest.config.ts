import base from "./vitest.base.js";
import { mergeConfig, defineConfig } from "vitest/config";

/**
 * The shared base, applied to the package that defines it.
 *
 * Without a config of its own this package measured its own toolchain — the
 * eslint, prettier and Vitest bases it exports — and scored 14%. Those files
 * are configuration consumed by other packages' tooling, not runtime code, and
 * a coverage figure over them says nothing: they are "executed" only when a
 * tool loads them, which is never inside this package's own suite.
 *
 * What remains is `src/`, which exists precisely so the package has a typed,
 * testable surface.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        include: ["src/**/*.ts"],
        thresholds: {
          statements: 95,
          lines: 95,
          functions: 95,
          branches: 95,
        },
      },
    },
  }),
);
