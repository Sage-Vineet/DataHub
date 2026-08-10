import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAuthConfig } from "./config.js";
import { AuthError, InvalidCredentialsError } from "./errors.js";
import { InMemoryAuthRepository } from "./repository.memory.js";
import { AuthService, canAccessCompany, type Clock } from "./service.js";
import type { AuthUserRecord, Emailer } from "./ports.js";

const SECRET = "unit-test-secret-value";

class CaptureEmailer implements Emailer {
  last: { email: string; otp: string } | null = null;
  async sendOtp(email: string, otp: string) {
    this.last = { email, otp };
    return { sent: true };
  }
}

function mutableClock(start = 1_000_000): Clock & { t: number } {
  const c = { t: start, now: () => c.t };
  return c;
}

async function seedUser(
  repo: InMemoryAuthRepository,
  over: Partial<AuthUserRecord> & { password: string },
): Promise<AuthUserRecord> {
  const user: AuthUserRecord = {
    id: over.id ?? "11111111-1111-1111-1111-111111111111",
    name: over.name ?? "Test User",
    email: over.email ?? "user@example.com",
    role: over.role ?? "broker",
    companyId: over.companyId ?? null,
    status: over.status ?? "active",
    passwordHash: await bcrypt.hash(over.password, 4),
  };
  repo.addUser(user);
  return user;
}

function makeService(clock?: Clock) {
  const repo = new InMemoryAuthRepository();
  const emailer = new CaptureEmailer();
  const config = loadAuthConfig({ JWT_SECRET: SECRET, AUTH_LOGIN_RATE_MAX: "3" });
  const service = new AuthService(clock ? { repo, emailer, config, clock } : { repo, emailer, config });
  return { repo, emailer, config, service };
}

describe("AuthService.authenticate", () => {
  it("returns a token and safe user for valid credentials", async () => {
    const { repo, service } = makeService();
    await seedUser(repo, { password: "correct1horse" });
    const { user, token } = await service.authenticate("user@example.com", "correct1horse");
    expect(user.email).toBe("user@example.com");
    expect(token).toBeTruthy();
    expect((user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it("rejects a wrong password and an unknown email", async () => {
    const { repo, service } = makeService();
    await seedUser(repo, { password: "correct1horse" });
    await expect(service.authenticate("user@example.com", "nope")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(service.authenticate("ghost@example.com", "whatever")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("rejects an inactive account", async () => {
    const { repo, service } = makeService();
    await seedUser(repo, { password: "correct1horse", status: "inactive" });
    await expect(service.authenticate("user@example.com", "correct1horse")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("rejects the retired shared password for a client account (no static bypass)", async () => {
    const { repo, service } = makeService();
    await seedUser(repo, { password: "aRealPassw0rd", role: "buyer", email: "client@x.com" });
    await expect(service.authenticate("client@x.com", "123456")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("provisions a client's company link and default folders on login", async () => {
    const { repo, service } = makeService();
    const companyId = "22222222-2222-2222-2222-222222222222";
    const user = await seedUser(repo, { password: "buyerPass1", role: "buyer", email: "b@x.com" });
    repo.setCompanyContact("b@x.com", companyId);
    await service.authenticate("b@x.com", "buyerPass1");
    expect(repo.hasUserCompanyLink(user.id, companyId)).toBe(true);
    expect(await repo.companyHasFolders(companyId)).toBe(true);
  });
});

describe("AuthService tokens", () => {
  it("verifies its own token and rejects tampered/foreign ones", async () => {
    const { service } = makeService();
    const token = service.signToken("abc");
    expect(service.verifyToken(token)).toBe("abc");
    expect(service.verifyToken(token + "x")).toBeNull();
    expect(service.verifyToken(jwt.sign({ sub: "abc" }, "different-secret"))).toBeNull();
  });

  it("accepts a legacy-shaped token signed with the same secret (cutover parity)", async () => {
    const { service } = makeService();
    const legacyToken = jwt.sign({ sub: "legacy-user" }, SECRET, { expiresIn: "7d" });
    expect(service.verifyToken(legacyToken)).toBe("legacy-user");
  });
});

describe("AuthService OTP + reset", () => {
  it("issues and verifies an OTP, and rejects a wrong code", async () => {
    const { repo, emailer, service } = makeService();
    await seedUser(repo, { password: "x1x1x1x1", email: "o@x.com" });
    await service.sendOtp("o@x.com");
    const otp = emailer.last?.otp ?? "";
    await expect(service.verifyOtp("o@x.com", "000000")).rejects.toBeInstanceOf(AuthError);
    const res = await service.verifyOtp("o@x.com", otp);
    expect(res.verified).toBe(true);
  });

  it("expires an OTP after the window", async () => {
    const clock = mutableClock();
    const { emailer, service, config } = makeService(clock);
    await service.sendOtp("o@x.com");
    void emailer.last;
    clock.t += config.otp.expiryMs + 1;
    await expect(service.verifyOtp("o@x.com", emailer.last?.otp ?? "")).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("enforces the resend limit", async () => {
    const { service } = makeService();
    await service.sendOtp("o@x.com");
    await service.sendOtp("o@x.com");
    await service.sendOtp("o@x.com");
    await expect(service.sendOtp("o@x.com")).rejects.toMatchObject({ status: 429 });
  });

  it("resets the password with a valid code so the new password logs in", async () => {
    const { repo, emailer, service } = makeService();
    await seedUser(repo, { password: "oldPass11", email: "r@x.com" });
    await service.sendOtp("r@x.com");
    await service.resetPassword("r@x.com", emailer.last?.otp ?? "", "newPass22");
    const { token } = await service.authenticate("r@x.com", "newPass22");
    expect(token).toBeTruthy();
    await expect(service.authenticate("r@x.com", "oldPass11")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("forgot-password is silent and non-throwing for unknown emails", async () => {
    const { emailer, service } = makeService();
    await expect(service.forgotPassword("nobody@x.com")).resolves.toBeUndefined();
    expect(emailer.last).toBeNull();
  });
});

describe("canAccessCompany", () => {
  const base = { id: "u", name: "n", email: "e@x.com", status: "active" as const };
  it("lets brokers/admins access any company", () => {
    expect(canAccessCompany({ ...base, role: "broker", company_id: null }, "c1")).toBe(true);
    expect(canAccessCompany({ ...base, role: "admin", company_id: null }, "c1")).toBe(true);
  });
  it("confines buyers to their own companies", () => {
    const buyer = { ...base, role: "buyer" as const, company_id: "c1", company_ids: ["c1"] };
    expect(canAccessCompany(buyer, "c1")).toBe(true);
    expect(canAccessCompany(buyer, "c2")).toBe(false);
  });
});

describe("loadAuthConfig", () => {
  beforeEach(() => {
    /* no shared state */
  });
  it("fails closed without a secret", () => {
    expect(() => loadAuthConfig({})).toThrow(/JWT_SECRET/);
    expect(() => loadAuthConfig({ JWT_SECRET: "change_me" })).toThrow(/JWT_SECRET/);
  });
});
