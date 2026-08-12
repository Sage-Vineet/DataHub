import { randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { SessionUser } from "@datahub/contracts";
import type { AuthConfig } from "./config.js";
import { AuthError, InvalidCredentialsError } from "./errors.js";
import type { AuthRepository, AuthUserRecord, Emailer } from "./ports.js";

const BCRYPT_HASH_RE = /^\$2[aby]\$/;

export interface Clock {
  now(): number;
}
const systemClock: Clock = { now: () => Date.now() };

export interface AuthServiceDeps {
  repo: AuthRepository;
  emailer: Emailer;
  config: AuthConfig;
  clock?: Clock;
}

export class AuthService {
  private readonly repo: AuthRepository;
  private readonly emailer: Emailer;
  private readonly config: AuthConfig;
  private readonly clock: Clock;

  constructor(deps: AuthServiceDeps) {
    this.repo = deps.repo;
    this.emailer = deps.emailer;
    this.config = deps.config;
    this.clock = deps.clock ?? systemClock;
  }

  /** Credential login. bcrypt-only; no shared/static password path (audit C1). */
  async authenticate(email: string, password: string): Promise<{ user: SessionUser; token: string }> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status === "inactive") throw new InvalidCredentialsError();
    if (!BCRYPT_HASH_RE.test(user.passwordHash)) throw new InvalidCredentialsError();

    const ok = await bcrypt.compare(password, user.passwordHash).catch(() => false);
    if (!ok) throw new InvalidCredentialsError();

    if (user.role === "buyer") await this.provisionClient(user);

    const companyIds = await this.repo.listCompanyIdsForUser(user.id);
    return { user: toSessionUser(user, companyIds), token: this.signToken(user.id) };
  }

  /** Legacy parity: sync company association + default folders for client users. */
  private async provisionClient(user: AuthUserRecord): Promise<void> {
    let companyId = user.companyId;
    if (!companyId) {
      companyId = await this.repo.findCompanyIdByContactEmail(user.email);
      if (companyId) await this.repo.setUserCompanyId(user.id, companyId);
    }
    if (!companyId) return;
    await this.repo.linkUserCompany(user.id, companyId);
    if (!(await this.repo.companyHasFolders(companyId))) {
      await this.repo.createDefaultFolders(companyId, user.id, this.config.defaultFolders);
    }
  }

  /**
   * Enumeration-safe: always resolves the same way to the caller. A code is
   * dispatched only for real, active accounts; internal errors (incl. the
   * rate-limit 429) are swallowed so nothing leaks which emails exist (audit C1).
   */
  async forgotPassword(email: string): Promise<void> {
    try {
      const user = await this.repo.findUserByEmail(email);
      if (user && user.status !== "inactive") {
        const otp = await this.issueOtp(email);
        await this.emailer.sendOtp(email, otp);
      }
    } catch {
      /* swallow — response stays generic; rate limit is still enforced internally */
    }
  }

  /** Verify the reset code, then set a new bcrypt hash. Throws on invalid code. */
  async resetPassword(email: string, otp: string, newPassword: string): Promise<void> {
    await this.verifyOtp(email, otp);
    const user = await this.repo.findUserByEmail(email);
    if (!user) throw new AuthError(400, "Unable to reset password. Please request a new code.");
    const hash = await bcrypt.hash(newPassword, 10);
    await this.repo.updatePasswordHash(user.id, hash);
  }

  /** Generate + store a 6-digit OTP (hashed). Enforces the resend limit. */
  async issueOtp(email: string): Promise<string> {
    const now = this.clock.now();
    const count = await this.repo.countOtpsSince(email, now - this.config.otp.resendWindowMs);
    if (count >= this.config.otp.maxResends) {
      throw new AuthError(429, "Too many verification requests. Please wait 10 minutes.");
    }
    const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const otpHash = await bcrypt.hash(otp, 10);
    await this.repo.insertOtp({
      id: randomUUID(),
      email,
      otpHash,
      attempts: 0,
      resendCount: count + 1,
      verified: false,
      createdAt: now,
      expiresAt: now + this.config.otp.expiryMs,
    });
    return otp;
  }

  /** Issue an OTP and dispatch it via the emailer (used by the send-otp route). */
  async sendOtp(email: string): Promise<void> {
    const otp = await this.issueOtp(email);
    await this.emailer.sendOtp(email, otp);
  }

  /** Verify a 6-digit OTP; returns a short-lived verification token on success. */
  async verifyOtp(email: string, otp: string): Promise<{ verified: true; verificationToken: string }> {
    const record = await this.repo.getActiveOtp(email, this.clock.now());
    if (!record) {
      throw new AuthError(400, "Verification code has expired or was not found. Request a new code.");
    }
    if (record.attempts >= this.config.otp.maxAttempts) {
      throw new AuthError(429, "Too many failed attempts. Please request a new code.");
    }
    await this.repo.incrementOtpAttempts(record.id);
    const valid = await bcrypt.compare(otp, record.otpHash).catch(() => false);
    if (!valid) {
      const remaining = this.config.otp.maxAttempts - record.attempts - 1;
      throw new AuthError(
        400,
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
          : "Too many failed attempts. Please request a new code.",
      );
    }
    await this.repo.markOtpVerified(record.id);
    const verificationToken = jwt.sign(
      { purpose: "email_verification", email },
      this.config.jwtSecret,
      { expiresIn: this.config.verificationTokenTtl } as SignOptions,
    );
    return { verified: true, verificationToken };
  }

  /** Current-session lookup for /me. */
  async getSessionUser(id: string): Promise<SessionUser | null> {
    const user = await this.repo.findUserById(id);
    if (!user) return null;
    const companyIds = await this.repo.listCompanyIdsForUser(id);
    return toSessionUser(user, companyIds);
  }

  signToken(userId: string): string {
    return jwt.sign({ sub: userId }, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiresIn,
    } as SignOptions);
  }

  /** Returns the user id for a valid token, or null. */
  verifyToken(token: string): string | null {
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret);
      if (typeof decoded === "object" && decoded && typeof decoded.sub === "string") {
        return decoded.sub;
      }
      return null;
    } catch {
      return null;
    }
  }
}

// `canAccessCompany` now lives in the shared guard so every domain shares one
// implementation (promoted in companies-domain). Re-exported here for the
// existing auth imports/tests.
export { canAccessCompany } from "../../shared/access.js";

function toSessionUser(record: AuthUserRecord, companyIds: string[]): SessionUser {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    company_id: record.companyId,
    status: record.status,
    company_ids: companyIds,
  };
}
