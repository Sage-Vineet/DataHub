/**
 * The refusals that keep the harness away from production (design D3).
 *
 * Two independent checks, because they fail differently: one is a statement about
 * configuration (this URL looks like production) and the other is a fact about the
 * target (this database says it is staging). Either alone is defeatable — a
 * connection string can be rewritten, and a marker table can be absent in a
 * database nobody seeded — so both must pass, and both run before a single request
 * is issued.
 *
 * A parity tool that can write to production is a worse risk than the drift it
 * detects.
 */

export class ParityRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParityRefusal";
  }
}

/** Hosts that must never be a parity target. Comma-separated in the environment. */
export function productionHosts(env: NodeJS.ProcessEnv): string[] {
  return (env.PARITY_PRODUCTION_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuse a target whose host is on the production list. An unparseable connection
 * string is also refused: "I could not tell" is not "it is safe".
 */
export function assertNotProduction(connectionString: string, env: NodeJS.ProcessEnv): void {
  const hosts = productionHosts(env);
  const host = hostOf(connectionString);
  if (host === null) {
    throw new ParityRefusal(
      "Refusing to run: DATABASE_URL could not be parsed, so the target host could not be " +
        "checked against PARITY_PRODUCTION_HOSTS. An unverifiable target is treated as production.",
    );
  }
  if (hosts.length === 0) {
    throw new ParityRefusal(
      "Refusing to run: PARITY_PRODUCTION_HOSTS is not set, so no host can be excluded. " +
        "Set it (even to a single production hostname) so the refusal has something to check.",
    );
  }
  if (hosts.includes(host)) {
    throw new ParityRefusal(
      `Refusing to run against ${host}: it is listed in PARITY_PRODUCTION_HOSTS. ` +
        "The parity harness never targets production.",
    );
  }
}

export interface StagingMarker {
  seededAt: string;
  source: string;
}

export interface MarkerReader {
  /** Returns the staging marker, or null when the target has none. */
  read(): Promise<StagingMarker | null>;
}

/**
 * Refuse a target that does not carry the marker the seed process writes. This is
 * what stops the harness from running against a database that merely *is not* on
 * the production list — an unseeded environment, a colleague's local copy, or a
 * restored snapshot nobody anonymized.
 */
export async function assertStagingTarget(reader: MarkerReader): Promise<StagingMarker> {
  const marker = await reader.read();
  if (!marker) {
    throw new ParityRefusal(
      "Refusing to run: the target reports no staging marker. Only an environment seeded by " +
        "the parity seed process (which also rewrites contact identifiers) is a valid target.",
    );
  }
  return marker;
}

export interface HarnessGuardOptions {
  connectionString: string;
  env: NodeJS.ProcessEnv;
  marker: MarkerReader;
}

/** Run every refusal. Throws `ParityRefusal` before any request is issued. */
export async function assertSafeTarget(options: HarnessGuardOptions): Promise<StagingMarker> {
  assertNotProduction(options.connectionString, options.env);
  return assertStagingTarget(options.marker);
}

/** Mutating verbs are opt-in, and only ever against a marked staging target. */
export function mutationAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.PARITY_ALLOW_MUTATION === "true";
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}
