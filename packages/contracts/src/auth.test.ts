import { describe, expect, it } from "vitest";
import {
  brokerSignupRequest,
  loginRequest,
  resetPasswordRequest,
  forgotPasswordRequest,
} from "./auth.js";

describe("auth contracts", () => {
  it("accepts a valid login and normalizes the email", () => {
    const parsed = loginRequest.parse({ email: "  User@Example.COM ", password: "secret" });
    expect(parsed.email).toBe("user@example.com");
  });

  it("rejects a login with a missing password", () => {
    expect(loginRequest.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });

  it("rejects a bad email in forgot-password", () => {
    expect(forgotPasswordRequest.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("enforces the password policy on reset", () => {
    // too short
    expect(
      resetPasswordRequest.safeParse({ email: "a@b.com", otp: "123456", new_password: "ab1" })
        .success,
    ).toBe(false);
    // letters only, no digit
    expect(
      resetPasswordRequest.safeParse({ email: "a@b.com", otp: "123456", new_password: "abcdefgh" })
        .success,
    ).toBe(false);
    // valid
    const ok = resetPasswordRequest.safeParse({
      email: "a@b.com",
      otp: "123456",
      new_password: "abcdefg1",
    });
    expect(ok.success).toBe(true);
  });

  it("requires a 6-digit OTP", () => {
    expect(
      resetPasswordRequest.safeParse({ email: "a@b.com", otp: "12", new_password: "abcdefg1" })
        .success,
    ).toBe(false);
  });
});

describe("broker signup", () => {
  const valid = {
    name: "Dana Reed",
    email: "dana@example.com",
    phone: "+44 20 7946 0000",
    password: "correct1horse",
    verification_token: "a-grant",
  };

  it("accepts a signup that confirms its password, under either spelling", () => {
    // The SPA sends `confirmPassword`; an older client sends
    // `confirm_password`. Reading one silently accepts a mismatch from the
    // other, which is a typo'd password nobody can sign in with and only a
    // reset can fix.
    expect(
      brokerSignupRequest.safeParse({ ...valid, confirmPassword: "correct1horse" }).success,
    ).toBe(true);
    expect(
      brokerSignupRequest.safeParse({ ...valid, confirm_password: "correct1horse" }).success,
    ).toBe(true);
  });

  it("refuses a mismatch under either spelling, naming the field", () => {
    for (const key of ["confirmPassword", "confirm_password"] as const) {
      const result = brokerSignupRequest.safeParse({ ...valid, [key]: "something-else" });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toMatch(/do not match/i);
      expect(result.error?.issues[0]?.path).toEqual(["confirmPassword"]);
    }
  });

  it("accepts one that confirms nothing at all", () => {
    // Confirmation is a courtesy the form offers, not something the server
    // requires — a client that does not ask twice is not sending a mismatch.
    expect(brokerSignupRequest.safeParse(valid).success).toBe(true);
  });

  it("requires the verification grant", () => {
    // It is the whole boundary on the only endpoint that creates an account
    // without one already existing.
    const { verification_token, ...without } = valid;
    void verification_token;
    expect(brokerSignupRequest.safeParse(without).success).toBe(false);
    expect(brokerSignupRequest.safeParse({ ...valid, verification_token: "  " }).success).toBe(
      false,
    );
  });
});
