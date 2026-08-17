import type { HttpRequest } from "./http.js";
import type { NormalizeSpec } from "./normalize.js";

/** Which seeded identity the request is made as. */
export type Persona = "admin" | "broker" | "client" | "anonymous";

export interface Scenario {
  /** Stable id, used to select and to report. */
  id: string;
  /** Domain this belongs to — matches the module flag it gates. */
  domain: Domain;
  /**
   * The delta-spec requirement this exercises, e.g.
   * "companies-domain > Tenant-scoped company listing > Non-admin is scoped".
   * Keeps the suite traceable to the delta specs under `openspec/changes/<change>/specs/` rather
   * than being an unmoored pile of curl commands.
   */
  spec: string;
  persona: Persona;
  request: HttpRequest;
  normalize?: NormalizeSpec;
  /**
   * True when the request changes state. Mutating scenarios run against BOTH
   * upstreams and therefore write twice to the shared database — safe on
   * staging, never against production data. The runner skips them unless
   * explicitly allowed.
   */
  mutating?: boolean;
  /**
   * Optional absolute expectation. Parity is the primary signal, but for a few
   * cases (401 on an anonymous call) "both sides are wrong in the same way"
   * should not read as success.
   */
  expectStatus?: number;
}

export type Domain =
  | "auth"
  | "companies"
  | "users"
  | "folders"
  | "uploads"
  | "requests"
  | "messages"
  | "reports";

export const DOMAINS: readonly Domain[] = [
  "auth",
  "companies",
  "users",
  "folders",
  "uploads",
  "requests",
  "messages",
  "reports",
];

/** The flag that must be ON for a domain's module to serve its routes. */
export const DOMAIN_FLAG: Readonly<Record<Domain, string>> = {
  auth: "BETTER_AUTH_ENABLED",
  companies: "COMPANIES_MODULE_ENABLED",
  users: "USERS_MODULE_ENABLED",
  folders: "FOLDERS_MODULE_ENABLED",
  uploads: "UPLOADS_MODULE_ENABLED",
  requests: "REQUESTS_MODULE_ENABLED",
  messages: "MESSAGES_MODULE_ENABLED",
  reports: "REPORTS_MODULE_ENABLED",
};

/**
 * Normalisation shared by every domain: server-generated identity and audit
 * columns. Kept deliberately explicit — a blanket `**.*_id` rule would mask
 * genuine foreign-key mistakes, which is precisely the class of bug a rewrite
 * introduces.
 */
export const COMMON_VOLATILE: readonly string[] = [
  "**.id",
  "**.created_at",
  "**.updated_at",
  "**.createdAt",
  "**.updatedAt",
];
