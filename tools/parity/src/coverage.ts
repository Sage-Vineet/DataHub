import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Domain, Scenario } from "./scenario.js";

/**
 * Scenario coverage against the real route surface.
 *
 * The report already says a clean run is "evidence for a flag flip, not proof of
 * one … it covers the scenarios declared here". This turns that caveat into a
 * number, because the difference between covering 2 of 3 endpoints and 2 of 40 is
 * the difference between evidence and wishful thinking — and both print the same
 * "PARITY CLEAN" today.
 *
 * The comparable surface is derived from source (`@datahub/api/parity/routes`,
 * shared with the route-contract guard), so it cannot fall behind: a route added
 * to a module immediately shows up as uncovered until a scenario exercises it.
 */

interface RouteSurface {
  domains: Record<string, { compare: string[]; additive: string[] }>;
  backlog: string[];
}

const SURFACE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../route-surface.json");

/**
 * The comparable surface, read from the artifact `apps/api` generates. Not a
 * cross-package import: deriving it requires instantiating every module router,
 * which would pull that app's Express type augmentation into this package.
 * `route-contract.test.ts` fails if the artifact drifts from the live derivation,
 * so reading a file is not a weaker guarantee than importing the function.
 */
export function loadRouteSurface(path: string = SURFACE_PATH): RouteSurface {
  return JSON.parse(readFileSync(path, "utf8")) as RouteSurface;
}

/** `/companies/:companyId/folders` → `/companies/:p/folders`, matching the artifact keys. */
function normalize(path: string): string {
  const collapsed = path.replace(/:[A-Za-z0-9_]+/g, ":p").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

export interface DomainCoverage {
  domain: string;
  /** Routes the module claims that legacy also serves — the parity-relevant set. */
  comparable: number;
  covered: number;
  /** `METHOD /path` entries no declared scenario exercises. */
  uncovered: string[];
  /**
   * Scenarios that deliberately exercise something outside the comparable set:
   * a module-only (additive) endpoint, or a path that falls through to legacy.
   * Legitimate, and reported separately so they are not read as gaps.
   */
  outsideComparable: string[];
  /** Scenarios whose path matches nothing on either side — stale or mistyped. */
  unmatched: string[];
}

/** `/companies/8f1e…/folders` → `/companies/:p/folders`, matching the derived keys. */
export function routeKeyFor(method: string, path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const templated = withoutQuery
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":p";
      if (/^\d+$/.test(segment)) return ":p";
      return segment;
    })
    .join("/");
  return `${method.toUpperCase()} ${normalize(templated)}`;
}

/**
 * Coverage per domain. `scenarios` are the declared ones; anything they do not
 * touch is listed so the gap is actionable rather than merely counted.
 */
export function coverageFor(scenarios: ReadonlyArray<Scenario>, domains?: ReadonlyArray<Domain>): DomainCoverage[] {
  const surface = loadRouteSurface();
  const sets = surface.domains;
  const backlog = new Set(surface.backlog);
  const wanted = domains ?? (Object.keys(sets) as Domain[]);
  const out: DomainCoverage[] = [];

  for (const domain of wanted) {
    const set = sets[domain];
    if (!set) continue;

    const comparable = new Set(set.compare);
    const additive = new Set(set.additive);
    const exercised = new Set<string>();
    const outsideComparable: string[] = [];
    const unmatched: string[] = [];

    for (const scenario of scenarios.filter((s) => s.domain === domain)) {
      const key = routeKeyFor(scenario.request.method, scenario.request.path);
      if (comparable.has(key)) {
        exercised.add(key);
      } else if (additive.has(key)) {
        outsideComparable.push(`${scenario.id} → ${key} (module-only endpoint)`);
      } else if (backlog.has(key)) {
        outsideComparable.push(`${scenario.id} → ${key} (falls through to legacy)`);
      } else {
        unmatched.push(`${scenario.id} → ${key}`);
      }
    }

    out.push({
      domain,
      comparable: comparable.size,
      covered: exercised.size,
      uncovered: [...comparable].filter((r) => !exercised.has(r)).sort(),
      outsideComparable: outsideComparable.sort(),
      unmatched: unmatched.sort(),
    });
  }

  return out;
}

export function isComplete(coverage: DomainCoverage): boolean {
  return coverage.comparable > 0 && coverage.covered === coverage.comparable;
}

/**
 * Rendered above the verdict, not below it: coverage frames every number that
 * follows, and a reader who stops after the first lines should still know whether
 * the run sampled the surface or covered it.
 */
export function formatCoverage(coverage: ReadonlyArray<DomainCoverage>): string {
  const lines: string[] = [];
  const totalComparable = coverage.reduce((n, c) => n + c.comparable, 0);
  const totalCovered = coverage.reduce((n, c) => n + c.covered, 0);

  lines.push(`  Coverage: ${totalCovered} of ${totalComparable} comparable endpoints exercised`);
  for (const domain of coverage) {
    const mark = isComplete(domain) ? "" : "  ← partial";
    lines.push(`    ${domain.domain}: ${domain.covered}/${domain.comparable}${mark}`);
    for (const route of domain.uncovered) lines.push(`      uncovered: ${route}`);
    // Deliberate non-comparable coverage — reported, but not as a gap. Treating
    // these as problems is the noise that gets a harness ignored.
    for (const outside of domain.outsideComparable) lines.push(`      also exercised: ${outside}`);
    for (const stale of domain.unmatched) {
      lines.push(`      NO MATCHING ROUTE: ${stale} — stale scenario, or a path typo`);
    }
  }
  if (totalCovered < totalComparable) {
    lines.push("");
    lines.push("  This suite SAMPLES the surface. A clean run authorizes a flag flip;");
    lines.push("  it does not authorize deleting the legacy handler behind an endpoint");
    lines.push("  no scenario exercised — see docs/CUTOVER_FLIP_CRITERIA.md.");
  }
  return lines.join("\n");
}
