/**
 * Boot-time environment validation for the gateway.
 *
 * A flag the process quietly ignores is indistinguishable from a feature that
 * was never switched on. `QA_MODULE_ENABLED=1` or `=TRUE` reads as "off" to a
 * loose parser, so an operator can flip one, see a clean boot, and believe a
 * capability is live when it is not.
 *
 * So the flags are parsed strictly: exactly "true" or "false", anything else is a
 * startup error naming the variable. Same for PORT, which otherwise coerces junk to
 * NaN and listens on a random port.
 *
 * Follows the existing loader style (`loadAuthConfig`, `loadBetterAuthConfig`) —
 * throw with a message that says what to fix, rather than starting misconfigured.
 */

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

/**
 * Every capability flag.
 *
 * These were once two lists. Twenty-one of them were CUTOVER flags — off meant
 * "fall through to the legacy backend", on meant "serve it here" — and they are
 * gone, because there is no legacy backend to fall through to and a flag with
 * one legal value is not a flag. Their modules mount unconditionally.
 *
 * What is left is the kill switches: features with no predecessor anywhere, so
 * switching one off subtracts it rather than rolling anything back.
 */
export const MODULE_FLAGS = [
  "BETTER_AUTH_ENABLED",
  "QOE_MODULE_ENABLED",
  // A mistyped value silently meaning "off" would be an audit log nobody
  // notices is absent, which is why these are parsed strictly.
  "ACTIVITY_LOG_ENABLED",
  //
  // Sub-flags rather than one per module, deliberately. The demo commitment is
  // that a single unfinished feature can be switched off 48 hours out without
  // losing the module around it — an all-or-nothing flag would force a choice
  // between shipping something broken and shipping nothing.
  "DATAROOM_MODULE_ENABLED",
  "DATAROOM_VERSIONS_ENABLED",
  "DATAROOM_COMMENTS_ENABLED",
  "DATAROOM_CHUNKED_UPLOAD_ENABLED",
  "QA_MODULE_ENABLED",
  "QA_PRESENTATION_ENABLED",
  "QA_NOMINATIONS_ENABLED",
  "CIM_MODULE_ENABLED",
  // The chart-of-accounts reasonableness review. Advisory: no report engine
  // reads its output, so switching it off removes a review queue and changes no
  // figure anywhere. Generation additionally needs GEMINI_API_KEY — without one
  // the module still serves, and only generating new recommendations reports
  // unavailable.
  "COA_REVIEW_MODULE_ENABLED",
] as const;

export type ModuleFlag = (typeof MODULE_FLAGS)[number];

/**
 * Parse a boolean flag strictly. Unset is `false`; any value other than
 * "true"/"false" is a configuration error.
 *
 * Unset meaning off was once described here as "the safe default: fall through
 * to legacy". It is no longer a fallback — every flag left is a capability, and
 * off means the feature is absent.
 */
export function parseFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim();
  if (value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new EnvConfigError(
    `${name} must be exactly "true" or "false" (got "${raw}"). ` +
      `A value like "1", "TRUE" or "yes" would be read as OFF, silently leaving the ` +
      `route-group on legacy — refusing to start rather than fake a cutover.`,
  );
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8080;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EnvConfigError(`PORT must be an integer between 1 and 65535 (got "${raw}").`);
  }
  return port;
}

export interface GatewayEnv {
  port: number;
  corsOrigins: string[];
  flags: Readonly<Record<ModuleFlag, boolean>>;
}

/**
 * Validate the gateway's own environment: the capability flags and the port.
 *
 * Secrets and `DATABASE_URL` are validated by the auth and db loaders, at the
 * point they are actually needed. Upstream routing used to be validated here
 * too, by `parseRoutingTable`; there are no upstreams.
 */
export function loadGatewayEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  const flags = Object.fromEntries(
    MODULE_FLAGS.map((name) => [name, parseFlag(name, env[name])]),
  ) as Record<ModuleFlag, boolean>;

  return {
    port: parsePort(env.PORT),
    corsOrigins: (env.AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    flags,
  };
}
