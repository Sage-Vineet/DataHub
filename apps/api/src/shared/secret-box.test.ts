import { describe, expect, it } from "vitest";
import { SecretBoxError, isSealed, open, seal } from "./secret-box.js";

/**
 * Encryption for secrets that live in the database.
 *
 * The value being protected is a QuickBooks refresh token — a standing key to
 * a client's accounting system that does not expire and cannot be revoked from
 * here. So the tests care less about round-tripping (which is easy) than about
 * every way a wrong or tampered value must fail to open.
 */

const SECRET = "an-application-secret-of-reasonable-length";
const PURPOSE = "quickbooks/refresh-token";
const TOKEN = "AB11730000000abcdefghijklmnopqrstuvwxyz0123456789";

describe("round trip", () => {
  it("opens what it sealed", () => {
    expect(open(seal(TOKEN, SECRET, PURPOSE), SECRET, PURPOSE)).toBe(TOKEN);
  });

  it("handles an empty string, unicode and something long", () => {
    for (const value of ["", "réfresh–tøken–✓", "x".repeat(8192)]) {
      expect(open(seal(value, SECRET, PURPOSE), SECRET, PURPOSE)).toBe(value);
    }
  });

  it("never puts the plaintext in the output", () => {
    const sealed = seal(TOKEN, SECRET, PURPOSE);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain(TOKEN.slice(0, 12));
  });

  it("gives different ciphertext each time", () => {
    // Identical output would leak that two companies share a token, or that a
    // token has not been rotated.
    const a = seal(TOKEN, SECRET, PURPOSE);
    const b = seal(TOKEN, SECRET, PURPOSE);
    expect(a).not.toBe(b);
    expect(open(a, SECRET, PURPOSE)).toBe(open(b, SECRET, PURPOSE));
  });
});

describe("what must not open", () => {
  const sealed = seal(TOKEN, SECRET, PURPOSE);

  it("a different secret", () => {
    expect(open(sealed, "a-different-application-secret", PURPOSE)).toBeNull();
  });

  it("a different purpose, even with the right secret", () => {
    // There is only one secret to deploy, so this is what keeps a value sealed
    // for one thing from being opened as another.
    expect(open(sealed, SECRET, "quickbooks/access-token")).toBeNull();
  });

  it("a flipped bit anywhere in the ciphertext", () => {
    const [version, iv, tag, ciphertext] = sealed.split(".") as [string, string, string, string];
    const bytes = Buffer.from(ciphertext, "base64url");
    bytes[0] = (bytes[0]! ^ 0x01) as number;
    const tampered = [version, iv, tag, bytes.toString("base64url")].join(".");
    expect(open(tampered, SECRET, PURPOSE)).toBeNull();
  });

  it("a swapped nonce", () => {
    const mine = seal(TOKEN, SECRET, PURPOSE).split(".");
    const theirs = seal("someone else's token", SECRET, PURPOSE).split(".");
    const spliced = [mine[0], theirs[1], mine[2], mine[3]].join(".");
    expect(open(spliced, SECRET, PURPOSE)).toBeNull();
  });

  it("a tag from another message", () => {
    const mine = seal(TOKEN, SECRET, PURPOSE).split(".");
    const theirs = seal("someone else's token", SECRET, PURPOSE).split(".");
    const spliced = [mine[0], mine[1], theirs[2], mine[3]].join(".");
    expect(open(spliced, SECRET, PURPOSE)).toBeNull();
  });

  it("a truncated tag or nonce, rather than throwing", () => {
    const [version, iv, tag, ciphertext] = sealed.split(".") as [string, string, string, string];
    const shortIv = Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url");
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 8).toString("base64url");
    expect(open([version, shortIv, tag, ciphertext].join("."), SECRET, PURPOSE)).toBeNull();
    expect(open([version, iv, shortTag, ciphertext].join("."), SECRET, PURPOSE)).toBeNull();
  });

  it("a value from a future version", () => {
    const parts = sealed.split(".");
    expect(open(["v2", ...parts.slice(1)].join("."), SECRET, PURPOSE)).toBeNull();
  });

  it("anything that is not sealed at all", () => {
    // A column that still holds a legacy plaintext token, or junk.
    for (const value of ["", "not-sealed", TOKEN, "a.b.c", "a.b.c.d.e", "....."]) {
      expect(open(value, SECRET, PURPOSE)).toBeNull();
    }
  });

  it("returns null rather than saying which part was wrong", () => {
    // Distinguishing "bad secret" from "bad tag" tells an attacker which half
    // of their guess was right.
    const wrongSecret = open(sealed, "wrong", PURPOSE);
    const wrongPurpose = open(sealed, SECRET, "wrong");
    const garbage = open("garbage", SECRET, PURPOSE);
    expect([wrongSecret, wrongPurpose, garbage]).toEqual([null, null, null]);
  });
});

describe("refusing to operate without a key", () => {
  it("will not seal with an empty secret or purpose", () => {
    // Sealing with a missing secret would produce something that looks
    // encrypted and is decryptable by anyone who notices.
    expect(() => seal(TOKEN, "", PURPOSE)).toThrow(SecretBoxError);
    expect(() => seal(TOKEN, SECRET, "")).toThrow(SecretBoxError);
  });

  it("will not open with an empty secret", () => {
    expect(() => open(sealFixture(), "", PURPOSE)).toThrow(SecretBoxError);
  });

  function sealFixture(): string {
    return seal(TOKEN, SECRET, PURPOSE);
  }
});

describe("telling a sealed value from a plain one", () => {
  it("recognises its own output", () => {
    expect(isSealed(seal(TOKEN, SECRET, PURPOSE))).toBe(true);
  });

  it("does not mistake a plaintext token for one", () => {
    // The point: spotting a column that still holds a legacy plaintext token,
    // without attempting decryption and without logging either.
    expect(isSealed(TOKEN)).toBe(false);
    expect(isSealed("")).toBe(false);
    expect(isSealed(null)).toBe(false);
    expect(isSealed(undefined)).toBe(false);
    expect(isSealed("v2.a.b.c")).toBe(false);
  });
});
