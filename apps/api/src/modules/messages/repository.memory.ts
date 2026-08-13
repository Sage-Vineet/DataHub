import { randomUUID } from "node:crypto";
import type {
  CreateGroupInput,
  GroupMessageRecord,
  GroupRecord,
  MessageRecord,
  MessagesRepository,
} from "./ports.js";

export class InMemoryMessagesRepository implements MessagesRepository {
  private readonly company: MessageRecord[] = [];
  private readonly direct: MessageRecord[] = [];
  private readonly groups = new Map<string, GroupRecord>();
  private readonly members = new Set<string>(); // `${groupId}:${userId}`
  private readonly groupMsgs: GroupMessageRecord[] = [];
  private readonly reads = new Map<string, number>(); // `${groupId}:${userId}` → epoch ms
  private clock = 1;

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
