import { randomUUID } from "node:crypto";
import type {
  GroupCreateInput,
  GroupMemberRecord,
  GroupRecord,
  GroupsRepository,
  GroupUpdatePatch,
} from "./ports.js";

/**
 * In-memory groups repository for service tests.
 *
 * Ordering is part of the contract the SPA relies on (newest first), so this
 * sorts rather than returning insertion order — otherwise a service test would
 * pass here and the ordering bug would only appear against Postgres.
 */
export class InMemoryGroupsRepository implements GroupsRepository {
  private readonly groups = new Map<string, GroupRecord>();
  private readonly members = new Map<string, GroupMemberRecord>();

  /** Seed a group directly, for tests that need one to already exist. */
  seed(group: GroupRecord): GroupRecord {
    this.groups.set(group.id, group);
    return group;
  }

  private static memberKey(groupId: string, userId: string): string {
    return `${groupId}:${userId}`;
  }

  listByCompany(companyId: string): Promise<GroupRecord[]> {
    const rows = [...this.groups.values()]
      .filter((g) => g.companyId === companyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve(rows);
  }

  getById(id: string): Promise<GroupRecord | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  create(input: GroupCreateInput): Promise<GroupRecord> {
    const record: GroupRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      description: input.description,
      createdAt: new Date().toISOString(),
    };
    this.groups.set(record.id, record);
    return Promise.resolve(record);
  }

  update(id: string, patch: GroupUpdatePatch): Promise<GroupRecord | null> {
    const existing = this.groups.get(id);
    if (!existing) return Promise.resolve(null);

    const updated: GroupRecord = { ...existing, name: patch.name, description: patch.description };
    this.groups.set(id, updated);
    return Promise.resolve(updated);
  }

  remove(id: string): Promise<boolean> {
    // Mirrors the database's ON DELETE CASCADE, so an orphaned membership cannot
    // survive here and make a test pass that Postgres would fail.
    for (const [key, member] of this.members) {
      if (member.groupId === id) this.members.delete(key);
    }
    return Promise.resolve(this.groups.delete(id));
  }

  memberIdsFor(groupIds: readonly string[]): Promise<Map<string, string[]>> {
    const wanted = new Set(groupIds);
    const out = new Map<string, string[]>();
    for (const member of this.members.values()) {
      if (!wanted.has(member.groupId)) continue;
      const list = out.get(member.groupId) ?? [];
      list.push(member.userId);
      out.set(member.groupId, list);
    }
    return Promise.resolve(out);
  }

  listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    const rows = [...this.members.values()]
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve(rows);
  }

  addMember(groupId: string, userId: string): Promise<GroupMemberRecord> {
    const key = InMemoryGroupsRepository.memberKey(groupId, userId);
    const existing = this.members.get(key);
    if (existing) return Promise.resolve(existing);

    const record: GroupMemberRecord = { groupId, userId, createdAt: new Date().toISOString() };
    this.members.set(key, record);
    return Promise.resolve(record);
  }

  removeMember(groupId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.members.delete(InMemoryGroupsRepository.memberKey(groupId, userId)));
  }
}
