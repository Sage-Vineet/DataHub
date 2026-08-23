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

describe("AuthService — a password that is not a bcrypt hash", () => {
  it("refuses to log in against one", async () => {
    // A row whose hash column holds a plaintext password, or a legacy digest,
    // or a placeholder. `bcrypt.compare` answers false for those anyway — but
    // only by accident of the format, and a comparison that could ever answer
    // true against something that is not a bcrypt hash is a shared-password
    // path by another name (audit C1).
    const { repo, service } = makeService();
    repo.addUser({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Legacy",
      email: "legacy@example.com",
      role: "broker",
      companyId: null,
      status: "active",
      passwordHash: "letmein",
    });

    await expect(service.authenticate("legacy@example.com", "letmein")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("refuses an inactive account whose password is right", async () => {
    const { repo, service } = makeService();
    await seedUser(repo, { email: "gone@example.com", password: "passw0rd1", status: "inactive" });
    await expect(service.authenticate("gone@example.com", "passw0rd1")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("refuses an account nobody has", async () => {
    const { service } = makeService();
    await expect(service.authenticate("nobody@example.com", "x")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe("AuthService — how a wrong code is counted", () => {
  it("says how many attempts are left, and gets the plural right", async () => {
    // The count is on the page. "1 attempts remaining" reads as a bug in the
    // product at exactly the moment somebody is already frustrated.
    const clock = mutableClock();
    const { emailer, service, config } = makeService(clock);
    expect(config.otp.maxAttempts).toBeGreaterThan(2);

    await service.sendOtp("counter@example.com");
    const correct = emailer.last!.otp;
    const wrong = correct === "000000" ? "111111" : "000000";

    const messages: string[] = [];
    for (let i = 0; i < config.otp.maxAttempts - 1; i += 1) {
      await service.verifyOtp("counter@example.com", wrong).catch((e: Error) => {
        messages.push(e.message);
      });
    }

    expect(messages.at(-1)).toMatch(/1 attempt remaining/);
    expect(messages.at(-2)).toMatch(/2 attempts remaining/);
  });

  it("stops counting and asks for a new code once they are used up", async () => {
    const clock = mutableClock();
    const { emailer, service, config } = makeService(clock);
    await service.sendOtp("spent@example.com");
    const correct = emailer.last!.otp;
    const wrong = correct === "000000" ? "111111" : "000000";

    for (let i = 0; i < config.otp.maxAttempts; i += 1) {
      await service.verifyOtp("spent@example.com", wrong).catch(() => undefined);
    }

    // Even the RIGHT code is refused now: the attempt budget is spent, and
    // letting a correct guess through after N wrong ones is the whole thing
    // the budget exists to prevent.
    await expect(service.verifyOtp("spent@example.com", correct)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("refuses a code for an address that never asked for one", async () => {
    const { service } = makeService();
    await expect(service.verifyOtp("stranger@example.com", "123456")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("AuthService — resetting a password", () => {
  it("refuses when the code verified but the account has gone", async () => {
    // Deleted between requesting the code and using it. Better than resetting
    // a password on nothing and reporting success.
    const clock = mutableClock();
    const { repo, emailer, service } = makeService(clock);
    await seedUser(repo, { email: "vanishing@example.com", password: "passw0rd1" });
    await service.sendOtp("vanishing@example.com");
    const otp = emailer.last!.otp;
    repo.removeUser("vanishing@example.com");

    await expect(
      service.resetPassword("vanishing@example.com", otp, "newpassw0rd"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("AuthService — reading the current session", () => {
  it("is null for a user that is no longer there", async () => {
    const { service } = makeService();
    expect(await service.getSessionUser("33333333-3333-3333-3333-333333333333")).toBeNull();
  });
});

describe("canAccessCompany", () => {
  const base = { id: "u", name: "n", email: "e@x.com", status: "active" as const };

  it("lets admins access any company", () => {
    expect(canAccessCompany({ ...base, role: "admin", company_id: null }, "c1")).toBe(true);
  });

  it("confines brokers to companies they are associated with", () => {
    // Parity with legacy permissionService.canAccessCompany, where only isAdmin is
    // unscoped. A blanket broker grant would expose every tenant to every broker.
    const unassociated = { ...base, role: "broker" as const, company_id: null };
    expect(canAccessCompany(unassociated, "c1")).toBe(false);

    const associated = {
      ...base,
      role: "broker" as const,
      company_id: "c1",
      company_ids: ["c1", "c2"],
    };
    expect(canAccessCompany(associated, "c1")).toBe(true);
    expect(canAccessCompany(associated, "c2")).toBe(true);
    expect(canAccessCompany(associated, "c3")).toBe(false);
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
