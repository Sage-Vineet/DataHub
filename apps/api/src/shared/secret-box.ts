import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated encryption for secrets that have to live in the database.
 *
 * WHY THIS EXISTS
 * ---------------
 * A QuickBooks refresh token is a standing key to a client's accounting
 * system. It does not expire on its own, it survives password changes, and it
 * is not something the client can see or revoke without going into Intuit. A
 * database read that yields one is not "some rows leaked" — it is ongoing
 * access to the books of every company on the platform.
 *
 * Legacy stored access and refresh tokens as plain text columns.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT AGAINST
 * -------------------------------------------
 * It protects a stolen dump, a backup, a replica, a mis-scoped read grant, or
 * a SQL-injection read: the ciphertext is useless without the application
 * secret, which lives in the environment and not the database.
 *
 * It does NOT protect against an attacker who has the running process, or the
 * environment it runs in. Nothing at this layer can. Anything stronger means a
 * KMS holding the key outside the application, which is a deployment decision
 * rather than a code one — and this is shaped so that swapping the key
 * derivation for a KMS call is a change to one function.
 *
 * THE CONSTRUCTION
 * ----------------
 * AES-256-GCM. The key is derived from the application secret under a fixed
 * purpose label, the same way `verification-grant.ts` derives its signing key,
 * so a value sealed for one purpose cannot be opened as another even though
 * there is only one secret to deploy. The purpose is also passed as additional
 * authenticated data, which makes that a cryptographic guarantee rather than a
 * convention.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
/** GCM's standard nonce length. Longer is not better here; it is just slower. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/**
 * Derive a purpose-bound key from the application secret.
 *
 * Replace this one function with a KMS call to move the key out of the
 * process; nothing else here needs to change.
 */
function keyFor(secret: string, purpose: string): Buffer {
  if (!secret) throw new SecretBoxError("A secret is required to seal or open a value.");
  if (!purpose) throw new SecretBoxError("A purpose label is required.");
  return createHmac("sha256", secret).update(`secret-box/${VERSION}/${purpose}`).digest();
}

/**
 * Encrypt a value.
 *
 * The output is `v1.<iv>.<tag>.<ciphertext>`, base64url throughout — safe in a
 * text column, a URL, or a log line that should not have contained it.
 *
 * Sealing the same value twice gives different ciphertext, because the nonce is
 * random. That is the point: identical output would leak that two companies
 * share a token, or that a token has not been rotated.
 */
export function seal(plaintext: string, secret: string, purpose: string): string {
  const key = keyFor(secret, purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(purpose, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a value, or return null.
 *
 * A missing secret still throws: that is a deployment fault the operator has to
 * see, and it is not the same thing as a value that failed to authenticate.
 *
 * Null rather than a throw for anything that fails to open — a wrong secret, a
 * tampered ciphertext, a value sealed for a different purpose, or a column that
 * turns out to hold something else entirely. The caller's response to all of
 * those is the same: treat the connection as broken and make the user
 * reconnect. Distinguishing them in the return value would tell an attacker
 * which part of their guess was right.
 */
export function open(sealed: string, secret: string, purpose: string): string | null {
  if (!sealed) return null;

  const parts = sealed.split(".");
  if (parts.length !== 4) return null;

  const [version, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
  // Compared in constant time out of habit rather than necessity — the version
  // is not secret, but this is the kind of place where habits matter.
  const versionBuffer = Buffer.from(version, "utf8");
  const expected = Buffer.from(VERSION, "utf8");
  if (versionBuffer.length !== expected.length || !timingSafeEqual(versionBuffer, expected)) {
    return null;
  }

  // Derived OUTSIDE the try, so a missing secret throws rather than returning
  // null. A misconfigured deployment would otherwise read as "every connection
  // is broken, reconnect" — a plausible and completely wrong diagnosis that
  // would march every user through a reconnect flow that could not succeed.
  const key = keyFor(secret, purpose);

  try {
    const iv = Buffer.from(ivPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // `final()` throws when the tag does not verify, which is the whole point.
    return null;
  }
}

/**
 * Does this look like something `open` could work on?
 *
 * For telling a sealed column apart from one holding a legacy plaintext token,
 * without attempting decryption and without ever logging either.
 */
export function isSealed(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === VERSION;
}
