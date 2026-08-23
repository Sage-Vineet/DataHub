import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type {
  GroupCreateInput,
  GroupMemberRecord,
  GroupRecord,
  GroupsRepository,
  GroupUpdatePatch,
} from "./ports.js";

const { buyerGroups, buyerGroupMembers } = schema;
type GroupRow = typeof buyerGroups.$inferSelect;
type MemberRow = typeof buyerGroupMembers.$inferSelect;

function toRecord(r: GroupRow): GroupRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
  };
}

function toMemberRecord(r: MemberRow): GroupMemberRecord {
  return { groupId: r.groupId, userId: r.userId, createdAt: r.createdAt.toISOString() };
}

/** Groups over Postgres. The only place in this module that speaks SQL. */
export class DrizzleGroupsRepository implements GroupsRepository {
  constructor(private readonly db: Db) {}

  async listByCompany(companyId: string): Promise<GroupRecord[]> {
    const rows = await this.db
      .select()
      .from(buyerGroups)
      .where(eq(buyerGroups.companyId, companyId))
      .orderBy(desc(buyerGroups.createdAt));
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<GroupRecord | null> {
    const rows = await this.db.select().from(buyerGroups).where(eq(buyerGroups.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(input: GroupCreateInput): Promise<GroupRecord> {
    const rows = await this.db
      .insert(buyerGroups)
      .values({ companyId: input.companyId, name: input.name, description: input.description })
      .returning();
    return toRecord(rows[0]!);
  }

  async update(id: string, patch: GroupUpdatePatch): Promise<GroupRecord | null> {
    const rows = await this.db
      .update(buyerGroups)
      .set({ name: patch.name, description: patch.description })
      .where(eq(buyerGroups.id, id))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    // Memberships go with it via ON DELETE CASCADE on the foreign key.
    const rows = await this.db
      .delete(buyerGroups)
      .where(eq(buyerGroups.id, id))
      .returning({ id: buyerGroups.id });
    return rows.length > 0;
  }

  async memberIdsFor(groupIds: readonly string[]): Promise<Map<string, string[]>> {
    // `inArray` with an empty list is invalid SQL, and the caller asking about no
    // groups has an obvious answer.
    if (groupIds.length === 0) return new Map();

    const rows = await this.db
      .select({ groupId: buyerGroupMembers.groupId, userId: buyerGroupMembers.userId })
      .from(buyerGroupMembers)
      .where(inArray(buyerGroupMembers.groupId, [...groupIds]));

    const out = new Map<string, string[]>();
    for (const row of rows) {
      const list = out.get(row.groupId) ?? [];
      list.push(row.userId);
      out.set(row.groupId, list);
    }
    return out;
  }

  async listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(buyerGroupMembers)
      .where(eq(buyerGroupMembers.groupId, groupId))
      .orderBy(desc(buyerGroupMembers.createdAt));
    return rows.map(toMemberRecord);
  }

  async addMember(groupId: string, userId: string): Promise<GroupMemberRecord> {
    // (group_id, user_id) is the primary key, so a repeat add is a no-op rather
    // than a 500 — legacy returned the insert error to the caller instead.
    const inserted = await this.db
      .insert(buyerGroupMembers)
      .values({ groupId, userId })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return toMemberRecord(inserted[0]);

    const existing = await this.db
      .select()
      .from(buyerGroupMembers)
      .where(and(eq(buyerGroupMembers.groupId, groupId), eq(buyerGroupMembers.userId, userId)))
      .limit(1);
    return toMemberRecord(existing[0]!);
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(buyerGroupMembers)
      .where(and(eq(buyerGroupMembers.groupId, groupId), eq(buyerGroupMembers.userId, userId)))
      .returning({ userId: buyerGroupMembers.userId });
    return rows.length > 0;
  }
}
