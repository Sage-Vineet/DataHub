import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/server.ts", // listen bootstrap
        "src/modules/**/repository.drizzle.ts", // runtime DB adapter — verified against a real DB, not unit-tested
        "src/modules/**/emailer.ts", // dev stub; real Graph adapter lands later
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
