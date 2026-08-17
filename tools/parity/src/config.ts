import { readFileSync } from "node:fs";
import type { PersonaCredentials } from "./auth.js";

/**
 * Parity runs need identities to act as and rows to act on. Both are properties
 * of the environment, not of the code, so they are supplied by config rather
 * than hard-coded: staging seeded from a production snapshot will have different
 * ids every time it is refreshed.
 *
 * Scenarios are therefore written as functions of `Fixtures`, which keeps them
 * declarative while staying honest about what they depend on.
 */

export interface Fixtures {
  /** A company the broker/client personas can access. */
  companyId: string;
  /** A company they CANNOT access — the cross-tenant control. */
  foreignCompanyId: string;
  /** A folder inside `companyId`. */
  folderId?: string;
  /** A user visible to the broker persona. */
  userId?: string;
  /** A key-report version inside `companyId`. */
  reportVersionId?: string;
  /** A request inside `companyId`. */
  requestId?: string;
  /** A second user, for direct-message scenarios. */
  recipientUserId?: string;
}

export interface ParityConfig {
  controlUrl: string;
  candidateUrl: string;
  credentials: PersonaCredentials;
  fixtures: Fixtures;
  allowMutating?: boolean;
  timeoutMs?: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`parity config: "${field}" is required and must be a non-empty string.`);
  }
  return value;
}

function parseConfig(raw: unknown, source: string): ParityConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`parity config at ${source} must be a JSON object.`);
  }
  const cfg = raw as Record<string, unknown>;
  const fixtures = (cfg.fixtures ?? {}) as Record<string, unknown>;
  const credentials = (cfg.credentials ?? {}) as PersonaCredentials;

  if (Object.keys(credentials).length === 0) {
    throw new ConfigError(
      `parity config at ${source}: "credentials" must define at least one persona ` +
        `(admin/broker/client), otherwise every authenticated scenario errors.`,
    );
  }

  return {
    controlUrl: requireString(cfg.controlUrl, "controlUrl"),
    candidateUrl: requireString(cfg.candidateUrl, "candidateUrl"),
    credentials,
    fixtures: {
      companyId: requireString(fixtures.companyId, "fixtures.companyId"),
      foreignCompanyId: requireString(fixtures.foreignCompanyId, "fixtures.foreignCompanyId"),
      folderId: fixtures.folderId as string | undefined,
      userId: fixtures.userId as string | undefined,
      reportVersionId: fixtures.reportVersionId as string | undefined,
      requestId: fixtures.requestId as string | undefined,
      recipientUserId: fixtures.recipientUserId as string | undefined,
    },
    allowMutating: cfg.allowMutating === true,
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : undefined,
  };
}

export function loadConfig(path: string): ParityConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(
      `Could not read parity config "${path}". Copy tools/parity/parity.config.example.json ` +
        `and fill in the URLs, credentials and fixture ids for your environment.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`parity config "${path}" is not valid JSON: ${String(err)}`);
  }
  return parseConfig(raw, path);
}

export { parseConfig as parseConfigForTest };
