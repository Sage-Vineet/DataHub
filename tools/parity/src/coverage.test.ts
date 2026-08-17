import { describe, expect, it } from "vitest";
import { loadRouteSurface } from "./coverage.js";
import { coverageFor, formatCoverage, isComplete, routeKeyFor } from "./coverage.js";
import { buildScenarios } from "./scenarios/index.js";
import type { Scenario } from "./scenario.js";

/** Fixture ids are irrelevant to coverage — only the route shapes matter. */
const SCENARIOS = buildScenarios({
  companyId: "11111111-2222-4333-8444-555566667777",
  foreignCompanyId: "22222222-3333-4444-8555-666677778888",
  folderId: "33333333-4444-4555-8666-777788889999",
  userId: "44444444-5555-4666-8777-888899990000",
  reportVersionId: "55555555-6666-4777-8888-99990000aaaa",
  requestId: "66666666-7777-4888-8999-0000aaaabbbb",
  recipientUserId: "77777777-8888-4999-8aaa-1111bbbbcccc",
});

describe("route key derivation", () => {
  it("templates concrete ids back to the derived key shape", () => {
    expect(routeKeyFor("get", "/companies/8f1e2d3c-4b5a-4968-8776-655443332211")).toBe(
      "GET /companies/:p",
    );
    expect(routeKeyFor("GET", "/companies/42/folders")).toBe("GET /companies/:p/folders");
  });

  it("drops the query string, which is not part of the route", () => {
    expect(routeKeyFor("GET", "/companies/42/folders?includeArchived=true")).toBe(
      "GET /companies/:p/folders",
    );
  });
});

describe("coverage against the derived surface", () => {
  it("counts a domain's comparable routes from the derived surface, not the scenarios", () => {
    const surface = loadRouteSurface();
    const [companies] = coverageFor([], ["companies"]);
    expect(companies!.comparable).toBe(surface.domains.companies!.compare.length);
    expect(companies!.covered).toBe(0);
  });

  it("marks a route covered when a scenario exercises it", () => {
    const surface = loadRouteSurface();
    const route = surface.domains.companies!.compare[0]!;
    const [method, path] = [route.slice(0, route.indexOf(" ")), route.slice(route.indexOf(" ") + 1)];
    const scenario = {
      id: "test",
      domain: "companies",
      spec: "test",
      persona: "broker",
      request: { method, path: path.replace(/:p/g, "11111111-2222-4333-8444-555566667777") },
    } as Scenario;

    const [companies] = coverageFor([scenario], ["companies"]);
    expect(companies!.covered).toBe(1);
    expect(companies!.uncovered).not.toContain(route);
  });

  it("does not flag a scenario that deliberately exercises a module-only endpoint", () => {
    const requests = coverageFor(SCENARIOS).find((c) => c.domain === "requests")!;
    // `GET /requests/:p/narrative` is an INTENTIONAL_ADDITION: module-only, so it
    // has no legacy counterpart to compare against. Not a gap and not a typo.
    expect(requests.unmatched).toHaveLength(0);
    expect(requests.outsideComparable.join()).toMatch(/module-only endpoint/);
  });

  it("does not flag a scenario that asserts fall-through to legacy", () => {
    const reports = coverageFor(SCENARIOS).find((c) => c.domain === "reports")!;
    // `sync-is-deferred-to-legacy` targets a chart-of-accounts path the reports
    // module deliberately leaves to legacy. It must resolve to a route legacy
    // really serves — this check is what caught it pointing at one neither side
    // served, where both returned 404 and the scenario "matched" proving nothing.
    expect(reports.unmatched).toHaveLength(0);
    expect(reports.outsideComparable.join()).toMatch(/falls through to legacy/);
  });

  it("flags a scenario whose path matches no route on either side", () => {
    const scenario = {
      id: "typo",
      domain: "companies",
      spec: "test",
      persona: "broker",
      request: { method: "GET", path: "/companyes/42" },
    } as Scenario;

    const [companies] = coverageFor([scenario], ["companies"]);
    expect(companies!.unmatched).toHaveLength(1);
    expect(companies!.unmatched[0]).toMatch(/typo/);
  });

  // The live gap this exists to surface: the declared suite is small and the
  // comparable surface is not, and both print "PARITY CLEAN" today.
  it("shows the declared suite samples rather than covers the surface", () => {
    const coverage = coverageFor(SCENARIOS);
    const comparable = coverage.reduce((n, c) => n + c.comparable, 0);
    const covered = coverage.reduce((n, c) => n + c.covered, 0);

    expect(comparable).toBeGreaterThan(0);
    expect(covered).toBeLessThan(comparable);
    expect(coverage.some((c) => !isComplete(c))).toBe(true);
  });

  it("says so in the rendered output, above the verdict", () => {
    const text = formatCoverage(coverageFor(SCENARIOS));
    expect(text).toMatch(/Coverage: \d+ of \d+ comparable endpoints/);
    expect(text).toMatch(/SAMPLES the surface/);
    expect(text).toMatch(/does not authorize deleting the legacy handler/);
  });
});
