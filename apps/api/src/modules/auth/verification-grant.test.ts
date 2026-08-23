import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GRANT_TTL_MS,
  issueVerificationGrant,
  verifyVerificationGrant,
} from "./verification-grant.js";

/**
 * The proof that an email was verified before an account is created for it.
 *
 * Every case here is an attack: a forged signature, a stale grant, and — the one
 * that matters most — a genuine grant for one address being used to register a
 * different one.
 */

const SECRET = "test-secret-value";
const NOW = Date.UTC(2024, 5, 1, 12, 0, 0);

describe("a freshly issued grant", () => {
  it("verifies for the address it was issued to", () => {
    const grant = issueVerificationGrant("broker@example.com", SECRET, NOW);
    expect(verifyVerificationGrant(grant, "broker@example.com", SECRET, NOW)).toEqual({ ok: true });
  });

  it("is case- and whitespace-insensitive on both sides", () => {
    const grant = issueVerificationGrant("  Broker@Example.COM ", SECRET, NOW);
    expect(verifyVerificationGrant(grant, "broker@example.com", SECRET, NOW).ok).toBe(true);
    expect(verifyVerificationGrant(grant, " BROKER@example.com ", SECRET, NOW).ok).toBe(true);
  });

  it("carries no user and grants nothing on its own", () => {
    // It is one email and one expiry, and nothing else — it cannot be mistaken
    // for a session token.
    const grant = issueVerificationGrant("broker@example.com", SECRET, NOW);
    const payload = Buffer.from(grant.split(".")[0]!, "base64url").toString("utf8");
    expect(payload).toBe(`v1|broker@example.com|${NOW + GRANT_TTL_MS}`);
  });
});

describe("a grant that must be refused", () => {
  const grant = issueVerificationGrant("broker@example.com", SECRET, NOW);

  it("cannot register a different address", () => {
    // The attack this exists to stop: verify your own address, then use the
    // grant to create an account for somebody else's.
    expect(verifyVerificationGrant(grant, "victim@example.com", SECRET, NOW)).toEqual({
      ok: false,
      reason: "email-mismatch",
    });
  });

  it("expires", () => {
    expect(verifyVerificationGrant(grant, "broker@example.com", SECRET, NOW + GRANT_TTL_MS)).toEqual(
      { ok: false, reason: "expired" },
    );
    expect(
      verifyVerificationGrant(grant, "broker@example.com", SECRET, NOW + GRANT_TTL_MS - 1).ok,
    ).toBe(true);
  });

  it("is refused under a different secret", () => {
    expect(verifyVerificationGrant(grant, "broker@example.com", "other-secret", NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a tampered payload", () => {
    // Re-encode a payload claiming a later expiry, keeping the original
    // signature — the signature must no longer match.
    const forgedPayload = `v1|broker@example.com|${NOW + GRANT_TTL_MS * 100}`;
    const forged = `${Buffer.from(forgedPayload).toString("base64url")}.${grant.split(".")[1]}`;
    expect(verifyVerificationGrant(forged, "broker@example.com", SECRET, NOW).reason).toBe(
      "bad-signature",
    );
  });

  it("rejects anything that is not a grant", () => {
    for (const bad of ["", "nonsense", "a.b.c", "onlyonepart", ".", "a."]) {
      expect(verifyVerificationGrant(bad, "broker@example.com", SECRET, NOW).ok).toBe(false);
    }
  });

  it("does not throw on a signature of the wrong length", () => {
    // `timingSafeEqual` throws rather than returning false when the buffers
    // differ in length, so the length is checked first.
    const short = `${grant.split(".")[0]}.abc`;
    expect(verifyVerificationGrant(short, "broker@example.com", SECRET, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a grant from a future version", () => {
    // Signed with the real derived key, so only the version can fail it. The
    // derivation is repeated here deliberately: signing correctly is the whole
    // point of the case, and exporting the key helper to avoid four lines would
    // widen the module's surface for a test's convenience.
    const payload = `v2|broker@example.com|${NOW + GRANT_TTL_MS}`;
    const key = createHmac("sha256", SECRET)
      .update("datahub/email-verification-grant/v1")
      .digest();
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    const token = `${Buffer.from(payload).toString("base64url")}.${signature}`;

    expect(verifyVerificationGrant(token, "broker@example.com", SECRET, NOW).reason).toBe(
      "malformed",
    );
  });
});
