import { describe, expect, it } from "vitest";
import { users, emailVerifications, userCompanies } from "./schema.js";

describe("@datahub/db schema (auth slice)", () => {
  it("models the users table with the auth columns", () => {
    expect(users.email.name).toBe("email");
    expect(users.passwordHash.name).toBe("password_hash");
    expect(users.role.name).toBe("role");
  });

  it("models the OTP store", () => {
    expect(emailVerifications.otpHash.name).toBe("otp_hash");
    expect(emailVerifications.attempts.name).toBe("attempts");
  });

  it("models the user↔company join", () => {
    expect(userCompanies.userId.name).toBe("user_id");
    expect(userCompanies.companyId.name).toBe("company_id");
  });
});
