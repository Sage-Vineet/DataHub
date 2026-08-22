import { randomUUID } from "node:crypto";
import type { AssignedCompany } from "@datahub/contracts";
import type {
  ReplacementCandidate,
  UserCreateInput,
  UserRecord,
  UsersRepository,
  UserUpdatePatch,
} from "./ports.js";

/** In-memory `UsersRepository` for tests — same interface, no database. */
export class InMemoryUsersRepository implements UsersRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly links = new Set<string>(); // `${userId}:${companyId}`
  private readonly companiesInfo = new Map<string, AssignedCompany>();
  private readonly invites = new Set<string>(); // `${ownerId}:${invitedId}`
  /** Recorded (userId → replacementId) reassignments, for assertions. */
  readonly reassigned: Array<{ userId: string; replacementId: string }> = [];

  seedUser(record: Partial<UserRecord> & Pick<UserRecord, "id" | "email" | "role">): UserRecord {
    const full: UserRecord = {
      name: record.email.split("@")[0] ?? record.email,
      phone: null,
      passwordHash: "!",
      subRole: null,
      designation: null,
      buyerCompanyName: null,
      parentUserId: null,
      companyId: null,
      status: "active",
      dateOfBirth: null,
      occupation: null,
      address: null,
      brokerCompany: null,
      createdAt: new Date(0).toISOString(),
      ...record,
    } as UserRecord;
    this.users.set(full.id, full);
    return full;
  }

  seedCompany(company: AssignedCompany): void {
    this.companiesInfo.set(company.id, company);
  }

  link(userId: string, companyId: string): void {
    this.links.add(`${userId}:${companyId}`);
  }

  async getById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    for (const u of this.users.values()) if (u.email === email) return u;
    return null;
  }

  async listAll(): Promise<UserRecord[]> {
    return [...this.users.values()];
  }

  async create(input: UserCreateInput): Promise<UserRecord> {
    const record: UserRecord = {
      id: randomUUID(),
      ...input,
      dateOfBirth: null,
      occupation: null,
      address: null,
      brokerCompany: null,
      createdAt: new Date(0).toISOString(),
    };
    this.users.set(record.id, record);
    return record;
  }

  async update(id: string, patch: UserUpdatePatch): Promise<UserRecord | null> {
    const existing = this.users.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.users.set(id, updated);
    return updated;
  }

  async assignedCompaniesFor(userIds: readonly string[]): Promise<Map<string, AssignedCompany[]>> {
    const map = new Map<string, AssignedCompany[]>();
    for (const userId of userIds) {
      const ids = new Set<string>();
      for (const key of this.links) {
        const [u, c] = key.split(":");
        if (u === userId && c) ids.add(c);
      }
      const primary = this.users.get(userId)?.companyId;
      if (primary) ids.add(primary);
      map.set(
        userId,
        [...ids].map((id) => this.companiesInfo.get(id) ?? { id, name: null, contact_email: null }),
      );
    }
    return map;
  }

  async addCompanies(userId: string, companyIds: readonly string[]): Promise<void> {
    for (const c of companyIds) this.links.add(`${userId}:${c}`);
  }

  async removeCompanies(userId: string, companyIds: readonly string[]): Promise<void> {
    for (const c of companyIds) this.links.delete(`${userId}:${c}`);
  }

  async inviteBrokerToTeam(ownerId: string, invitedId: string): Promise<void> {
    this.invites.add(`${ownerId}:${invitedId}`);
  }

  async removeBrokerFromTeam(ownerId: string, invitedId: string): Promise<void> {
    this.invites.delete(`${ownerId}:${invitedId}`);
  }

  async invitedBrokerIds(ownerId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const key of this.invites) {
      const [owner, invited] = key.split(":");
      if (owner === ownerId && invited) ids.push(invited);
    }
    return ids;
  }

  async replacementCandidates(
    excludeId: string,
    companyIds: readonly string[],
  ): Promise<ReplacementCandidate[]> {
    const scope = new Set(companyIds.map(String));
    const all = [...this.users.values()].filter(
      (u) => u.id !== excludeId && (u.role === "broker" || u.role === "admin"),
    );
    const inScope = all.filter((u) => u.companyId && scope.has(u.companyId));
    const chosen = inScope.length > 0 ? inScope : all;
    return chosen.map((u) => ({ id: u.id, role: u.role }));
  }

  async reassignAndDelete(userId: string, replacementId: string): Promise<void> {
    this.reassigned.push({ userId, replacementId });
    this.users.delete(userId);
    for (const key of this.links) if (key.startsWith(`${userId}:`)) this.links.delete(key);
  }
}
