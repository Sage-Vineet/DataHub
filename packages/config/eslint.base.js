// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Shared flat ESLint config for all @datahub/* TypeScript packages.
 * Consume from a package's eslint.config.js:  export { default } from "@datahub/config/eslint";
 * (or spread it and append package-specific overrides).
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
