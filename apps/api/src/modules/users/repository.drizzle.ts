import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { AssignedCompany, SubRole } from "@datahub/contracts";
import type {
  ReplacementCandidate,
  UserCreateInput,
  UserRecord,
  UsersRepository,
  UserUpdatePatch,
} from "./ports.js";

const { users, userCompanies, companies, brokerTeamInvites } = schema;
type Row = typeof users.$inferSelect;

/** (table, column) pairs whose references to a deleted user get reassigned (legacy parity). */
const REASSIGN_TARGETS: ReadonlyArray<[string, string]> = [
  ["requests", "created_by"],
  ["folders", "created_by"],
  ["documents", "uploaded_by"],
  ["request_narratives", "updated_by"],
  ["request_reminders", "sent_by"],
  ["folder_access", "created_by"],
  ["reminders", "created_by"],
  ["activity_log", "created_by"],
];

function toRecord(row: Row): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    passwordHash: row.passwordHash,
    role: row.role,
    subRole: row.subRole as SubRole | null,
    designation: row.designation,
    buyerCompanyName: row.buyerCompanyName,
    parentUserId: row.parentUserId,
    companyId: row.companyId,
    status: row.status,
    dateOfBirth: row.dateOfBirth,
    occupation: row.occupation,
    address: row.address,
    brokerCompany: row.brokerCompany,
  };
}

export class DrizzleUsersRepository implements UsersRepository {
  constructor(private readonly db: Db) {}

  async getById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listAll(): Promise<UserRecord[]> {
    const rows = await this.db.select().from(users).orderBy(users.createdAt);
    return rows.map(toRecord);
  }

  async create(input: UserCreateInput): Promise<UserRecord> {
    const rows = await this.db
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash: input.passwordHash,
        role: input.role,
        subRole: input.subRole,
        designation: input.designation,
        buyerCompanyName: input.buyerCompanyName,
        parentUserId: input.parentUserId,
        companyId: input.companyId,
        status: input.status,
      })
      .returning();
    return toRecord(rows[0]!);
  }

  async update(id: string, patch: UserUpdatePatch): Promise<UserRecord | null> {
    const rows = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async assignedCompaniesFor(userIds: readonly string[]): Promise<Map<string, AssignedCompany[]>> {
    const map = new Map<string, AssignedCompany[]>();
    for (const id of userIds) map.set(id, []);
    if (userIds.length === 0) return map;

    // Memberships via user_companies.
    const rows = await this.db
      .select({
        userId: userCompanies.userId,
        id: companies.id,
        name: companies.name,
        contactEmail: companies.contactEmail,
      })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .where(inArray(userCompanies.userId, [...userIds]));

    const seen = new Set<string>();
    for (const r of rows) {
      const list = map.get(r.userId)!;
      list.push({ id: r.id, name: r.name, contact_email: r.contactEmail });
      seen.add(`${r.userId}:${r.id}`);
    }

    // Primary company_id that isn't already a membership row.
    const primaries = await this.db
      .select({ userId: users.id, id: companies.id, name: companies.name, contactEmail: companies.contactEmail })
      .from(users)
      .innerJoin(companies, eq(companies.id, users.companyId))
      .where(inArray(users.id, [...userIds]));
    for (const r of primaries) {
      if (seen.has(`${r.userId}:${r.id}`)) continue;
      map.get(r.userId)!.unshift({ id: r.id, name: r.name, contact_email: r.contactEmail });
    }
    return map;
  }

  async addCompanies(userId: string, companyIds: readonly string[]): Promise<void> {
    if (companyIds.length === 0) return;
    await this.db
      .insert(userCompanies)
      .values(companyIds.map((companyId) => ({ userId, companyId })))
      .onConflictDoNothing();
  }

  async removeCompanies(userId: string, companyIds: readonly string[]): Promise<void> {
    if (companyIds.length === 0) return;
    await this.db
      .delete(userCompanies)
      .where(and(eq(userCompanies.userId, userId), inArray(userCompanies.companyId, [...companyIds])));
  }

  async inviteBrokerToTeam(ownerId: string, invitedId: string): Promise<void> {
    await this.db
      .insert(brokerTeamInvites)
      .values({ teamOwnerId: ownerId, invitedBrokerId: invitedId })
      .onConflictDoNothing();
  }

  async removeBrokerFromTeam(ownerId: string, invitedId: string): Promise<void> {
    await this.db
      .delete(brokerTeamInvites)
      .where(
        and(eq(brokerTeamInvites.teamOwnerId, ownerId), eq(brokerTeamInvites.invitedBrokerId, invitedId)),
      );
  }

  async invitedBrokerIds(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: brokerTeamInvites.invitedBrokerId })
      .from(brokerTeamInvites)
      .where(eq(brokerTeamInvites.teamOwnerId, ownerId));
    return rows.map((r) => r.id);
  }

  async replacementCandidates(
    excludeId: string,
    companyIds: readonly string[],
  ): Promise<ReplacementCandidate[]> {
    const brokerAdmin = inArray(users.role, ["broker", "admin"]);
    if (companyIds.length > 0) {
      const scoped = await this.db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(ne(users.id, excludeId), brokerAdmin, inArray(users.companyId, [...companyIds])))
        .orderBy(users.createdAt);
      if (scoped.length > 0) return scoped as ReplacementCandidate[];
    }
    const global = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(ne(users.id, excludeId), brokerAdmin))
      .orderBy(users.createdAt);
    return global as ReplacementCandidate[];
  }

  async reassignAndDelete(userId: string, replacementId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [table, column] of REASSIGN_TARGETS) {
        await tx.execute(
          sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${replacementId} WHERE ${sql.identifier(column)} = ${userId}`,
        );
      }
      await tx.delete(userCompanies).where(eq(userCompanies.userId, userId));
      await tx.execute(
        sql`DELETE FROM broker_team_invites WHERE team_owner_id = ${userId} OR invited_broker_id = ${userId}`,
      );
      await tx.delete(users).where(eq(users.id, userId));
    });
  }
}
