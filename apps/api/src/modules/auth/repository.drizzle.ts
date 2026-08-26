import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { AuthRepository, AuthUserRecord, OtpRecord } from "./ports.js";

const { users, userCompanies, companies, folders, emailVerifications } = schema;

type UserRow = typeof users.$inferSelect;
type OtpRow = typeof emailVerifications.$inferSelect;

function toUser(row: UserRow): AuthUserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    companyId: row.companyId,
    status: row.status,
    passwordHash: row.passwordHash,
  };
}

function toOtp(row: OtpRow): OtpRecord {
  return {
    id: row.id,
    email: row.email,
    otpHash: row.otpHash,
    attempts: row.attempts,
    resendCount: row.resendCount,
    verified: row.verified,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

/** Drizzle-backed AuthRepository (runtime adapter over the shared Postgres). */
export class DrizzleAuthRepository implements AuthRepository {
  constructor(private readonly db: Db) {}

  async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findUserById(id: string): Promise<AuthUserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async createBrokerUser(user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    brokerCompany: string | null;
  }): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      // Not a credential. Better Auth holds the password in `account`; this
      // column is NOT NULL and vestigial, and goes when legacy auth does.
      passwordHash: "!",
      role: "broker",
      // `broker_primary`, not a bare `broker` role: the sub-role is what the
      // rest of the app classifies people by (see `auto-groups.ts`), and a
      // broker with none falls through to the role fallback.
      subRole: "broker_primary",
      brokerCompany: user.brokerCompany,
      status: "active",
    });
  }

  async listCompanyIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ companyId: userCompanies.companyId })
      .from(userCompanies)
      .where(eq(userCompanies.userId, userId));
    const ids = rows.map((r) => r.companyId);
    const primary = (
      await this.db.select({ companyId: users.companyId }).from(users).where(eq(users.id, userId)).limit(1)
    )[0]?.companyId;
    if (primary && !ids.includes(primary)) ids.push(primary);
    return ids;
  }

  async findCompanyIdByContactEmail(email: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(sql`lower(${companies.contactEmail}) = ${email.toLowerCase()}`)
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async setUserCompanyId(userId: string, companyId: string): Promise<void> {
    await this.db.update(users).set({ companyId }).where(eq(users.id, userId));
  }

  async linkUserCompany(userId: string, companyId: string): Promise<void> {
    await this.db.insert(userCompanies).values({ userId, companyId }).onConflictDoNothing();
  }

  async companyHasFolders(companyId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.companyId, companyId))
      .limit(1);
    return rows.length > 0;
  }

  async createDefaultFolders(
    companyId: string,
    createdBy: string,
    names: readonly string[],
  ): Promise<void> {
    if (names.length === 0) return;
    await this.db
      .insert(folders)
      .values(names.map((name) => ({ companyId, createdBy, name })));
  }

  async countOtpsSince(email: string, sinceEpochMs: number): Promise<number> {
    const rows = await this.db
      .select({ id: emailVerifications.id })
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, email.toLowerCase()),
          gte(emailVerifications.createdAt, new Date(sinceEpochMs)),
        ),
      );
    return rows.length;
  }

  async insertOtp(record: OtpRecord): Promise<void> {
    await this.db.insert(emailVerifications).values({
      id: record.id,
      email: record.email.toLowerCase(),
      otpHash: record.otpHash,
      attempts: record.attempts,
      resendCount: record.resendCount,
      verified: record.verified,
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt),
    });
  }

  async getActiveOtp(email: string, nowEpochMs: number): Promise<OtpRecord | null> {
    const rows = await this.db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, email.toLowerCase()),
          eq(emailVerifications.verified, false),
          gt(emailVerifications.expiresAt, new Date(nowEpochMs)),
        ),
      )
      .orderBy(desc(emailVerifications.createdAt))
      .limit(1);
    return rows[0] ? toOtp(rows[0]) : null;
  }

  async incrementOtpAttempts(id: string): Promise<void> {
    await this.db
      .update(emailVerifications)
      .set({ attempts: sql`${emailVerifications.attempts} + 1` })
      .where(eq(emailVerifications.id, id));
  }

  async markOtpVerified(id: string): Promise<void> {
    await this.db
      .update(emailVerifications)
      .set({ verified: true, verifiedAt: new Date() })
      .where(eq(emailVerifications.id, id));
  }
}
