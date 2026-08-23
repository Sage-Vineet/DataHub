import { and, asc, desc, eq, gt, inArray, ne, or } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { GroupType } from "@datahub/contracts";
import type {
  CompanyRecord,
  CreateGroupInput,
  DirectContactRecord,
  GroupMessageRecord,
  GroupRecord,
  MessageRecord,
  MessagesRepository,
} from "./ports.js";
import type { GroupingMember } from "./auto-groups.js";

const {
  companies,
  companyMessages,
  directMessages,
  messageGroups,
  messageGroupMembers,
  groupMessages,
  groupMessageReads,
  userCompanies,
  users,
} = schema;

type CmRow = typeof companyMessages.$inferSelect;
type DmRow = typeof directMessages.$inferSelect;
type GrRow = typeof messageGroups.$inferSelect;
type GmRow = typeof groupMessages.$inferSelect;

function toCompanyMsg(r: CmRow): MessageRecord {
  return { id: r.id, companyId: r.companyId, senderId: r.senderId, recipientId: null, body: r.body, createdAt: r.createdAt.toISOString() };
}
function toDirectMsg(r: DmRow): MessageRecord {
  return { id: r.id, companyId: r.companyId, senderId: r.senderId, recipientId: r.recipientId, body: r.body, createdAt: r.createdAt.toISOString() };
}
function toGroup(r: GrRow): GroupRecord {
  return { id: r.id, companyId: r.companyId, name: r.name, groupType: r.groupType as GroupType, buyerUserId: r.buyerUserId, autoCreated: r.autoCreated };
}
function toGroupMsg(r: GmRow): GroupMessageRecord {
  return { id: r.id, groupId: r.groupId, senderId: r.senderId, body: r.body, createdAt: r.createdAt.toISOString() };
}

export class DrizzleMessagesRepository implements MessagesRepository {
  constructor(private readonly db: Db) {}

  async listCompany(companyId: string): Promise<MessageRecord[]> {
    const rows = await this.db.select().from(companyMessages).where(eq(companyMessages.companyId, companyId)).orderBy(asc(companyMessages.createdAt));
    return rows.map(toCompanyMsg);
  }
  async sendCompany(companyId: string, senderId: string, body: string): Promise<MessageRecord> {
    const rows = await this.db.insert(companyMessages).values({ companyId, senderId, body }).returning();
    return toCompanyMsg(rows[0]!);
  }

  async getCompany(companyId: string): Promise<CompanyRecord | null> {
    const rows = await this.db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * `users.company_id` union `user_companies` — the same association
   * `canAccessCompany` reads, so who may be messaged cannot drift from who may
   * see the deal.
   */
  async listCompanyMembers(companyId: string): Promise<DirectContactRecord[]> {
    const direct = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.companyId, companyId));

    const joinedIds = await this.db
      .select({ userId: userCompanies.userId })
      .from(userCompanies)
      .where(eq(userCompanies.companyId, companyId));

    const extra = joinedIds
      .map((j) => j.userId)
      .filter((id) => !direct.some((d) => d.id === id));

    const joined =
      extra.length > 0
        ? await this.db
            .select({ id: users.id, name: users.name, email: users.email, role: users.role })
            .from(users)
            .where(inArray(users.id, extra))
        : [];

    return [...direct, ...joined];
  }

  /**
   * One pass over the deal's direct messages, newest first, keeping the first
   * row seen per counterparty. Cheaper than a query per contact, and the caller
   * only needs the latest.
   */
  async latestDirectByContact(
    companyId: string,
    userId: string,
    contactIds: string[],
  ): Promise<Map<string, MessageRecord>> {
    const out = new Map<string, MessageRecord>();
    if (contactIds.length === 0) return out;

    const rows = await this.db
      .select()
      .from(directMessages)
      .where(
        and(
          eq(directMessages.companyId, companyId),
          or(
            and(eq(directMessages.senderId, userId), inArray(directMessages.recipientId, contactIds)),
            and(inArray(directMessages.senderId, contactIds), eq(directMessages.recipientId, userId)),
          ),
        ),
      )
      .orderBy(desc(directMessages.createdAt));

    for (const r of rows) {
      const other = r.senderId === userId ? r.recipientId : r.senderId;
      if (other && !out.has(other)) out.set(other, toDirectMsg(r));
    }
    return out;
  }

  async listDirect(companyId: string, a: string, b: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(directMessages)
      .where(
        and(
          eq(directMessages.companyId, companyId),
          or(
            and(eq(directMessages.senderId, a), eq(directMessages.recipientId, b)),
            and(eq(directMessages.senderId, b), eq(directMessages.recipientId, a)),
          ),
        ),
      )
      .orderBy(asc(directMessages.createdAt));
    return rows.map(toDirectMsg);
  }
  async sendDirect(companyId: string, senderId: string, recipientId: string, body: string): Promise<MessageRecord> {
    const rows = await this.db.insert(directMessages).values({ companyId, senderId, recipientId, body }).returning();
    return toDirectMsg(rows[0]!);
  }

  async listGroupsByCompany(companyId: string): Promise<GroupRecord[]> {
    const rows = await this.db.select().from(messageGroups).where(eq(messageGroups.companyId, companyId)).orderBy(asc(messageGroups.createdAt));
    return rows.map(toGroup);
  }
  async listGroupsForUser(userId: string): Promise<GroupRecord[]> {
    const rows = await this.db
      .select()
      .from(messageGroups)
      .innerJoin(messageGroupMembers, eq(messageGroupMembers.groupId, messageGroups.id))
      .where(eq(messageGroupMembers.userId, userId));
    return rows.map((r) => toGroup(r.message_groups));
  }
  async listMembersForGrouping(companyId: string): Promise<GroupingMember[]> {
    const rows = await this.db
      .select({ user: users })
      .from(userCompanies)
      .innerJoin(users, eq(users.id, userCompanies.userId))
      .where(eq(userCompanies.companyId, companyId));
    return rows.map((r) => ({
      id: r.user.id,
      role: r.user.role,
      subRole: r.user.subRole,
      parentUserId: r.user.parentUserId,
      name: r.user.name,
      brokerCompany: r.user.brokerCompany,
      buyerCompanyName: r.user.buyerCompanyName,
    }));
  }
  async renameGroup(groupId: string, name: string): Promise<void> {
    await this.db.update(messageGroups).set({ name }).where(eq(messageGroups.id, groupId));
  }
  async createGroup(input: CreateGroupInput): Promise<GroupRecord> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(messageGroups)
        .values({ companyId: input.companyId, name: input.name, groupType: input.groupType, buyerUserId: input.buyerUserId, autoCreated: input.autoCreated })
        .returning();
      const group = toGroup(rows[0]!);
      if (input.memberIds.length > 0) {
        await tx.insert(messageGroupMembers).values(input.memberIds.map((userId) => ({ groupId: group.id, userId }))).onConflictDoNothing();
      }
      return group;
    });
  }
  async getGroup(id: string): Promise<GroupRecord | null> {
    const rows = await this.db.select().from(messageGroups).where(eq(messageGroups.id, id)).limit(1);
    return rows[0] ? toGroup(rows[0]) : null;
  }
  async addMember(groupId: string, userId: string): Promise<void> {
    await this.db.insert(messageGroupMembers).values({ groupId, userId }).onConflictDoNothing();
  }
  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.db.delete(messageGroupMembers).where(and(eq(messageGroupMembers.groupId, groupId), eq(messageGroupMembers.userId, userId)));
  }
  async listMembers(groupId: string): Promise<string[]> {
    const rows = await this.db.select({ userId: messageGroupMembers.userId }).from(messageGroupMembers).where(eq(messageGroupMembers.groupId, groupId));
    return rows.map((r) => r.userId);
  }
  async isMember(groupId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ userId: messageGroupMembers.userId })
      .from(messageGroupMembers)
      .where(and(eq(messageGroupMembers.groupId, groupId), eq(messageGroupMembers.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }

  async listGroupMessages(groupId: string): Promise<GroupMessageRecord[]> {
    const rows = await this.db.select().from(groupMessages).where(eq(groupMessages.groupId, groupId)).orderBy(asc(groupMessages.createdAt));
    return rows.map(toGroupMsg);
  }
  async sendGroupMessage(groupId: string, senderId: string, body: string): Promise<GroupMessageRecord> {
    const rows = await this.db.insert(groupMessages).values({ groupId, senderId, body }).returning();
    return toGroupMsg(rows[0]!);
  }
  async markRead(groupId: string, userId: string): Promise<void> {
    await this.db
      .insert(groupMessageReads)
      .values({ groupId, userId })
      .onConflictDoUpdate({ target: [groupMessageReads.groupId, groupMessageReads.userId], set: { lastReadAt: new Date() } });
  }
  async unreadCount(groupId: string, userId: string): Promise<number> {
    const watermarkRows = await this.db
      .select({ lastReadAt: groupMessageReads.lastReadAt })
      .from(groupMessageReads)
      .where(and(eq(groupMessageReads.groupId, groupId), eq(groupMessageReads.userId, userId)))
      .limit(1);
    const watermark = watermarkRows[0]?.lastReadAt ?? new Date(0);
    const rows = await this.db
      .select({ id: groupMessages.id })
      .from(groupMessages)
      .where(and(eq(groupMessages.groupId, groupId), ne(groupMessages.senderId, userId), gt(groupMessages.createdAt, watermark)));
    return rows.length;
  }
}
