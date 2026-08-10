import { describe, expect, it } from "vitest";
import { loginRequest, resetPasswordRequest, forgotPasswordRequest } from "./auth.js";

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
