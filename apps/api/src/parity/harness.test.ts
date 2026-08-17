import { describe, expect, it, vi } from "vitest";
import { runParity, type RequestSpec, type Transport } from "./harness.js";
import { ParityRefusal, type MarkerReader } from "./guards.js";
import { isComplete, renderJson, renderText, reportPassed } from "./report.js";
import { allRouteSets, legacyBacklog, legacyRoutes, moduleSurfaces, routerRoutes } from "./routes.js";

const STAGING: MarkerReader = {
  read: async () => ({ seededAt: "2026-08-17T10:00:00.000Z", source: "prod-snapshot-2026-08-17" }),
};
const UNMARKED: MarkerReader = { read: async () => null };

const ENV = {
  PARITY_PRODUCTION_HOSTS: "db.prod.internal",
} as NodeJS.ProcessEnv;

const STAGING_URL = "postgres://user:pass@db.staging.internal:5432/datahub";
const PROD_URL = "postgres://user:pass@db.prod.internal:5432/datahub";

/** Both engines answer identically unless a test says otherwise. */
const agreeing: Transport = async () => ({ status: 200, body: { ok: true }, durationMs: 3 });

const everyFixture = (route: { method: string; path: string }): RequestSpec => ({
  method: route.method,
  path: route.path.replace(/:p/g, "11111111-2222-4333-8444-555566667777"),
});

describe("target refusals — nothing is issued until they pass", () => {
  it("refuses a production database and issues no request", async () => {
    const transport = vi.fn(agreeing);
    await expect(
      runParity({
        connectionString: PROD_URL,
        env: ENV,
        marker: STAGING,
        transport,
        fixtures: everyFixture,
      }),
    ).rejects.toThrow(ParityRefusal);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a target with no staging marker and issues no request", async () => {
    const transport = vi.fn(agreeing);
    await expect(
      runParity({
        connectionString: STAGING_URL,
        env: ENV,
        marker: UNMARKED,
        transport,
        fixtures: everyFixture,
      }),
    ).rejects.toThrow(/no staging marker/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses when no production host list is configured", async () => {
    const transport = vi.fn(agreeing);
    await expect(
      runParity({
        connectionString: STAGING_URL,
        env: {} as NodeJS.ProcessEnv,
        marker: STAGING,
        transport,
        fixtures: everyFixture,
      }),
    ).rejects.toThrow(/PARITY_PRODUCTION_HOSTS is not set/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses an unparseable connection string rather than assuming it is safe", async () => {
    const transport = vi.fn(agreeing);
    await expect(
      runParity({
        connectionString: "not a url",
        env: ENV,
        marker: STAGING,
        transport,
        fixtures: everyFixture,
      }),
    ).rejects.toThrow(/could not be parsed/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("masks the target credentials in the report", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: everyFixture,
      domains: ["companies"],
    });
    expect(report.target).not.toContain("pass");
    expect(report.target).toContain("***");
  });
});

describe("read-only by default", () => {
  it("issues no mutating verb and reports each as skipped", async () => {
    const issued: RequestSpec[] = [];
    const transport: Transport = async (_engine, spec) => {
      issued.push(spec);
      return { status: 200, body: {}, durationMs: 1 };
    };

    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    expect(issued.every((s) => s.method === "GET")).toBe(true);
    const skipped = report.domains[0]!.skipped.filter((s) => s.reason === "mutation-not-permitted");
    expect(skipped.length).toBeGreaterThan(0);
    expect(report.mutationAllowed).toBe(false);
  });

  it("exercises mutating verbs when explicitly enabled", async () => {
    const issued: RequestSpec[] = [];
    const transport: Transport = async (_engine, spec) => {
      issued.push(spec);
      return { status: 200, body: {}, durationMs: 1 };
    };

    await runParity({
      connectionString: STAGING_URL,
      env: { ...ENV, PARITY_ALLOW_MUTATION: "true" },
      marker: STAGING,
      transport,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    expect(issued.some((s) => s.method === "POST")).toBe(true);
  });
});

describe("comparison and reporting", () => {
  it("passes when both engines agree", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    expect(reportPassed(report)).toBe(true);
    expect(report.domains[0]!.verdicts.length).toBeGreaterThan(0);
  });

  it("fails the endpoint when the module answers differently", async () => {
    const transport: Transport = async (engine) => ({
      status: engine === "legacy" ? 200 : 500,
      body: {},
      durationMs: 1,
    });

    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    expect(reportPassed(report)).toBe(false);
    const failed = report.domains[0]!.verdicts.filter((v) => v.verdict === "fail");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.differences[0]?.field).toBe("status");
  });

  it("records a route with no fixture as skipped rather than dropping it", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: () => null,
      domains: ["companies"],
    });

    const domain = report.domains[0]!;
    expect(domain.verdicts).toHaveLength(0);
    // Mutating routes are skipped earlier by the mutation guard, so only the
    // non-mutating ones reach the fixture resolver. Every comparable route is
    // still accounted for by one skip reason or another — that is the property
    // that matters: nothing is dropped without a stated reason.
    expect(domain.skipped.filter((s) => s.reason === "no-fixture").length).toBeGreaterThan(0);
    const comparableSkips = domain.skipped.filter((s) => s.reason !== "additive-endpoint");
    expect(comparableSkips).toHaveLength(domain.total);
    expect(isComplete(domain)).toBe(false);
  });

  it("records a transport failure as skipped, with the reason", async () => {
    const transport: Transport = async () => {
      throw new Error("connection refused");
    };

    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    const failed = report.domains[0]!.skipped.filter((s) => s.reason === "request-failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.detail).toMatch(/connection refused/);
  });

  it("reports module-only endpoints as additive instead of comparing them", async () => {
    const sets = allRouteSets();
    const domain = Object.keys(sets).find((d) => sets[d]!.additive.length > 0)!;

    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: everyFixture,
      domains: [domain],
    });

    const additive = report.domains[0]!.skipped.filter((s) => s.reason === "additive-endpoint");
    expect(additive.length).toBe(sets[domain]!.additive.length);
  });

  it("queries legacy and module with the same request", async () => {
    const byEngine: Record<string, RequestSpec[]> = { legacy: [], module: [] };
    const transport: Transport = async (engine, spec) => {
      byEngine[engine]!.push(spec);
      return { status: 200, body: {}, durationMs: 1 };
    };

    await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    expect(byEngine.legacy).toEqual(byEngine.module);
  });
});

describe("coverage reporting — a sampled run must not read as a proven one", () => {
  it("states compared against total in the text report", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    const text = renderText(report);
    const domain = report.domains[0]!;
    expect(text).toContain(
      `compared ${domain.verdicts.length} of ${domain.total} comparable endpoints`,
    );
  });

  it("warns explicitly when the run only sampled the surface", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      // Only GETs get a fixture, so the run is necessarily partial.
      fixtures: (route) => (route.method === "GET" ? everyFixture(route) : null),
      domains: ["companies"],
    });

    const text = renderText(report);
    expect(text).toMatch(/SAMPLED the surface/);
    expect(text).toMatch(/does not authorize deleting a legacy handler/);
  });

  it("lists every skipped endpoint with a reason", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: everyFixture,
      domains: ["companies"],
    });

    const text = renderText(report);
    for (const skip of report.domains[0]!.skipped) {
      expect(text).toContain(skip.route);
    }
  });

  it("carries coverage in the machine-readable form too", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: (route) => (route.method === "GET" ? everyFixture(route) : null),
      domains: ["companies"],
    });

    const json = JSON.parse(renderJson(report)) as {
      coverage: { compared: number; comparable: number; complete: boolean };
      domains: { complete: boolean }[];
    };
    expect(json.coverage.comparable).toBeGreaterThan(json.coverage.compared);
    expect(json.coverage.complete).toBe(false);
    expect(json.domains[0]?.complete).toBe(false);
  });
});

describe("authenticated routes are skipped distinctly from unfixtured ones", () => {
  it("skips with auth-required when a fixture needs a session and none is configured", async () => {
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: agreeing,
      fixtures: (route) => ({ ...everyFixture(route), requiresAuth: true }),
      domains: ["companies"],
    });

    const domain = report.domains[0]!;
    expect(domain.verdicts).toHaveLength(0);
    // Distinct from no-fixture: the fix is a seeded session, not a request body.
    expect(domain.skipped.some((s) => s.reason === "auth-required")).toBe(true);
    expect(domain.skipped.some((s) => s.reason === "no-fixture")).toBe(false);
  });

  it("sends the session token on both engines when one is configured", async () => {
    const seen: Record<string, string | undefined> = {};
    const report = await runParity({
      connectionString: STAGING_URL,
      env: ENV,
      marker: STAGING,
      transport: async (engine, spec) => {
        seen[engine] = spec.headers?.authorization;
        return { status: 200, body: {}, durationMs: 1 };
      },
      fixtures: (route) => ({ ...everyFixture(route), requiresAuth: true }),
      sessionToken: "session-abc",
      domains: ["companies"],
    });

    expect(report.domains[0]!.verdicts.length).toBeGreaterThan(0);
    expect(seen.legacy).toBe("Bearer session-abc");
    expect(seen.module).toBe("Bearer session-abc");
  });
});

describe("the three route sets account for both surfaces", () => {
  it("splits every claimed route into compare or additive", () => {
    const legacy = legacyRoutes();
    const sets = allRouteSets(legacy);
    for (const module of moduleSurfaces()) {
      const claimed = new Set(routerRoutes(module.router, module.mount));
      const set = sets[module.name]!;
      expect(new Set([...set.compare, ...set.additive])).toEqual(claimed);
      // A route cannot be both.
      expect(set.compare.filter((r) => set.additive.includes(r))).toEqual([]);
    }
  });

  it("reports the legacy backlog — paths no module claims yet", () => {
    const legacy = legacyRoutes();
    const backlog = legacyBacklog(legacy);
    const claimed = new Set(moduleSurfaces().flatMap((m) => routerRoutes(m.router, m.mount)));

    expect(backlog.length).toBeGreaterThan(0);
    expect(backlog.some((r) => claimed.has(r))).toBe(false);
    // Backlog plus every compared route accounts for the whole legacy surface.
    const compared = [...claimed].filter((r) => legacy.has(r));
    expect(backlog.length + compared.length).toBe(legacy.size);
  });
});
