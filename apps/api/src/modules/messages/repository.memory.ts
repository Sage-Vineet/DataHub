import { randomUUID } from "node:crypto";
import type {
  CompanyRecord,
  CreateGroupInput,
  DirectContactRecord,
  GroupMessageRecord,
  GroupRecord,
  MessageRecord,
  MessagesRepository,
  ThreadCompanyRecord,
} from "./ports.js";
import type { GroupingMember } from "./auto-groups.js";

export class InMemoryMessagesRepository implements MessagesRepository {
  private readonly company: MessageRecord[] = [];
  private readonly direct: MessageRecord[] = [];
  private readonly groups = new Map<string, GroupRecord>();
  private readonly members = new Set<string>(); // `${groupId}:${userId}`
  private readonly groupMsgs: GroupMessageRecord[] = [];
  private readonly reads = new Map<string, number>(); // `${groupId}:${userId}` → epoch ms
  private readonly companies = new Map<string, CompanyRecord>();
  private readonly companyMembers = new Map<string, DirectContactRecord[]>();
  /**
   * A monotonic clock, based in the present rather than at the epoch.
   *
   * The base matters: timestamps here are compared against ones seeded by
   * tests, and a message dated 1970 sorts below any realistic `created_at`.
   * That made ordering assertions fail for a reason that has nothing to do with
   * the ordering logic.
   */
  private clock = Date.UTC(2024, 0, 1);

  private now(): string {
    return new Date(this.clock++).toISOString();
  }

  async listCompany(companyId: string) {
    return this.company.filter((m) => m.companyId === companyId);
  }
  async sendCompany(companyId: string, senderId: string, body: string) {
    const m: MessageRecord = { id: randomUUID(), companyId, senderId, recipientId: null, body, createdAt: this.now() };
    this.company.push(m);
    return m;
  }
  /**
   * Test seams. The in-memory repository has no user table, so a test declares
   * the deal's roster explicitly rather than inferring it from messages sent —
   * otherwise a contact never spoken to could not be represented, and that is
   * precisely the case the listing has to get right.
   */
  seedCompany(company: CompanyRecord, members: DirectContactRecord[] = []): void {
    this.companies.set(company.id, company);
    this.companyMembers.set(company.id, members);
  }

  async getCompany(companyId: string): Promise<CompanyRecord | null> {
    return this.companies.get(companyId) ?? null;
  }

  async listCompanyMembers(companyId: string): Promise<DirectContactRecord[]> {
    return [...(this.companyMembers.get(companyId) ?? [])];
  }

  async latestDirectByContact(
    companyId: string,
    userId: string,
    contactIds: string[],
  ): Promise<Map<string, MessageRecord>> {
    const out = new Map<string, MessageRecord>();
    if (contactIds.length === 0) return out;
    const wanted = new Set(contactIds);
    const relevant = this.direct
      .filter(
        (m) =>
          m.companyId === companyId &&
          ((m.senderId === userId && m.recipientId !== null && wanted.has(m.recipientId)) ||
            (m.recipientId === userId && wanted.has(m.senderId))),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const m of relevant) {
      const other = m.senderId === userId ? m.recipientId : m.senderId;
      if (other && !out.has(other)) out.set(other, m);
    }
    return out;
  }

  async listDirect(companyId: string, a: string, b: string) {
    return this.direct.filter(
      (m) => m.companyId === companyId &&
        ((m.senderId === a && m.recipientId === b) || (m.senderId === b && m.recipientId === a)),
    );
  }
  async sendDirect(companyId: string, senderId: string, recipientId: string, body: string) {
    const m: MessageRecord = { id: randomUUID(), companyId, senderId, recipientId, body, createdAt: this.now() };
    this.direct.push(m);
    return m;
  }
  async listGroupsByCompany(companyId: string) {
    return [...this.groups.values()].filter((g) => g.companyId === companyId);
  }
  async listGroupsForUser(userId: string) {
    return [...this.groups.values()].filter((g) => this.members.has(`${g.id}:${userId}`));
  }
  /** Members available for grouping; seeded by tests via `seedGroupingMember`. */
  private readonly grouping = new Map<string, GroupingMember[]>();

  /** Replace the company's roster wholesale — lets a test model someone leaving. */
  setGroupingMembers(companyId: string, members: readonly GroupingMember[]): void {
    this.grouping.set(companyId, members.map((m) => ({ ...m })));
  }

  /** Extra company detail for the thread list; falls back to the seeded record. */
  private readonly companyDetail = new Map<string, ThreadCompanyRecord>();

  seedThreadCompany(company: ThreadCompanyRecord): void {
    this.companyDetail.set(company.id, company);
    this.companies.set(company.id, { id: company.id, name: company.name });
  }

  async listAccessibleCompanies(user: {
    role: string;
    companyIds: readonly string[];
  }): Promise<ThreadCompanyRecord[]> {
    const all = [...this.companies.values()].map(
      (c) =>
        this.companyDetail.get(c.id) ?? {
          id: c.id,
          name: c.name,
          industry: null,
          logo: null,
          contactName: null,
          contactEmail: null,
          status: null,
          createdAt: new Date(0).toISOString(),
        },
    );
    const visible = user.role === "admin" ? all : all.filter((c) => user.companyIds.includes(c.id));
    return visible.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }

  async latestCompanyMessages(companyIds: readonly string[]): Promise<Map<string, MessageRecord>> {
    const wanted = new Set(companyIds);
    const out = new Map<string, MessageRecord>();
    for (const m of [...this.company].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (wanted.has(m.companyId) && !out.has(m.companyId)) out.set(m.companyId, m);
    }
    return out;
  }

  async listMembersForGrouping(companyId: string): Promise<GroupingMember[]> {
    return this.grouping.get(companyId) ?? [];
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    const g = this.groups.get(groupId);
    if (g) this.groups.set(groupId, { ...g, name });
  }

  async createGroup(input: CreateGroupInput): Promise<GroupRecord> {
    const g: GroupRecord = { id: randomUUID(), companyId: input.companyId, name: input.name, groupType: input.groupType, buyerUserId: input.buyerUserId, autoCreated: input.autoCreated };
    this.groups.set(g.id, g);
    for (const u of input.memberIds) this.members.add(`${g.id}:${u}`);
    return g;
  }
  async getGroup(id: string) {
    return this.groups.get(id) ?? null;
  }
  async addMember(groupId: string, userId: string) {
    this.members.add(`${groupId}:${userId}`);
  }
  async removeMember(groupId: string, userId: string) {
    this.members.delete(`${groupId}:${userId}`);
  }
  async listMembers(groupId: string) {
    return [...this.members].filter((k) => k.startsWith(`${groupId}:`)).map((k) => k.split(":")[1]!);
  }
  async isMember(groupId: string, userId: string) {
    return this.members.has(`${groupId}:${userId}`);
  }
  async listGroupMessages(groupId: string) {
    return this.groupMsgs.filter((m) => m.groupId === groupId);
  }
  async sendGroupMessage(groupId: string, senderId: string, body: string) {
    const m: GroupMessageRecord = { id: randomUUID(), groupId, senderId, body, createdAt: this.now() };
    this.groupMsgs.push(m);
    return m;
  }
  async markRead(groupId: string, userId: string) {
    this.reads.set(`${groupId}:${userId}`, this.clock++);
  }
  async unreadCount(groupId: string, userId: string) {
    const watermark = this.reads.get(`${groupId}:${userId}`) ?? 0;
    return this.groupMsgs.filter(
      (m) => m.groupId === groupId && m.senderId !== userId && new Date(m.createdAt).getTime() > watermark,
    ).length;
  }
}
