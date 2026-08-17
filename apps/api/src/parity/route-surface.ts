import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allRouteSets, legacyBacklog, legacyRoutes } from "./routes.js";

/**
 * The route surface, as a committed artifact.
 *
 * The parity harness (`tools/parity`) needs to know what the comparable surface
 * is, so it can say whether its scenarios covered 22 of 68 endpoints or all of
 * them. Deriving it requires instantiating every module router, which drags this
 * app's Express type augmentation into whichever package imports it — so instead
 * of a cross-package import, the derivation is emitted here as data.
 *
 * The obvious risk with a generated file is staleness, so `route-contract.test.ts`
 * asserts the committed copy still matches the live derivation. A route added to a
 * module fails the build until the artifact is regenerated, which is the same
 * property a direct import would have given.
 */

export interface RouteSurface {
  generatedFrom: string;
  domains: Record<string, { compare: string[]; additive: string[] }>;
  /** Legacy paths no module claims yet — the migration backlog. */
  backlog: string[];
}

export function buildRouteSurface(): RouteSurface {
  const legacy = legacyRoutes();
  const sets = allRouteSets(legacy);
  return {
    generatedFrom: "apps/api/src/parity/route-surface.ts",
    domains: Object.fromEntries(
      Object.entries(sets).map(([domain, set]) => [
        domain,
        { compare: set.compare, additive: set.additive },
      ]),
    ),
    backlog: legacyBacklog(legacy),
  };
}

export const SURFACE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/parity/route-surface.json",
);

/** `pnpm --filter @datahub/api route-surface` — regenerate the committed artifact. */
export function writeRouteSurface(): void {
  writeFileSync(SURFACE_PATH, `${JSON.stringify(buildRouteSurface(), null, 2)}\n`, "utf8");
}
