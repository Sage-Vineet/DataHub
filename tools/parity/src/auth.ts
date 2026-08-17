import { cookieHeader, send } from "./http.js";
import { isRecord, type Json } from "./normalize.js";
import type { Persona } from "./scenario.js";

/**
 * Credential handling for BOTH auth engines at once.
 *
 * Legacy issues a JWT in the response body and expects `Authorization: Bearer`.
 * Better Auth establishes an httpOnly cookie session (ADR-0007, M2/M3) while its
 * router preserves the legacy JSON shape, so it may return a token too. Rather
 * than branch on which engine is live — the harness must work across the flip,
 * including mid-rollback — we send whatever the login response yielded: bearer
 * token if present, cookie if present, usually both.
 */

export interface Credentials {
  email: string;
  password: string;
}

export type PersonaCredentials = Partial<Record<Exclude<Persona, "anonymous">, Credentials>>;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

function extractToken(body: Json): string | undefined {
  if (!isRecord(body)) return undefined;
  for (const key of ["token", "accessToken", "access_token"]) {
    const value = body[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const data = body.data ?? null;
  if (isRecord(data)) {
    for (const key of ["token", "accessToken"]) {
      const value = data[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return undefined;
}

/** Log in against one upstream and return the headers that authenticate it. */
export async function login(
  baseUrl: string,
  credentials: Credentials,
): Promise<Record<string, string>> {
  const response = await send(baseUrl, {
    method: "POST",
    path: "/auth/login",
    body: { email: credentials.email, password: credentials.password },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new AuthError(
      `Login failed at ${baseUrl} for ${credentials.email}: ${response.status} ` +
        `${JSON.stringify(response.body)}`,
    );
  }

  const headers: Record<string, string> = {};
  const token = extractToken(response.body);
  if (token) headers.authorization = `Bearer ${token}`;
  const cookie = cookieHeader(response.setCookie);
  if (cookie) headers.cookie = cookie;

  if (Object.keys(headers).length === 0) {
    throw new AuthError(
      `Login at ${baseUrl} for ${credentials.email} returned 2xx but neither a token ` +
        `nor a session cookie — the harness cannot authenticate subsequent requests.`,
    );
  }
  return headers;
}

/**
 * Resolve auth headers per persona per upstream, once, and cache them.
 *
 * Both upstreams are authenticated independently and deliberately: during a
 * cutover they are two different auth engines, and a session minted by one is
 * not assumed to work on the other. (Whether it *does* is the point of the
 * `JWT_SECRET` cross-validation check, not something to bake in here.)
 */
export class SessionPool {
  private readonly cache = new Map<string, Record<string, string>>();

  constructor(private readonly credentials: PersonaCredentials) {}

  async headersFor(baseUrl: string, persona: Persona): Promise<Record<string, string>> {
    if (persona === "anonymous") return {};
    const key = `${baseUrl}::${persona}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const creds = this.credentials[persona];
    if (!creds) {
      throw new AuthError(
        `No credentials configured for persona "${persona}". Set them in the parity ` +
          `config so scenarios using this persona can run.`,
      );
    }
    const headers = await login(baseUrl, creds);
    this.cache.set(key, headers);
    return headers;
  }
}
