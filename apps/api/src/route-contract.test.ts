import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestHandler, Router } from "express";
import { describe, expect, it } from "vitest";
import type { Db } from "@datahub/db";
import { createCompaniesModule } from "./modules/companies/index.js";
import { createFoldersModule } from "./modules/folders/index.js";
import { createMessagesModule } from "./modules/messages/index.js";
import { createReportsModule } from "./modules/reports/index.js";
import { createRequestsModule } from "./modules/requests/index.js";
import { createUploadsModule } from "./modules/uploads/index.js";
import { createUsersModule } from "./modules/users/index.js";

/**
 * The route-contract guard.
 *
 * A module only cuts over if it answers on the SAME path the SPA already calls —
 * which is the path the legacy backend serves. Mounting a module anywhere else is
 * silently inert: the request sails past it and proxies to legacy, so the flag
 * "works", the tests pass, and nothing has actually migrated.
 *
 * This test derives both sides from source — the legacy Express app and the real
 * module routers — and asserts every path a module claims exists in legacy. It is
 * the standing guard against that class of drift.
 *
 * The reverse is NOT asserted: legacy has many paths no module covers yet. That is
 * the migration backlog, not a defect.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "../../../backend/src");

/** `/companies/:companyId/folders` → `/companies/:p/folders` so param names don't matter. */
function normalize(path: string): string {
  const collapsed = path.replace(/:[A-Za-z0-9_]+/g, ":p").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

function joinPath(mount: string, path: string): string {
  const base = mount === "/" ? "" : mount.replace(/\/+$/, "");
  const tail = path === "/" ? "" : path;
  return normalize(`${base}${tail}` || "/");
}

// ── The legacy surface ────────────────────────────────────────────────────────

function jsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Map each legacy route module to the prefix `app.js` mounts it at, by resolving
 * `app.use("<prefix>", <var>)` back through the `const <var> = require("<path>")`.
 */
function legacyMounts(): Map<string, string> {
  const app = readFileSync(join(BACKEND, "app.js"), "utf8");
  const requires = new Map<string, string>();
  for (const m of app.matchAll(/const\s+(\w+)\s*=\s*require\(\s*"\.\/(.+?)"\s*\)/g)) {
    requires.set(m[1]!, m[2]!);
  }
  const mounts = new Map<string, string>();
  for (const m of app.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*([\s\S]{0,80}?)(\w+)\s*\)/g)) {
    const [, prefix, , varName] = m;
    const rel = requires.get(varName!);
    if (rel) mounts.set(resolve(BACKEND, `${rel}.js`), prefix!);
  }
  return mounts;
}

/** Every path the legacy backend serves, as `METHOD /normalized/path`. */
function legacyRoutes(): Set<string> {
  const mounts = legacyMounts();
  const routes = new Set<string>();
  // Routes mounted via the loop over the QuickBooks array default to "/" like the
  // rest of the un-prefixed mounts, so an unmapped file is treated as root-mounted.
  for (const file of jsFilesUnder(join(BACKEND, "routes"))) {
    const prefix = mounts.get(file) ?? "/";
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)) {
      routes.add(`${m[1]!.toUpperCase()} ${joinPath(prefix, m[2]!)}`);
    }
  }
  return routes;
}

// ── The new surface ───────────────────────────────────────────────────────────

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Walk an Express router's stack for the paths it actually registered. */
function routerRoutes(router: Router, mount: string): string[] {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const out: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) out.push(`${method.toUpperCase()} ${joinPath(mount, layer.route.path)}`);
    }
  }
  return out;
}

const db = {} as Db; // constructors only stash the reference; no connection is made
const requireAuth: RequestHandler = (_req, _res, next) => {
  next();
};

/** Mirrors the mount table in `server.ts` — the thing under test. */
const MODULES: ReadonlyArray<{ name: string; mount: string; router: Router }> = [
  { name: "companies", mount: "/companies", router: createCompaniesModule({ db, requireAuth }).router },
  { name: "users", mount: "/users", router: createUsersModule({ db, requireAuth }).router },
  { name: "folders", mount: "/", router: createFoldersModule({ db, requireAuth }).router },
  { name: "uploads", mount: "/", router: createUploadsModule({ db, requireAuth }).router },
  { name: "requests", mount: "/", router: createRequestsModule({ db, requireAuth }).router },
  { name: "messages", mount: "/", router: createMessagesModule({ db, requireAuth }).router },
  { name: "reports", mount: "/", router: createReportsModule({ db, requireAuth }).router },
];

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
];

describe("route contract — new modules answer on the legacy paths", () => {
  const legacy = legacyRoutes();
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

  it("no module claims a QuickBooks OAuth path", () => {
    const qbo = [...legacy].filter((r) => r.includes(" /api/auth/"));
    expect(qbo.length).toBeGreaterThan(0);
    const claimed = new Set(MODULES.flatMap((m) => routerRoutes(m.router, m.mount)));
    expect(qbo.filter((r) => claimed.has(r))).toEqual([]);
  });
});
