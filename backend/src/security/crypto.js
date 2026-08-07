"use strict";

/**
 * Authenticated field-level encryption for data at rest (AES-256-GCM).
 *
 * WHY: Supabase encrypts the volume, but volume encryption only protects
 * against physical disk theft. It does not protect against a leaked service-role
 * key, a SQL injection that reaches a dump, a rogue backup, or an over-broad
 * support query. Encrypting the highest-value columns (OAuth refresh tokens,
 * banking identifiers) means an attacker who obtains the database still cannot
 * use its most dangerous contents without a key held separately in the runtime
 * environment.
 *
 * GCM is used rather than CBC so that ciphertext tampering is detected on
 * decrypt rather than producing attacker-influenced plaintext.
 *
 * Format: v1:<base64url iv>:<base64url authTag>:<base64url ciphertext>
 */

const crypto = require("crypto");
const { config } = require("../config/env");
const logger = require("./logger");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size
const AUTH_TAG_LENGTH = 16;
const VERSION = "v1";

const key = config.DATA_ENCRYPTION_KEY;
const isEnabled = Boolean(key);

if (!isEnabled) {
  logger.warn("field_encryption_disabled", {
    reason: "DATA_ENCRYPTION_KEY not configured",
  });
}

/**
 * Encrypts a UTF-8 string. Returns null for null/undefined input so the helper
 * can be dropped into an ORM mapping without special-casing empty columns.
 *
 * Throws if encryption is not configured — callers must not silently persist
 * plaintext into a column that is expected to hold ciphertext.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  if (!isEnabled) {
    throw new Error("DATA_ENCRYPTION_KEY is not configured — cannot encrypt.");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypts a value produced by encrypt().
 *
 * A value that is not in the expected envelope format is returned unchanged.
 * That is deliberate: it allows a gradual migration where a column holds a mix
 * of legacy plaintext and new ciphertext. Once backfilled, set
 * `strict: true` to reject anything unencrypted.
 */
function decrypt(value, { strict = false } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value);

  if (!text.startsWith(`${VERSION}:`)) {
    if (strict) throw new Error("Value is not encrypted.");
    return text;
  }

  if (!isEnabled) {
    throw new Error("DATA_ENCRYPTION_KEY is not configured — cannot decrypt.");
  }

  const parts = text.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed ciphertext envelope.");
  }

  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const authTag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(dataPart, "base64url");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Malformed ciphertext envelope.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  // .final() throws if the auth tag does not verify — i.e. the ciphertext was
  // tampered with or encrypted under a different key.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Best-effort decrypt that logs and returns null instead of throwing. */
function tryDecrypt(value) {
  try {
    return decrypt(value);
  } catch (error) {
    logger.error("field_decrypt_failed", { name: error.name });
    return null;
  }
}

/**
 * SHA-256 hash used for blind-index lookups on encrypted columns.
 * Lets you query `WHERE token_hash = $1` without ever decrypting a whole table.
 */
function blindIndex(value) {
  if (value === null || value === undefined) return null;
  const hmacKey = key || Buffer.alloc(32);
  return crypto.createHmac("sha256", hmacKey).update(String(value)).digest("hex");
}

/** Constant-time string comparison — use for any secret equality check. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) {
    // Still perform a comparison to keep timing flat for unequal lengths.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** URL-safe random token, 256 bits of entropy by default. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** SHA-256 digest, hex encoded — for storing token fingerprints. */
function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

module.exports = {
  isEnabled,
  encrypt,
  decrypt,
  tryDecrypt,
  blindIndex,
  safeEqual,
  randomToken,
  sha256,
};
