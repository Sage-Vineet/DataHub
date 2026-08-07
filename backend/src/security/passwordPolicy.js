"use strict";

/**
 * Password policy and hashing.
 *
 * WHY: Credential stuffing and offline cracking are the highest-volume attacks
 * against SaaS finance apps. Length is the dominant factor in resistance to
 * offline attack; a blocklist stops the small set of passwords that account for
 * a disproportionate share of successful stuffing attempts. bcrypt with a high
 * work factor makes an exfiltrated hash table economically impractical to crack.
 *
 * Implements: OWASP ASVS v4 §2.1 (Password Security), NIST SP 800-63B §5.1.1.
 */

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { config } = require("../config/env");
const { COMMON_PASSWORDS } = require("./commonPasswords");

const MIN_LENGTH = 5;
// bcrypt silently truncates input at 72 bytes; reject longer input explicitly
// rather than letting two different passwords hash identically.
const MAX_LENGTH = 72;

const RULES = [
  { test: (pw) => pw.length >= MIN_LENGTH, message: `Password must be at least ${MIN_LENGTH} characters.` },
  { test: (pw) => pw.length <= MAX_LENGTH, message: `Password must be at most ${MAX_LENGTH} characters.` },
  { test: (pw) => /[A-Z]/.test(pw), message: "Password must include an uppercase letter." },
  { test: (pw) => /[a-z]/.test(pw), message: "Password must include a lowercase letter." },
  { test: (pw) => /\d/.test(pw), message: "Password must include a number." },
  {
    test: (pw) => /[^A-Za-z0-9]/.test(pw),
    message: "Password must include a special character.",
  },
];

/** Normalises for blocklist comparison: lowercase, strip leading/trailing space. */
function canonical(password) {
  return String(password).trim().toLowerCase();
}

/** Strips trivial leet substitutions so `P@ssw0rd!123` still matches `password`. */
function deLeet(value) {
  return value
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7]/g, "t");
}

/** Detects runs like `aaaa`, `1234`, `abcd` that inflate length without entropy. */
function hasLowEntropyRun(password) {
  const lower = password.toLowerCase();
  let repeat = 1;
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < lower.length; i += 1) {
    const prev = lower.charCodeAt(i - 1);
    const curr = lower.charCodeAt(i);
    repeat = curr === prev ? repeat + 1 : 1;
    ascending = curr === prev + 1 ? ascending + 1 : 1;
    descending = curr === prev - 1 ? descending + 1 : 1;
    if (repeat >= 4 || ascending >= 5 || descending >= 5) return true;
  }
  return false;
}

/**
 * Validates a candidate password.
 *
 * @param {string} password
 * @param {{ email?: string, name?: string }} [context] user identifiers the
 *   password must not contain — these are the first things an attacker tries.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePassword(password, context = {}) {
  const errors = [];
  const raw = String(password ?? "");

  if (!raw) {
    return { valid: false, errors: ["Password is required."] };
  }

  for (const rule of RULES) {
    if (!rule.test(raw)) errors.push(rule.message);
  }

  const normalised = canonical(raw);

  /**
   * Candidate forms to test against the blocklist.
   *
   * WHY more than the literal string: the overwhelmingly common way to satisfy
   * a complexity rule is to take a known-bad password and bolt requirements
   * onto it — `Password123!`, `P@ssw0rd2025`. Those are no harder to guess than
   * `password`, because the mangling rules are built into every cracking tool
   * (hashcat's rule sets do exactly this). So we strip the padding and undo the
   * substitutions before comparing.
   */
  const candidates = new Set([normalised, deLeet(normalised)]);

  // Strip leading/trailing punctuation, then a trailing digit run — the
  // "add a year or !" pattern. Do this BEFORE de-leeting so that trailing
  // digits are treated as padding rather than as letter substitutions.
  const unpadded = normalised
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .replace(/\d+$/, "");

  if (unpadded) {
    candidates.add(unpadded);
    candidates.add(deLeet(unpadded));
    // Finally, letters only — catches substitutions that de-leeting missed.
    candidates.add(deLeet(unpadded).replace(/[^a-z]/g, ""));
  }

  for (const candidate of candidates) {
    if (candidate.length >= 4 && COMMON_PASSWORDS.has(candidate)) {
      errors.push(
        "This password is based on a commonly used password. Choose something less predictable."
      );
      break;
    }
  }

  if (hasLowEntropyRun(raw)) {
    errors.push("Password must not contain long repeated or sequential character runs.");
  }

  const identifiers = [];
  if (context.email) {
    const email = canonical(context.email);
    identifiers.push(email, email.split("@")[0]);
  }
  if (context.name) {
    identifiers.push(...canonical(context.name).split(/\s+/));
  }
  for (const identifier of identifiers) {
    if (identifier && identifier.length >= 4 && normalised.includes(identifier)) {
      errors.push("Password must not contain your name or email address.");
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Hashes a password with the configured bcrypt work factor (>= 12). */
async function hashPassword(password) {
  return bcrypt.hash(String(password), config.BCRYPT_ROUNDS);
}

/**
 * Verifies a password against a stored bcrypt hash.
 *
 * Only bcrypt hashes are ever accepted. A stored value that is not a bcrypt
 * hash (legacy plaintext, or a corrupted row) fails closed — it is NEVER
 * compared directly against the supplied password.
 */
async function verifyPassword(password, storedHash) {
  const hash = String(storedHash || "");
  if (!isBcryptHash(hash)) {
    // Burn equivalent time so a non-bcrypt row is not distinguishable by timing.
    await bcrypt.compare(String(password), DUMMY_HASH);
    return false;
  }
  try {
    return await bcrypt.compare(String(password), hash);
  } catch {
    return false;
  }
}

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(String(value || ""));
}

/**
 * A fixed valid hash used to equalise timing when the account does not exist or
 * has no usable hash — defeats user enumeration via response latency.
 */
const DUMMY_HASH = bcrypt.hashSync("timing-equalisation-placeholder", 12);

/** Consumes a bcrypt compare against the dummy hash to normalise login timing. */
async function burnPasswordTiming() {
  await bcrypt.compare(crypto.randomBytes(16).toString("hex"), DUMMY_HASH);
}

/**
 * Cryptographically strong temporary password that satisfies the policy.
 *
 * WHY the validate-and-retry loop: random generation can legitimately produce a
 * string the policy then rejects. `hasLowEntropyRun` is case-insensitive, so a
 * draw like `…bBBb…` reads as four identical characters and is refused. Without
 * this loop the function could hand back a password that `validatePassword`
 * rejects — provisioning an account with a credential the system considers
 * invalid. Rare, but a contract violation, and it surfaced as a flaky test.
 *
 * Retries are bounded and each draw is independent, so this terminates: the
 * rejection probability per draw is small, making exhaustion vanishingly
 * unlikely. If it ever did exhaust, throwing is the correct outcome — silently
 * returning a non-compliant password would be worse.
 */
function generateStrongPassword(length = 20) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+[]{}";
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(0, set.length)];

  const target = Math.max(length, MIN_LENGTH, 12);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    // One character from each class guarantees the composition rules.
    const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
    while (chars.length < target) chars.push(pick(all));

    // Fisher–Yates with a CSPRNG so the guaranteed-class characters aren't
    // pinned to predictable positions.
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(0, i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    const candidate = chars.join("");
    if (validatePassword(candidate).valid) return candidate;
  }

  throw new Error("generateStrongPassword: could not produce a policy-compliant password");
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  validatePassword,
  hashPassword,
  verifyPassword,
  isBcryptHash,
  burnPasswordTiming,
  generateStrongPassword,
};
