import type { UserRole, UserStatus } from "@datahub/contracts";

/** A user as the auth module needs it (includes the hash; never leaves the service). */
export interface AuthUserRecord {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  status: UserStatus;
  passwordHash: string;
}

/** An OTP record; timestamps are epoch-ms so the store is transport-agnostic. */
export interface OtpRecord {
  id: string;
  email: string;
  otpHash: string;
  attempts: number;
  resendCount: number;
  verified: boolean;
  createdAt: number;
  expiresAt: number;
}

/**
 * The data access the auth service depends on. Two implementations exist: a
 * Drizzle adapter (runtime) and an in-memory adapter (tests/dev) — so the
 * service is fully testable without Postgres (design D1/D4).
 */
export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserById(id: string): Promise<AuthUserRecord | null>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  listCompanyIdsForUser(userId: string): Promise<string[]>;

  // Post-login provisioning for client/buyer users (legacy parity).
  findCompanyIdByContactEmail(email: string): Promise<string | null>;
  setUserCompanyId(userId: string, companyId: string): Promise<void>;
  linkUserCompany(userId: string, companyId: string): Promise<void>;
  companyHasFolders(companyId: string): Promise<boolean>;
  createDefaultFolders(companyId: string, createdBy: string, names: readonly string[]): Promise<void>;

  // OTP store. Each issue inserts a new record; getActiveOtp returns the newest
  // unverified, non-expired one, so only the latest code can be redeemed.
  countOtpsSince(email: string, sinceEpochMs: number): Promise<number>;
  insertOtp(record: OtpRecord): Promise<void>;
  getActiveOtp(email: string, nowEpochMs: number): Promise<OtpRecord | null>;
  incrementOtpAttempts(id: string): Promise<void>;
  markOtpVerified(id: string): Promise<void>;
}

/** Sends the plain OTP to a user. The real adapter uses email; tests capture it. */
export interface Emailer {
  sendOtp(email: string, otp: string): Promise<{ sent: boolean }>;
}
