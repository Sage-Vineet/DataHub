/**
 * @datahub/config — shared toolchain config for the DataHub monorepo.
 *
 * The actual configs are the sibling files (tsconfig.base.json, eslint.base.js,
 * prettier.config.js, vitest.base.ts) consumed via this package's exports map.
 * This module exists so the package has typed, testable surface area.
 */
export const CONFIG_FILES = {
  tsconfig: "tsconfig.base.json",
  eslint: "eslint.base.js",
  prettier: "prettier.config.js",
  vitest: "vitest.base.ts",
} as const;

export type ConfigFileKey = keyof typeof CONFIG_FILES;

/** Resolve a shared config file name by key. */
export function configFile(key: ConfigFileKey): string {
  return CONFIG_FILES[key];
}
