import { compareResponses, type Invariant, type ResponseSnapshot } from "./comparator.js";
import { assertSafeTarget, isMutating, mutationAllowed, type MarkerReader } from "./guards.js";
import { allRouteSets, parseRouteKey } from "./routes.js";
import type {
  DomainReport,
  EndpointVerdict,
  ParityReport,
  SkippedEndpoint,
} from "./report.js";

/**
 * The parity runner.
 *
 * It issues the same request to both engines and reports how the answers differ.
 * What it deliberately does NOT do is decide anything: a green report is evidence
 * for a person to act on, never an automatic flip, because the request set only
 * covers what it covers. That is why coverage travels with the verdicts
 * everywhere.
 */

export interface RequestSpec {
  method: string;
  /** Concrete path with parameters substituted, e.g. `/companies/<uuid>`. */
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Issues a request against one engine. Injected so tests need no network. */
export type Transport = (engine: "legacy" | "module", spec: RequestSpec) => Promise<ResponseSnapshot>;

/**
 * Turns a route template into a concrete request. Returning `null` means "cannot
 * build a valid request for this route" — reported as a skip with its reason, not
 * quietly dropped.
 */
export type FixtureResolver = (route: {
  domain: string;
  method: string;
  path: string;
}) => RequestSpec | null;

/**
 * A fixture may declare that its route needs an authenticated session. The
 * harness then skips it with `auth-required` unless a session token is configured
 * — a distinct reason from "no fixture", because the fix is different: one needs
 * a seeded user, the other needs a request body.
 */
export interface AuthenticatedRequestSpec extends RequestSpec {
  requiresAuth?: boolean;
}

export interface HarnessOptions {
  connectionString: string;
  env: NodeJS.ProcessEnv;
  marker: MarkerReader;
  transport: Transport;
  fixtures: FixtureResolver;
  /** Per-route semantic assertions, keyed by `METHOD /path`. */
  invariants?: Record<string, ReadonlyArray<Invariant>>;
  /** Restrict the run to these domains; default is all of them. */
  domains?: ReadonlyArray<string>;
  /** Session token for fixtures that declare `requiresAuth`. */
  sessionToken?: string;
}

export async function runParity(options: HarnessOptions): Promise<ParityReport> {
  // Every refusal runs before a single request is issued.
  const marker = await assertSafeTarget({
    connectionString: options.connectionString,
    env: options.env,
    marker: options.marker,
  });
  const allowMutation = mutationAllowed(options.env);

  const routeSets = allRouteSets();
  const domains = options.domains ?? Object.keys(routeSets);
  const reports: DomainReport[] = [];

  for (const domain of domains) {
    const set = routeSets[domain];
    if (!set) continue;

    const verdicts: EndpointVerdict[] = [];
    const skipped: SkippedEndpoint[] = [];

    // Module-only endpoints have nothing on the other side to compare against.
    // They are reported rather than omitted, so the report accounts for the whole
    // claimed surface.
    for (const route of set.additive) {
      skipped.push({ route, reason: "additive-endpoint" });
    }

    for (const route of set.compare) {
      const { method, path } = parseRouteKey(route);

      if (isMutating(method) && !allowMutation) {
        skipped.push({ route, reason: "mutation-not-permitted" });
        continue;
      }

      const spec = options.fixtures({ domain, method, path }) as AuthenticatedRequestSpec | null;
      if (!spec) {
        skipped.push({ route, reason: "no-fixture" });
        continue;
      }
      if (spec.requiresAuth && !options.sessionToken) {
        skipped.push({ route, reason: "auth-required" });
        continue;
      }

      try {
        // Sequential, not parallel: the two engines share one database, and
        // overlapping mutating requests would make a difference in the response
        // indistinguishable from a difference in the data underneath it.
        const authorized: RequestSpec = options.sessionToken
          ? {
              ...spec,
              headers: { ...spec.headers, authorization: `Bearer ${options.sessionToken}` },
            }
          : spec;
        const legacy = await options.transport("legacy", authorized);
        const module = await options.transport("module", authorized);
        const result = compareResponses(legacy, module, options.invariants?.[route] ?? []);
        verdicts.push({
          route,
          verdict: result.verdict,
          differences: result.differences,
          latency: result.latency,
        });
      } catch (error) {
        skipped.push({
          route,
          reason: "request-failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    reports.push({ domain, total: set.compare.length, verdicts, skipped });
  }

  return {
    target: options.connectionString.replace(/\/\/[^@]*@/, "//***@"),
    seededAt: marker.seededAt,
    mutationAllowed: allowMutation,
    domains: reports,
  };
}
