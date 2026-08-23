/**
 * Buyer groups — a company's named sets of buyer users.
 *
 * Not to be confused with `message_groups`, which the `messages` module owns.
 * Those are conversation topics; these are membership sets the SPA uses to work
 * out which folders a signed-in buyer can see (`FileExplorer`, `PortalDashboard`).
 */

/** A group as the module works with it (camelCase; `createdAt` is ISO). */
export interface GroupRecord {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

/** A membership row. `createdAt` is ISO. */
export interface GroupMemberRecord {
  groupId: string;
  userId: string;
  createdAt: string;
}

/** Fields written on create (already validated). */
export interface GroupCreateInput {
  companyId: string;
  name: string;
  description: string | null;
}

/**
 * The name/description patch for update.
 *
 * There is deliberately no `updatedAt`. Legacy's handler set one, but
 * `buyer_groups` has no such column and never has — so that write has always
 * failed against this database. Nothing reads it, so it is not reinstated.
 */
export interface GroupUpdatePatch {
  name: string;
  description: string | null;
}

/**
 * Data access for groups. Two adapters — Drizzle at runtime, in-memory for tests.
 * Raw SQL lives only in the Drizzle adapter.
 */
export interface GroupsRepository {
  /** Groups for a company, newest first. */
  listByCompany(companyId: string): Promise<GroupRecord[]>;
  /** Used to resolve the owning company before any group-scoped authorization. */
  getById(id: string): Promise<GroupRecord | null>;
  create(input: GroupCreateInput): Promise<GroupRecord>;
  /** Returns the updated row, or null when the group no longer exists. */
  update(id: string, patch: GroupUpdatePatch): Promise<GroupRecord | null>;
  /** True when a row was removed; false when it was already gone. */
  remove(id: string): Promise<boolean>;
  /** Member user ids for several groups at once, so a list is one round trip. */
  memberIdsFor(groupIds: readonly string[]): Promise<Map<string, string[]>>;
  /** Members of one group, newest first. */
  listMembers(groupId: string): Promise<GroupMemberRecord[]>;
  /** Idempotent: re-adding an existing member returns the existing row. */
  addMember(groupId: string, userId: string): Promise<GroupMemberRecord>;
  removeMember(groupId: string, userId: string): Promise<boolean>;
}
