/**
 * Target refusals — the checks that keep a parity run away from production.
 *
 * The harness authenticates as real personas and, with `allowMutating`, writes to
 * both upstreams. `scenario.ts` already says mutating scenarios are "safe on
 * staging, never against production data", but that was a property of the config
 * someone typed rather than something the tool enforced. These make it enforced.
 *
 * Two independent checks, because they fail differently: one is a statement about
 * configuration (this URL looks like production) and the other is a fact about the
 * target (this database says it was seeded as staging). A connection string can be
 * rewritten and a marker can be absent from a database nobody seeded, so both must
 * pass — and both run before a single request is issued.
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

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuse any upstream whose host is on the production list. An unparseable URL is
 * refused too: "I could not tell" is not "it is safe".
 */
export function assertNotProduction(urls: ReadonlyArray<string>, env: NodeJS.ProcessEnv): void {
  const hosts = productionHosts(env);
  if (hosts.length === 0) {
    throw new ParityRefusal(
      "Refusing to run: PARITY_PRODUCTION_HOSTS is not set, so no host can be excluded. " +
        "Set it (even to a single production hostname) so the refusal has something to check.",
    );
  }
  for (const url of urls) {
    const host = hostOf(url);
    if (host === null) {
      throw new ParityRefusal(
        `Refusing to run: "${url}" could not be parsed, so its host could not be checked ` +
          "against PARITY_PRODUCTION_HOSTS. An unverifiable target is treated as production.",
      );
    }
    if (hosts.includes(host)) {
      throw new ParityRefusal(
        `Refusing to run against ${host}: it is listed in PARITY_PRODUCTION_HOSTS. ` +
          "The parity harness never targets production.",
      );
    }
  }
}

export interface StagingMarker {
  seededAt: string;
  source: string;
}

/**
 * Reads the marker the seed process writes (see `seed.ts`). Injected so the CLI
 * can supply a database-backed reader while tests supply a stub.
 */
export interface MarkerReader {
  read(): Promise<StagingMarker | null>;
}

/**
 * Refuse a target that does not carry the marker the seed writes. This is what
 * stops a run against a database that merely *is not on the production list* — an
 * unseeded environment, a colleague's local copy, or a restored snapshot nobody
 * anonymized (and whose real email addresses a reset scenario would mail).
 */
export async function assertStagingTarget(reader: MarkerReader): Promise<StagingMarker> {
  const marker = await reader.read();
  if (!marker) {
    throw new ParityRefusal(
      "Refusing to run: the target reports no staging marker. Only an environment seeded by " +
        "the parity seed (which also rewrites contact identifiers) is a valid target.",
    );
  }
  return marker;
}

export interface GuardOptions {
  urls: ReadonlyArray<string>;
  env: NodeJS.ProcessEnv;
  /** Omitted → the marker check is skipped, which only a read-only run may do. */
  marker?: MarkerReader;
  allowMutating?: boolean;
}

/**
 * Run every refusal. Throws `ParityRefusal` before any request is issued.
 *
 * The marker reader is optional for a read-only run — a GET against the wrong
 * environment is a wasted run, not a mutation — but it is REQUIRED once mutating
 * scenarios are enabled, because that is when the harness starts writing.
 */
export async function assertSafeTarget(options: GuardOptions): Promise<StagingMarker | null> {
  assertNotProduction(options.urls, options.env);
  if (!options.marker) {
    if (options.allowMutating) {
      throw new ParityRefusal(
        "Refusing to run mutating scenarios without a staging-marker check: writes need proof " +
          "the target was seeded as staging, not just proof it is not on the production list.",
      );
    }
    return null;
  }
  return assertStagingTarget(options.marker);
}
