import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived proof that an email address was verified by OTP.
 *
 * Broker signup is two requests: verify the code, then create the account. The
 * second has to know the first happened, or anyone can register any address.
 *
 * Legacy issued a JWT for this, signed with the application secret itself — the
 * same key that signs sessions — so a bug that accepted a session token here
 * would have accepted it as a verification grant, and vice versa.
 *
 * The application secret is still the root of trust (there is only one secret to
 * deploy), but it is never used directly: the signing key is derived from it
 * under a fixed purpose label, so a grant cannot be produced by anything that
 * signs with the raw secret, and this key cannot sign anything else. The grant
 * carries no user and grants no access on its own — it proves one address was
 * verified, and expires in minutes.
 *
 * Stateless by design — there is no verification table to grow, and a grant
 * that is never redeemed simply expires.
 */

/** How long a grant stays valid. Long enough to fill in a signup form. */
export const GRANT_TTL_MS = 15 * 60 * 1000;

const VERSION = "v1";

/**
 * Field separator inside the payload.
 *
 * Not a dot: an email address contains dots, so splitting on one puts
 * "broker@example" and "com" in the first two fields and loses the expiry. That
 * is a real bug this file had, and the test that caught it is the first one in
 * `verification-grant.test.ts`. A pipe cannot appear in an address.
 */
const SEP = "|";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Domain separation: the signing key is derived from the application secret
 * under this label rather than being the secret itself. Changing the label
 * invalidates every outstanding grant, which is the intended way to revoke them.
 */
const PURPOSE = "datahub/email-verification-grant/v1";

function signingKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(PURPOSE).digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
}

/** Issue a grant for a verified address. */
export function issueVerificationGrant(email: string, secret: string, now: number): string {
  const expiresAt = now + GRANT_TTL_MS;
  const payload = [VERSION, normalizeEmail(email), String(expiresAt)].join(SEP);
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload, secret)}`;
}

export type GrantFailure = "malformed" | "bad-signature" | "expired" | "email-mismatch";

export interface GrantResult {
  ok: boolean;
  reason?: GrantFailure;
}

/**
 * Check a grant against the address being registered.
 *
 * The email is checked as well as the signature: a valid grant for
 * `attacker@example.com` must not authorize creating `victim@example.com`.
 */
export function verifyVerificationGrant(
  token: string,
  email: string,
  secret: string,
  now: number,
): GrantResult {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  let payload: string;
  try {
    payload = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const expected = sign(payload, secret);
  const given = parts[1];
  // Constant-time, and length-guarded because `timingSafeEqual` throws on a
  // length mismatch rather than returning false.
  if (given.length !== expected.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return { ok: false, reason: "bad-signature" };
  }

  const [version, grantedEmail, expiresAtRaw] = payload.split(SEP);
  if (version !== VERSION || !grantedEmail || !expiresAtRaw) {
    return { ok: false, reason: "malformed" };
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };

  if (grantedEmail !== normalizeEmail(email)) return { ok: false, reason: "email-mismatch" };

  return { ok: true };
}
