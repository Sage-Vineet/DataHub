import type { AuthRepository, AuthUserRecord, OtpRecord } from "./ports.js";

/**
 * In-memory AuthRepository for tests and local dev. Mirrors the observable
 * behavior of the Drizzle adapter without a database.
 */
export class InMemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUserRecord>();
  private readonly companyByContactEmail = new Map<string, string>();
  private readonly userCompanies = new Set<string>();
  private readonly folderCountByCompany = new Map<string, number>();
  private otps: OtpRecord[] = [];

  addUser(user: AuthUserRecord): void {
    this.users.set(user.id, { ...user });
  }

  setCompanyContact(email: string, companyId: string): void {
    this.companyByContactEmail.set(email.toLowerCase(), companyId);
  }

  hasUserCompanyLink(userId: string, companyId: string): boolean {
    return this.userCompanies.has(`${userId}:${companyId}`);
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const target = email.toLowerCase();
    for (const u of this.users.values()) if (u.email.toLowerCase() === target) return { ...u };
    return null;
  }

  async findUserById(id: string): Promise<AuthUserRecord | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.passwordHash = passwordHash;
  }

  async createBrokerUser(user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    brokerCompany: string | null;
  }): Promise<void> {
    this.users.set(user.id, {
      id: user.id,
      name: user.name,
      email: user.email,
      passwordHash: "!",
      role: "broker",
      companyId: null,
      status: "active",
    } as never);
  }

  async listCompanyIdsForUser(userId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const key of this.userCompanies) {
      const [uid, cid] = key.split(":");
      if (uid === userId && cid) ids.push(cid);
    }
    const primary = this.users.get(userId)?.companyId;
    if (primary && !ids.includes(primary)) ids.push(primary);
    return ids;
  }

  async findCompanyIdByContactEmail(email: string): Promise<string | null> {
    return this.companyByContactEmail.get(email.toLowerCase()) ?? null;
  }

  async setUserCompanyId(userId: string, companyId: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.companyId = companyId;
  }

  async linkUserCompany(userId: string, companyId: string): Promise<void> {
    this.userCompanies.add(`${userId}:${companyId}`);
  }

  async companyHasFolders(companyId: string): Promise<boolean> {
    return (this.folderCountByCompany.get(companyId) ?? 0) > 0;
  }

  async createDefaultFolders(
    companyId: string,
    _createdBy: string,
    names: readonly string[],
  ): Promise<void> {
    this.folderCountByCompany.set(
      companyId,
      (this.folderCountByCompany.get(companyId) ?? 0) + names.length,
    );
  }

  async countOtpsSince(email: string, sinceEpochMs: number): Promise<number> {
    const target = email.toLowerCase();
    return this.otps.filter((o) => o.email.toLowerCase() === target && o.createdAt >= sinceEpochMs)
      .length;
  }

  async insertOtp(record: OtpRecord): Promise<void> {
    this.otps.push({ ...record });
  }

  async getActiveOtp(email: string, nowEpochMs: number): Promise<OtpRecord | null> {
    const target = email.toLowerCase();
    const active = this.otps
      .filter((o) => o.email.toLowerCase() === target && !o.verified && o.expiresAt > nowEpochMs)
      .sort((a, b) => b.createdAt - a.createdAt);
    return active[0] ? { ...active[0] } : null;
  }

  async incrementOtpAttempts(id: string): Promise<void> {
    const o = this.otps.find((r) => r.id === id);
    if (o) o.attempts += 1;
  }

  async markOtpVerified(id: string): Promise<void> {
    const o = this.otps.find((r) => r.id === id);
    if (o) o.verified = true;
  }
}
