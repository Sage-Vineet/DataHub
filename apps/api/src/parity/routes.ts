import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { createCompaniesModule } from "../modules/companies/index.js";
import { createFoldersModule } from "../modules/folders/index.js";
import { createMessagesModule } from "../modules/messages/index.js";
import { createReportsModule } from "../modules/reports/index.js";
import { createRequestsModule } from "../modules/requests/index.js";
import { createUploadsModule } from "../modules/uploads/index.js";
import { createUsersModule } from "../modules/users/index.js";

/**
 * Route-surface derivation, shared by the route-contract guard and the parity
 * harness.
 *
 * Both need the same answer to "what does each side actually serve", and they must
 * not drift apart: the guard proves a module answers on a legacy path, and the
 * harness proves it answers the *same way*. Deriving both from source means adding
 * a route to a module automatically widens what parity has to prove — a
 * hand-maintained endpoint list is the failure mode this exists to prevent, because
 * it stays green while the surface underneath it moves.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "../../../../backend/src");

/** `/companies/:companyId/folders` → `/companies/:p/folders` so param names don't matter. */
export function normalize(path: string): string {
  const collapsed = path.replace(/:[A-Za-z0-9_]+/g, ":p").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

export function joinPath(mount: string, path: string): string {
  const base = mount === "/" ? "" : mount.replace(/\/+$/, "");
  const tail = path === "/" ? "" : path;
  return normalize(`${base}${tail}` || "/");
}

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
export function legacyRoutes(): Set<string> {
  const mounts = legacyMounts();
  const routes = new Set<string>();
  for (const file of jsFilesUnder(join(BACKEND, "routes"))) {
    const prefix = mounts.get(file) ?? "/";
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)) {
      routes.add(`${m[1]!.toUpperCase()} ${joinPath(prefix, m[2]!)}`);
    }
  }
  return routes;
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Walk an Express router's stack for the paths it actually registered. */
export function routerRoutes(router: Router, mount: string): string[] {
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

export interface ModuleSurface {
  name: string;
  mount: string;
  router: Router;
}

/**
 * Mirrors the mount table in `server.ts`. Module constructors only stash the `Db`
 * reference, so no connection is opened by building this.
 */
export function moduleSurfaces(): ModuleSurface[] {
  const db = {} as Db;
  const requireAuth: RequestHandler = (_req, _res, next) => {
    next();
  };
  return [
    { name: "companies", mount: "/companies", router: createCompaniesModule({ db, requireAuth }).router },
    { name: "users", mount: "/users", router: createUsersModule({ db, requireAuth }).router },
    { name: "folders", mount: "/", router: createFoldersModule({ db, requireAuth }).router },
    { name: "uploads", mount: "/", router: createUploadsModule({ db, requireAuth }).router },
    { name: "requests", mount: "/", router: createRequestsModule({ db, requireAuth }).router },
    { name: "messages", mount: "/", router: createMessagesModule({ db, requireAuth }).router },
    { name: "reports", mount: "/", router: createReportsModule({ db, requireAuth }).router },
  ];
}

export interface RouteSet {
  /** Served by both engines — the parity request set. */
  compare: string[];
  /** Claimed by the module, absent from legacy: additive, reported not compared. */
  additive: string[];
}

/** Split a module's claimed routes against the legacy surface. */
export function routeSetFor(module: ModuleSurface, legacy: ReadonlySet<string>): RouteSet {
  const claimed = routerRoutes(module.router, module.mount);
  return {
    compare: claimed.filter((r) => legacy.has(r)).sort(),
    additive: claimed.filter((r) => !legacy.has(r)).sort(),
  };
}

export interface DomainRouteSets {
  [domain: string]: RouteSet;
}

/** Route sets for every module, keyed by domain name. */
export function allRouteSets(legacy: ReadonlySet<string> = legacyRoutes()): DomainRouteSets {
  const out: DomainRouteSets = {};
  for (const module of moduleSurfaces()) out[module.name] = routeSetFor(module, legacy);
  return out;
}

/**
 * Paths legacy serves that no module claims — the migration backlog. Not a defect
 * and not part of any parity run, but worth deriving from the same source so the
 * three sets (compare / additive / backlog) account for every route on both sides.
 */
export function legacyBacklog(legacy: ReadonlySet<string> = legacyRoutes()): string[] {
  const claimed = new Set(moduleSurfaces().flatMap((m) => routerRoutes(m.router, m.mount)));
  return [...legacy].filter((r) => !claimed.has(r)).sort();
}

/** Split a `METHOD /path` key back into its parts. */
export function parseRouteKey(key: string): { method: string; path: string } {
  const space = key.indexOf(" ");
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}
