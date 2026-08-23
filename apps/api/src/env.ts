/**
 * Boot-time environment validation for the gateway.
 *
 * The cutover mechanism is "flip a flag and restart" (ADR-0003), which makes the
 * flags themselves operational surface: a value the process quietly ignores is
 * indistinguishable from a cutover that did not happen. `COMPANIES_MODULE_ENABLED=1`
 * or `=TRUE` currently reads as "off", so an operator can flip a flag, see a clean
 * boot, and believe a domain migrated when it did not.
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

/** Every module cutover flag, in the documented flip order. */
export const MODULE_FLAGS = [
  "BETTER_AUTH_ENABLED",
  "AUTH_MODULE_ENABLED",
  "COMPANIES_MODULE_ENABLED",
  "USERS_MODULE_ENABLED",
  "FOLDERS_MODULE_ENABLED",
  "UPLOADS_MODULE_ENABLED",
  "REQUESTS_MODULE_ENABLED",
  "MESSAGES_MODULE_ENABLED",
  "GROUPS_MODULE_ENABLED",
  "ACTIVITY_MODULE_ENABLED",
  "WORKSPACE_MODULE_ENABLED",
  "CHART_OF_ACCOUNTS_MODULE_ENABLED",
  "REPORTS_MODULE_ENABLED",
  "QOE_MODULE_ENABLED",
  "BANK_RECONCILIATION_MODULE_ENABLED",
  "REPORT_SOURCES_MODULE_ENABLED",
  "STATEMENTS_MODULE_ENABLED",
  "QUICKBOOKS_MODULE_ENABLED",
  "SYNC_MODULE_ENABLED",
  // Not a cutover flag: activity capture has no legacy predecessor to fall back
  // to. It is parsed here so it gets the same strict validation — a mistyped
  // value silently meaning "off" would be an audit log nobody notices is absent.
  "ACTIVITY_LOG_ENABLED",
  // Greenfield capabilities, like QoE and the activity log: legacy serves none of
  // these prefixes, so flipping one off is a kill switch rather than a rollback.
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
  // Not a capability — plumbing. Re-signs the gateway's session into the HS256
  // shape legacy verifies, so routes that have not been cut over yet keep
  // working for a cookie-session caller. Flagged so it can be switched off in
  // one step once the last route-group moves in-process (see legacy-bridge.ts).
  "LEGACY_AUTH_BRIDGE_ENABLED",
] as const;

export type ModuleFlag = (typeof MODULE_FLAGS)[number];

/**
 * Parse a boolean flag strictly. Unset is `false` (the safe default: fall through
 * to legacy); any value other than "true"/"false" is a configuration error.
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
 * Validate the gateway's own environment. Upstream routing (`LEGACY_ORIGIN`,
 * `GATEWAY_ROUTES`) is validated by `parseRoutingTable`; secrets and
 * `DATABASE_URL` by the auth/db loaders when a module is actually enabled.
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
