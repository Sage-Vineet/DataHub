import base from "@datahub/config/vitest";
import { mergeConfig, defineConfig } from "vitest/config";

/**
 * The shared base, plus a gate.
 *
 * This package had no config at all, so it inherited Vitest's defaults rather
 * than the workspace base: no excludes, and — the part that mattered — no
 * thresholds. Coverage was reported and nothing could fail on it.
 *
 * `index.ts` is a re-export barrel. v8 scores it 0% because nothing executes in
 * it, which is not a gap anybody can close; it is excluded for the same reason
 * `apps/api` excludes its `ports.ts` files.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        exclude: ["src/index.ts"],
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
