import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { contractRoutes, legacyRoutes, moduleSurfaces, routerRoutes } from "./parity/routes.js";
import { buildRouteSurface, SURFACE_PATH } from "./parity/route-surface.js";

/**
 * The route-contract guard.
 *
 * A module only cuts over if it answers on the SAME path the SPA already calls —
 * which is the path the legacy backend serves. Mounting a module anywhere else is
 * silently inert: the request sails past it and proxies to legacy, so the flag
 * "works", the tests pass, and nothing has actually migrated.
 *
 * The derivation of both surfaces lives in `parity/routes.ts`, shared with the
 * parity harness — the guard proves a module answers on a legacy path, the harness
 * proves it answers the same way, and they must not drift apart.
 *
 * The reverse is NOT asserted: legacy has many paths no module covers yet. That is
 * the migration backlog, not a defect.
 *
 * The denominator is `contractRoutes()`, not the live legacy surface: once a
 * legacy handler is deleted the module is the only thing serving that path, and
 * comparing against what legacy still has would make a completed migration look
 * like drift.
 */

/**
 * Endpoints a module adds that legacy never served. Additive, so they cannot break
 * a client on cutover — but they are surface the SPA does not call and no legacy
 * behaviour pins, so each one is listed deliberately rather than waved through.
 * Anything NOT on this list is drift and fails the guard.
 */
const INTENTIONAL_ADDITIONS: ReadonlyArray<string> = [
  // requests-domain: legacy exposes PATCH .../narrative and GET .../narrative/file,
  // but never a plain GET of the narrative record. The module adds the read side.
  "GET /requests/:p/narrative",
  // messages-domain: legacy creates groups only via .../message-groups/auto-create
  // (a non-goal that stays on legacy). The module adds explicit creation.
  "POST /companies/:p/message-groups",
  // sync-domain: legacy kept sync progress in two module-level Maps, so there
  // was no history to serve and no endpoint to serve it from. Moving progress
  // into a table makes "did last night's run finish?" answerable, which is the
  // question the Maps could never answer.
  "GET /manual-report-uploads/sync-history",
  // gl-import: legacy went straight from mapping to writing rows, so the first
  // sight of what a mapping actually does was the ledger it had produced.
  "GET /manual-gl/preview/:p",
];

describe("route contract — new modules answer on the legacy paths", () => {
  const legacy = contractRoutes();
  const MODULES = moduleSurfaces();
  const allowed = new Set(INTENTIONAL_ADDITIONS);

  it("parses a plausible legacy surface", () => {
    // Sanity-check the parser itself, so a regex regression can't vacuously pass
    // every assertion below by producing an empty or tiny set.
    expect(legacy.size).toBeGreaterThan(150);
    expect(legacy).toContain("POST /auth/login");
    expect(legacy).toContain("GET /companies");
    expect(legacy).toContain("GET /api/auth/callback"); // the QuickBooks OAuth route
  });

  it.each(MODULES.map((m) => [m.name, m] as const))(
    "%s claims only paths that exist in legacy",
    (_name, mod) => {
      const claimed = routerRoutes(mod.router, mod.mount);
      expect(claimed.length).toBeGreaterThan(0);
      const orphans = claimed.filter((r) => !legacy.has(r) && !allowed.has(r));
      expect(orphans).toEqual([]);
    },
  );

  it("every intentional addition is still an addition (and not silently in legacy)", () => {
    // Keeps the allowlist honest: once legacy gains or loses a path, the entry
    // becomes stale and should be re-reviewed rather than lingering forever.
    const claimed = new Set(MODULES.flatMap((m) => routerRoutes(m.router, m.mount)));
    for (const addition of INTENTIONAL_ADDITIONS) {
      expect(claimed, `${addition} is no longer claimed by any module`).toContain(addition);
      expect(legacy, `${addition} now exists in legacy — drop it from the list`).not.toContain(
        addition,
      );
    }
  });

  it("this gateway owns the QuickBooks OAuth dance", () => {
    /**
     * This assertion used to read the other way: no module may claim these.
     *
     * The reasoning was that they redirect to Intuit, receive its callback,
     * exchange and refresh tokens, and hand a realm from one company to
     * another — none of which can be exercised without real credentials and a
     * browser round trip, and porting an auth flow you cannot test against the
     * thing it talks to is how a migration ships a subtly broken one.
     *
     * What answered that was putting a port in front of Intuit
     * (`OAuthTokenExchange`) so everything except the two HTTP calls is
     * testable without it, and moving the security property into
     * `oauth-state.ts`, which is pure and covered. The version this replaces
     * decided which company got a connection by reading an unsigned query
     * parameter at an unauthenticated callback; leaving it on legacy to avoid
     * an untestable port was preserving that.
     *
     * Kept, inverted, rather than deleted: this is the last route group to
     * move, and an assertion that the gateway owns it is what stops a revert
     * quietly handing the dance back to a backend that no longer exists.
     */
    const DANCE = [
      "GET /refresh-token",
      "GET /api/auth/quickbooks",
      "GET /api/auth/callback",
      "POST /api/auth/transfer-confirm",
    ];
    const claimed = new Set(MODULES.flatMap((m) => routerRoutes(m.router, m.mount)));
    expect(DANCE.filter((r) => !claimed.has(r))).toEqual([]);
    // `legacy` above is the CONTRACT surface — legacy ∪ reaped — so it holds
    // these by design. What has to be empty is legacy itself.
    expect(DANCE.filter((r) => legacyRoutes().has(r))).toEqual([]);
  });
});

describe("the generated route surface stays fresh", () => {
  // `tools/parity` reads this artifact to report how much of the comparable
  // surface its scenarios actually cover. A stale artifact would understate the
  // gap silently — exactly the failure the coverage report exists to prevent — so
  // adding a route to a module fails here until it is regenerated:
  //   pnpm --filter @datahub/api route-surface
  it("matches the live derivation", () => {
    const committed = readFileSync(SURFACE_PATH, "utf8");
    const live = `${JSON.stringify(buildRouteSurface(), null, 2)}\n`;
    expect(committed).toBe(live);
  });
});
