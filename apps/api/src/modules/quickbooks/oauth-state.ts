import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `state` a QuickBooks OAuth round trip carries, and back again.
 *
 * WHY THIS IS SIGNED
 * ------------------
 * The callback is necessarily unauthenticated — Intuit redirects a browser to
 * it, carrying no session — so everything it acts on comes out of the URL. The
 * version this replaces put the state on the wire as plain JSON:
 *
 *   { redirect, companyId, clientId, role, userId, nonce }
 *
 * and read `companyId` and `userId` straight back out of it. Anyone completing
 * an OAuth flow could therefore name ANY company as the one to attach their
 * realm to, and any user as the person who did it. The `nonce` looks like CSRF
 * protection and is not: it appears exactly once in that file, where it is
 * generated, and is never stored or checked.
 *
 * Here the payload is signed with the application secret and carries an
 * expiry, so the callback can tell a state IT issued from one somebody wrote.
 * That is the whole security property of the flow: the redirect is public, the
 * code is single-use, and which company gets the connection is decided by this
 * signature.
 */

/** How long a started authorization stays valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthState {
  /** Where in the SPA to return to. A path, never a URL — see `safeRedirect`. */
  redirect: string;
  /** The company the connection is for. Null when it is decided at callback. */
  companyId: string | null;
  /** Who started it, so the connection records a real person. */
  userId: string;
  /** When this state stops being accepted, epoch milliseconds. */
  expiresAt: number;
}

const PURPOSE = "quickbooks/oauth-state";

function sign(body: string, secret: string): string {
  return createHmac("sha256", `${PURPOSE}:${secret}`).update(body).digest("base64url");
}

/** Pack and sign a state for the authorize redirect. */
export function signOAuthState(
  state: Omit<OAuthState, "expiresAt">,
  secret: string,
  now: Date = new Date(),
): string {
  const payload: OAuthState = { ...state, expiresAt: now.getTime() + OAUTH_STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Read a state back, or null if it is not one this server issued.
 *
 * Null rather than a thrown error, and null for every reason: a tampered
 * state, an expired one and a malformed one are the same answer to the caller
 * — start again — and distinguishing them in the response tells somebody
 * probing which part they got wrong.
 */
export function readOAuthState(
  raw: unknown,
  secret: string,
  now: Date = new Date(),
): OAuthState | null {
  const text = String(raw ?? "");
  const dot = text.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = text.slice(0, dot);
  const provided = Buffer.from(text.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(body, secret), "base64url");
  // Length-checked first: `timingSafeEqual` throws on a mismatch rather than
  // answering false, and a thrown error here is a 500 for a bad signature.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;

  const state = payload as Partial<OAuthState>;
  if (typeof state.userId !== "string" || state.userId === "") return null;
  if (typeof state.expiresAt !== "number" || state.expiresAt <= now.getTime()) return null;

  return {
    redirect: safeRedirect(state.redirect),
    companyId: typeof state.companyId === "string" && state.companyId ? state.companyId : null,
    userId: state.userId,
    expiresAt: state.expiresAt,
  };
}

/** Where the SPA is sent when nothing more specific was asked for. */
export const DEFAULT_REDIRECT = "/broker/companies";

/**
 * Does this carry a character that could end the header it goes into?
 *
 * Checked by code point rather than by a regular expression: a character class
 * containing literal control characters is invisible in a diff, and reviewing
 * a security check nobody can see is not reviewing it.
 */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A redirect target that cannot leave this application.
 *
 * The value reaches us from a query string and ends up in a `Location` header.
 * Anything absolute — `https://elsewhere/`, or the protocol-relative
 * `//elsewhere` a naive check misses — makes this an open redirect, which is
 * worth more to a phisher than most bugs because the link genuinely starts on
 * the real site.
 */
export function safeRedirect(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (text === "" || !text.startsWith("/")) return DEFAULT_REDIRECT;
  // `//host` and `/\host` are both absolute to a browser.
  if (text.startsWith("//") || text.startsWith("/\\")) return DEFAULT_REDIRECT;
  // A control character can split the header itself.
  if (hasControlCharacter(text)) return DEFAULT_REDIRECT;
  return text;
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Intuit's own authorize host. Injected so a sandbox can be pointed at. */
  authorizeUrl?: string;
}

/** Intuit's accounting scope. The only one this product asks for. */
export const QUICKBOOKS_SCOPE = "com.intuit.quickbooks.accounting";

/**
 * Where to send the browser to start an authorization.
 *
 * `prompt=login consent select_company` is legacy's, and it is right: without
 * `select_company` Intuit silently reuses whichever realm the browser last
 * authorised, so a broker connecting a second client gets the first one's
 * books and nothing on screen says so.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizeUrl ?? "https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "login consent select_company");
  return url.toString();
}
