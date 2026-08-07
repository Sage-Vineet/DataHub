/**
 * Env-driven routing table for the gateway.
 *
 * Origins are named upstreams. `legacy` (LEGACY_ORIGIN) is required and is the
 * terminal default — with no routes configured, everything resolves to legacy,
 * so the gateway is a transparent no-op in front of the existing backend.
 *
 * GATEWAY_ROUTES maps path-prefixes to origin names, comma- or newline-separated:
 *   GATEWAY_ROUTES="/api/auth=api, /api/health=legacy"
 * Longest matching prefix wins; anything unmatched falls through to legacy.
 */

export interface RoutingTable {
  origins: Readonly<Record<string, string>>;
  routes: ReadonlyArray<{ prefix: string; origin: string }>;
  defaultOrigin: string;
}

export class RoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConfigError";
  }
}

function normalizeOrigin(name: string, raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new RoutingConfigError(`Origin "${name}" is empty`);
  }
  try {
    // Validate it's a usable absolute URL.
    return new URL(value).origin;
  } catch {
    throw new RoutingConfigError(`Origin "${name}" is not a valid URL: "${value}"`);
  }
}

/**
 * Build the routing table from environment. Throws RoutingConfigError on any
 * malformed or missing configuration rather than starting with undefined routing.
 */
export function parseRoutingTable(env: NodeJS.ProcessEnv): RoutingTable {
  const legacy = env.LEGACY_ORIGIN;
  if (!legacy || !legacy.trim()) {
    throw new RoutingConfigError(
      "LEGACY_ORIGIN is required (the default upstream the gateway forwards to).",
    );
  }

  const origins: Record<string, string> = {
    legacy: normalizeOrigin("legacy", legacy),
  };
  if (env.API_ORIGIN && env.API_ORIGIN.trim()) {
    origins.api = normalizeOrigin("api", env.API_ORIGIN);
  }

  const routes: Array<{ prefix: string; origin: string }> = [];
  const raw = env.GATEWAY_ROUTES?.trim();
  if (raw) {
    for (const entry of raw.split(/[\n,]+/)) {
      const line = entry.trim();
      if (!line) continue;
      const eq = line.indexOf("=");
      if (eq === -1) {
        throw new RoutingConfigError(`Malformed route entry (expected "prefix=origin"): "${line}"`);
      }
      const prefix = line.slice(0, eq).trim();
      const origin = line.slice(eq + 1).trim();
      if (!prefix.startsWith("/")) {
        throw new RoutingConfigError(`Route prefix must start with "/": "${prefix}"`);
      }
      if (!(origin in origins)) {
        throw new RoutingConfigError(
          `Route "${prefix}" references unknown origin "${origin}" (known: ${Object.keys(origins).join(", ")})`,
        );
      }
      routes.push({ prefix, origin });
    }
  }

  // Longest prefix first so resolveTarget can take the first match.
  routes.sort((a, b) => b.prefix.length - a.prefix.length);

  return { origins, routes, defaultOrigin: "legacy" };
}

/** Resolve the upstream origin URL for a given request path. */
export function resolveTarget(table: RoutingTable, path: string): string {
  for (const route of table.routes) {
    if (path === route.prefix || path.startsWith(route.prefix)) {
      const target = table.origins[route.origin];
      if (target) return target;
    }
  }
  const fallback = table.origins[table.defaultOrigin];
  if (!fallback) {
    throw new RoutingConfigError(`Default origin "${table.defaultOrigin}" is not defined`);
  }
  return fallback;
}
